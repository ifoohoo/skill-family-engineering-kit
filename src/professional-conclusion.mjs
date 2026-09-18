import path from "node:path";
import { findSchemaByObject, validateDocument, ContractsError } from "skill-family-contracts";
import { publishFileExclusive, resolveContained } from "skill-family-harness-node";
import { invalidParamsError } from "./errors.mjs";
import { KIT_TOOL_NAME, KIT_VERSION } from "./skeleton.mjs";
import { resolveTargetRoot } from "./workspace.mjs";

function projection(report, entry) {
  const isVersion = entry === "runCommand.check";
  const records = isVersion ? report.data.version.releaseUnits : report.data.entries;
  const interrupted = report.mechanism === true || report.exitCode === 2;
  const interruptedSubject = report.findings.find((finding) => finding.causeKind)?.[isVersion ? "unit" : "entry"];
  const checked = records
    .filter((record) => !interrupted || record[isVersion ? "id" : "name"] !== interruptedSubject)
    .map((record) => isVersion ? `release-unit:${record.id}` : `entry:${record.name}`);
  const unavailable = ["missing", "parse-failed", "schema-invalid", "incomplete"].includes(report.documentState ?? report.data.version.documentState);
  const limitations = [];
  if (isVersion) {
    limitations.push(...report.classes.filter((item) => !item.selected).map((item) => `check class not selected: ${item.name}`));
  } else {
    limitations.push("release-unit versions and other engineering surfaces were not selected");
  }
  if (unavailable) limitations.unshift(`engineering declaration unavailable: ${report.documentState ?? report.data.version.documentState}`);
  if (interrupted) {
    const mechanismFinding = report.findings.find((finding) => finding.causeKind);
    const subjectKind = isVersion ? "release unit" : "entry";
    const subject = mechanismFinding?.[isVersion ? "unit" : "entry"];
    const pathRef = mechanismFinding?.path;
    if (subject !== undefined || pathRef !== undefined) {
      limitations.unshift(
        `engineering check was interrupted at ${subjectKind} '${subject ?? "unknown"}'`
        + `${pathRef ? ` (path: ${pathRef})` : ""}`
        + `${mechanismFinding?.causeKind ? `; cause: ${mechanismFinding.causeKind}` : ""}`,
      );
    }
    limitations.unshift("engineering check was interrupted by a mechanism failure");
  }

  let completion;
  let code;
  if (interrupted) {
    completion = checked.length > 0 ? "partial" : "not-performed";
    code = "ENGINEERING_CHECK_INCOMPLETE";
  } else if (unavailable) {
    completion = "not-performed";
    code = "ENGINEERING_CHECK_UNAVAILABLE";
  } else {
    completion = "complete";
    code = report.findings.length === 0 ? "ENGINEERING_CLEAR" : "ENGINEERING_FINDINGS";
  }
  if (completion === "complete" && checked.length === 0) {
    checked.push(isVersion ? "declared version branch" : "declared entries branch");
  }
  const summary = code === "ENGINEERING_CLEAR"
    ? "The selected declared engineering check completed without findings."
    : code === "ENGINEERING_FINDINGS"
      ? "The selected declared engineering check completed with findings."
      : code === "ENGINEERING_CHECK_INCOMPLETE"
        ? "The selected declared engineering check did not complete because its mechanism was interrupted."
        : "The selected declared engineering check could not start from a valid declaration.";

  return {
    schemaVersion: 1,
    kind: "skill-family.professional-conclusion",
    provider: { id: KIT_TOOL_NAME, version: KIT_VERSION, entry },
    subject: { ref: report.target.root },
    scope: { checked, limitations },
    outcome: { completion, code, summary },
    details: {
      selected: isVersion ? "version" : "entries",
      completed: isVersion
        ? report.classes.find((item) => item.name === "version")?.completed === true
        : report.exitCode !== 2 && !unavailable,
      findings: report.findings,
      report,
    },
  };
}

export async function publishProfessionalConclusion({ conclusionOutput, report, entry }) {
  if (!conclusionOutput || typeof conclusionOutput !== "object" || Array.isArray(conclusionOutput)) {
    throw invalidParamsError("conclusionOutput must contain an explicit root and relative path");
  }
  const { root, path: relPath } = conclusionOutput;
  if (typeof root !== "string" || root.length === 0 || typeof relPath !== "string" || relPath.length === 0) {
    throw invalidParamsError("conclusionOutput.root and conclusionOutput.path are both required");
  }
  const outputRoot = await resolveTargetRoot(root);
  await resolveContained(outputRoot, relPath);
  const conclusion = projection(report, entry);
  const registration = findSchemaByObject("professional-conclusion");
  const validation = validateDocument(conclusion, {
    schemaId: registration.$id,
    dialect: registration.dialect,
    policy: "strict",
  });
  if (!validation.valid) {
    throw new ContractsError("SFC1001", "generated professional conclusion violates its public contract", {
      errors: validation.errors,
    });
  }
  const receipt = await publishFileExclusive(outputRoot, relPath, `${JSON.stringify(validation.data, null, 2)}\n`);
  return path.resolve(receipt.path);
}
