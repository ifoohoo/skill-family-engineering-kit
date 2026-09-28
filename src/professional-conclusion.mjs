import path from "node:path";
import { findSchemaByObject, validateDocument, ContractsError } from "skill-family-contracts";
import { publishFileExclusive, readFileStrict, resolveContained } from "skill-family-harness-node";
import { invalidParamsError } from "./errors.mjs";
import { KIT_TOOL_NAME, KIT_VERSION } from "./skeleton.mjs";
import { resolveTargetRoot } from "./workspace.mjs";

const PROFESSIONAL_CONCLUSION_KIND = "skill-family.professional-conclusion";
const FOUNDATION_STATIC_ENTRY = "foundation-engineering-check";
const REVIEW_STATUSES = Object.freeze(["pass", "findings", "insufficient", "not_applicable"]);
const CLEAR_CODES = Object.freeze(["FOUNDATION_STATIC_CLEAR", "ENGINEERING_CLEAR"]);
const FINDINGS_CODES = Object.freeze(["FOUNDATION_STATIC_FINDINGS", "ENGINEERING_FINDINGS"]);
const INCOMPLETE_CODES = Object.freeze(["FOUNDATION_STATIC_INCOMPLETE", "ENGINEERING_CHECK_INCOMPLETE"]);
const UNAVAILABLE_CODES = Object.freeze(["ENGINEERING_CHECK_UNAVAILABLE"]);
const READ_UNAVAILABLE_KINDS = Object.freeze([
  "missing-resource",
  "read-failed",
  "invalid-root",
  "target-not-directory",
  "unsafe-state-entry",
  "path-traversal",
  "symlink-escape",
  "realpath-escape",
  "absolute-path",
  "invalid-path",
  "windows-drive-path",
  "windows-path",
  "unc-path",
]);
const FOUNDATION_STATIC_SUMMARIES = Object.freeze({
  FOUNDATION_STATIC_CLEAR: "The selected Foundation static professional review completed without findings.",
  FOUNDATION_STATIC_FINDINGS: "The selected Foundation static professional review completed with findings.",
  FOUNDATION_STATIC_INCOMPLETE: "The selected Foundation static professional review did not cover every applicable item.",
  ALL_NOT_APPLICABLE: "The selected Foundation static professional review listed only not-applicable items and did not execute an applicable check.",
});

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

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function nonEmptyStringArray(value) {
  return Array.isArray(value) && value.every((item) => nonEmptyString(item));
}

function proofResult({ status, reason, provider = null, conclusion = null }) {
  return { status, reason, provider, conclusion };
}

function recognizableProvider(value) {
  if (!isPlainObject(value)) return null;
  const provider = {};
  if (nonEmptyString(value.id)) provider.id = value.id;
  if (nonEmptyString(value.version)) provider.version = value.version;
  if (nonEmptyString(value.entry)) provider.entry = value.entry;
  return Object.keys(provider).length > 0 ? provider : null;
}

function isReadUnavailable(error) {
  return READ_UNAVAILABLE_KINDS.includes(error?.details?.kind);
}

function validateGeneratedConclusion(conclusion) {
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
  return validation.data;
}

async function writeConclusion(conclusion, conclusionOutput) {
  if (!conclusionOutput || typeof conclusionOutput !== "object" || Array.isArray(conclusionOutput)) {
    throw invalidParamsError("conclusionOutput must contain an explicit root and relative path");
  }
  const { root, path: relPath } = conclusionOutput;
  if (typeof root !== "string" || root.length === 0 || typeof relPath !== "string" || relPath.length === 0) {
    throw invalidParamsError("conclusionOutput.root and conclusionOutput.path are both required");
  }
  const outputRoot = await resolveTargetRoot(root);
  await resolveContained(outputRoot, relPath);
  const data = validateGeneratedConclusion(conclusion);
  const receipt = await publishFileExclusive(outputRoot, relPath, `${JSON.stringify(data, null, 2)}\n`);
  return path.resolve(receipt.path);
}

export async function publishProfessionalConclusion({ conclusionOutput, report, entry }) {
  return writeConclusion(projection(report, entry), conclusionOutput);
}

function assertReviewInput(review) {
  if (!isPlainObject(review)) {
    throw invalidParamsError("review-input must be a JSON object");
  }
  if (!isPlainObject(review.subject) || !nonEmptyString(review.subject.ref)) {
    throw invalidParamsError("review-input.subject.ref is required");
  }
  if (review.subject.revision !== undefined && !nonEmptyString(review.subject.revision)) {
    throw invalidParamsError("review-input.subject.revision must be a non-empty string when present");
  }
  if (!Array.isArray(review.checks) || review.checks.length === 0) {
    throw invalidParamsError("review-input.checks must be a non-empty array");
  }
  const seen = new Set();
  for (const [index, check] of review.checks.entries()) {
    if (!isPlainObject(check)) {
      throw invalidParamsError(`review-input.checks[${index}] must be an object`);
    }
    if (!nonEmptyString(check.id)) {
      throw invalidParamsError(`review-input.checks[${index}].id is required`);
    }
    if (seen.has(check.id)) {
      throw invalidParamsError(`review-input.checks contains a duplicate id: ${check.id}`);
    }
    seen.add(check.id);
    if (!REVIEW_STATUSES.includes(check.status)) {
      throw invalidParamsError(`review-input.checks[${index}].status must be pass, findings, insufficient, or not_applicable`);
    }
    if (!nonEmptyStringArray(check.sourceRefs) || check.sourceRefs.length === 0) {
      throw invalidParamsError(`review-input.checks[${index}].sourceRefs must be a non-empty string array`);
    }
    if (!nonEmptyString(check.reason)) {
      throw invalidParamsError(`review-input.checks[${index}].reason is required`);
    }
  }
  if (!Array.isArray(review.limitations) || review.limitations.some((item) => !nonEmptyString(item))) {
    throw invalidParamsError("review-input.limitations must be an array of non-empty strings");
  }
}

function foundationStaticProjection(review) {
  const performed = review.checks.filter((check) => check.status === "pass" || check.status === "findings");
  const findings = review.checks.filter((check) => check.status === "findings");
  const insufficient = review.checks.filter((check) => check.status === "insufficient");
  const notApplicable = review.checks.filter((check) => check.status === "not_applicable");
  const applicable = review.checks.filter((check) => check.status !== "not_applicable");
  const checked = performed.map((check) => check.id);
  const limitations = [
    ...review.limitations,
    ...insufficient.map((check) => `insufficient: ${check.id}: ${check.reason}`),
    ...notApplicable.map((check) => `not applicable: ${check.id}: ${check.reason}`),
  ];

  let completion;
  let code;
  let summary;
  if (findings.length > 0) {
    code = "FOUNDATION_STATIC_FINDINGS";
    completion = insufficient.length > 0 ? (performed.length > 0 ? "partial" : "not-performed") : "complete";
    summary = FOUNDATION_STATIC_SUMMARIES.FOUNDATION_STATIC_FINDINGS;
  } else if (insufficient.length > 0 || applicable.length === 0) {
    code = "FOUNDATION_STATIC_INCOMPLETE";
    completion = performed.length > 0 ? "partial" : "not-performed";
    summary = applicable.length === 0
      ? FOUNDATION_STATIC_SUMMARIES.ALL_NOT_APPLICABLE
      : FOUNDATION_STATIC_SUMMARIES.FOUNDATION_STATIC_INCOMPLETE;
  } else {
    code = "FOUNDATION_STATIC_CLEAR";
    completion = "complete";
    summary = FOUNDATION_STATIC_SUMMARIES.FOUNDATION_STATIC_CLEAR;
  }

  const subject = { ref: review.subject.ref };
  if (review.subject.revision !== undefined) subject.revision = review.subject.revision;
  return {
    schemaVersion: 1,
    kind: PROFESSIONAL_CONCLUSION_KIND,
    provider: { id: KIT_TOOL_NAME, version: KIT_VERSION, entry: FOUNDATION_STATIC_ENTRY },
    subject,
    scope: { checked, limitations },
    outcome: { completion, code, summary },
    details: { review },
  };
}

async function readProofDocument(proofRoot, proofPath) {
  const root = await resolveTargetRoot(proofRoot);
  const receipt = await readFileStrict(root, proofPath, { encoding: "utf8" });
  try {
    return { ok: true, document: JSON.parse(receipt.content) };
  } catch {
    return { ok: false };
  }
}

function interpretFoundationProof(document) {
  const provider = recognizableProvider(document?.provider);
  if (!isPlainObject(document)) {
    return proofResult({
      status: "unavailable",
      reason: "proof is not a JSON object",
    });
  }
  const registration = findSchemaByObject("professional-conclusion");
  const validation = validateDocument(document, {
    schemaId: registration.$id,
    dialect: registration.dialect,
    policy: "strict",
  });
  if (!validation.valid) {
    return proofResult({
      status: "unavailable",
      reason: "proof failed the public professional-conclusion contract",
      provider,
    });
  }
  const conclusion = validation.data;
  const recognized = recognizableProvider(conclusion.provider);
  if (conclusion.provider.id !== KIT_TOOL_NAME) {
    return proofResult({
      status: "unavailable",
      reason: `proof provider '${conclusion.provider.id}' is not this Foundation family`,
      provider: recognized,
      conclusion,
    });
  }
  const code = conclusion.outcome.code;
  if (CLEAR_CODES.includes(code)) {
    if (conclusion.outcome.completion === "complete") {
      const local = code === "ENGINEERING_CLEAR";
      return proofResult({
        status: "pass",
        reason: local
          ? "recorded declared engineering check completed without findings; this is not a full Foundation static review"
          : "recorded Foundation static professional review completed without findings",
        provider: recognized,
        conclusion,
      });
    }
    return proofResult({
      status: "not_pass",
      reason: `CLEAR-class code '${code}' is recorded without completion=complete`,
      provider: recognized,
      conclusion,
    });
  }
  if (FINDINGS_CODES.includes(code) || INCOMPLETE_CODES.includes(code) || UNAVAILABLE_CODES.includes(code)) {
    return proofResult({
      status: "not_pass",
      reason: `recorded Foundation domain result is ${code}`,
      provider: recognized,
      conclusion,
    });
  }
  return proofResult({
    status: "unavailable",
    reason: `unknown Foundation domain code '${code}'`,
    provider: recognized,
    conclusion,
  });
}

export async function readProfessionalProof({ proofRoot, proof }) {
  if (!nonEmptyString(proofRoot) || !nonEmptyString(proof)) {
    throw invalidParamsError("proofRoot and proof are both required");
  }
  try {
    const parsed = await readProofDocument(proofRoot, proof);
    if (!parsed.ok) {
      return proofResult({
        status: "unavailable",
        reason: "proof is not valid JSON",
      });
    }
    return interpretFoundationProof(parsed.document);
  } catch (error) {
    if (isReadUnavailable(error)) {
      return proofResult({
        status: "unavailable",
        reason: error.message,
      });
    }
    throw error;
  }
}

export async function createProfessionalProof({ reviewRoot, reviewInput, conclusionOutput }) {
  if (!nonEmptyString(reviewRoot) || !nonEmptyString(reviewInput)) {
    throw invalidParamsError("reviewRoot and reviewInput are both required");
  }
  const root = await resolveTargetRoot(reviewRoot);
  const receipt = await readFileStrict(root, reviewInput, { encoding: "utf8" });
  let review;
  try {
    review = JSON.parse(receipt.content);
  } catch {
    throw invalidParamsError("review-input must name valid JSON contained in --review-root");
  }
  assertReviewInput(review);
  const conclusion = foundationStaticProjection(review);
  const conclusionPath = await writeConclusion(conclusion, conclusionOutput);
  return { conclusionPath, conclusion: validateGeneratedConclusion(conclusion) };
}
