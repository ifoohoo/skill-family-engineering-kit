import {
  readFileContained,
  estimateTokens,
  TOKEN_ESTIMATOR_ID,
  TOKEN_ESTIMATOR_VERSION,
  TOKEN_ESTIMATION_ALGORITHM,
} from "skill-family-harness-node";
import {
  consumeTokenEstimateStrict,
  TOKEN_ESTIMATE_CONSUMPTION,
} from "skill-family-contracts";
import { KIT_ERROR_KINDS } from "./errors.mjs";
import { KIT_TOOL_NAME, KIT_VERSION } from "./skeleton.mjs";
import { readOptionalJson, resolveTargetRoot } from "./workspace.mjs";

/**
 * runEntryContractCheck — the shared entry contract gate (SG-34; audit
 * friction F2, satisfaction carrier of PGM-001(c)).
 *
 * Before this sub-action existed, every project hand-wrote roughly 150 lines
 * of equivalent entry-gate logic and owned its correctness alone. The five
 * frozen checks implement exactly the semantics the audit rules define:
 *
 *   1. SFA-ENTRY-003 — every declared entry exists physically in its
 *      declared form (v1 freezes the single form skill_md: the physicalRef
 *      must be a readable regular file named SKILL.md);
 *   2. SFA-ENTRY-004 — the outward logical name of every entry is the
 *      qualified name `<project>:<name>` and logical names are unique;
 *   3. SFA-ENTRY-005 — entries declared as human entries never appear in
 *      the method-registration boundary (registeredMethods);
 *   4. SFA-ENTRY-007 — entries flagged readOnlyRequired declare the
 *      read_only side-effect class (controlled vocabulary: read_only or
 *      transactional);
 *   5. SFA-CONTEXT-001/002 — every entry's SKILL.md token budget is
 *      measured with the authoritative deterministic estimator and consumed
 *      through the frozen token estimate consumption contract (SG-33):
 *      tokens >= hardLimitTokens is a hard-line finding (SFA-CONTEXT-002),
 *      tokens >= warnLimitTokens a warn-line finding (SFA-CONTEXT-001).
 *      The estimate is never coerced: consumption failure is a mechanism
 *      error (fail closed), and degradation never relaxes the thresholds —
 *      inside the kit the authoritative estimator is a hard dependency, so
 *      no degraded path exists here.
 *
 * The input is one kit-owned declaration document
 * (skill-family.entry-contract.json, kind
 * skill-family.entry-contract-declaration). Absence of the declaration is
 * data, never a finding — whether a project owes an entry contract depends
 * on its entry surface. The gate is diagnosis only: it reads, estimates and
 * reports; it never writes.
 *
 * Report shape: kind skill-family.entry-check-report; exit mapping
 * 0 clean / 1 findings / 2 mechanism (thrown by the caller).
 */

export const ENTRY_CONTRACT_DECLARATION_PATH = "skill-family.entry-contract.json";
export const ENTRY_CONTRACT_DECLARATION_KIND = "skill-family.entry-contract-declaration";
export const ENTRY_FORMS = Object.freeze(["skill_md"]);
export const ENTRY_SIDE_EFFECT_CLASSES = Object.freeze(["read_only", "transactional"]);

const SEMVER_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const LOCAL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function finding(kind, code, message, extra) {
  return { class: "entries", kind, code, message, ...(extra ?? {}) };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Runs the five entry contract checks over one target.
 * Options: { root }.
 * Returns the entry-check report document. Never writes anywhere.
 * Throws only for unusable inputs (an unreadable target root) and for
 * fail-closed token consumption failures (mechanism errors, exit 2).
 */
export async function runEntryContractCheck({ root } = {}) {
  const rootAbs = await resolveTargetRoot(root ?? ".");
  const findings = [];
  const data = {
    declared: false,
    documentState: "missing",
    project: null,
    declaredVersion: null,
    entries: [],
    estimator: {
      source: "foundation-token-estimator",
      id: TOKEN_ESTIMATOR_ID,
      version: TOKEN_ESTIMATOR_VERSION,
      algorithm: TOKEN_ESTIMATION_ALGORITHM,
      consumptionContract: TOKEN_ESTIMATE_CONSUMPTION.kind,
      numericField: TOKEN_ESTIMATE_CONSUMPTION.numericField,
    },
  };

  const loaded = await readOptionalJson(rootAbs, ENTRY_CONTRACT_DECLARATION_PATH);
  if (loaded.reason === "missing") {
    return entryReport(data, findings);
  }
  data.declared = true;
  if (!loaded.ok) {
    data.documentState = "parse-failed";
    findings.push(
      finding(
        KIT_ERROR_KINDS.CONTRACT_PARSE_FAILED,
        "SFC2004",
        `${ENTRY_CONTRACT_DECLARATION_PATH} is not valid JSON`,
        { path: ENTRY_CONTRACT_DECLARATION_PATH, documentState: data.documentState },
      ),
    );
    return entryReport(data, findings);
  }

  const declaration = loaded.value;
  const invalid = (message, extra) =>
    findings.push(
      finding(KIT_ERROR_KINDS.ENTRY_CONTRACT_INVALID, "SFC2004", message, {
        path: ENTRY_CONTRACT_DECLARATION_PATH,
        ...(extra ?? {}),
      }),
    );

  // ---- template shape -----------------------------------------------------
  data.documentState = "ok";
  if (!isPlainObject(declaration)) {
    invalid("the declaration must be a JSON object");
    return entryReport(data, findings);
  }
  if (declaration.schemaVersion !== 1) {
    invalid(`schemaVersion must be exactly 1 (got ${JSON.stringify(declaration.schemaVersion ?? null)})`, {
      field: "schemaVersion",
    });
  }
  if (declaration.kind !== ENTRY_CONTRACT_DECLARATION_KIND) {
    invalid(`kind must be "${ENTRY_CONTRACT_DECLARATION_KIND}" (got ${JSON.stringify(declaration.kind ?? null)})`, {
      field: "kind",
    });
  }
  if (typeof declaration.project !== "string" || !LOCAL_NAME_PATTERN.test(declaration.project)) {
    invalid("project must be a kebab-case project id", { field: "project" });
  } else {
    data.project = declaration.project;
  }
  if (typeof declaration.declaredVersion !== "string" || !SEMVER_PATTERN.test(declaration.declaredVersion)) {
    invalid("declaredVersion must be a semantic version string X.Y.Z", { field: "declaredVersion" });
  } else {
    data.declaredVersion = declaration.declaredVersion;
    const packageDocument = await readOptionalJson(rootAbs, "package.json");
    if (
      packageDocument.ok &&
      typeof packageDocument.value?.version === "string" &&
      packageDocument.value.version !== declaration.declaredVersion
    ) {
      findings.push(
        finding(
          KIT_ERROR_KINDS.ENTRY_CONTRACT_VERSION_DRIFT,
          "SFC2004",
          `entry contract declaration declares version ${declaration.declaredVersion}; the single version source (package.json) is ${packageDocument.value.version}`,
          {
            path: ENTRY_CONTRACT_DECLARATION_PATH,
            declared: declaration.declaredVersion,
            expected: packageDocument.value.version,
          },
        ),
      );
    }
  }

  const entries = Array.isArray(declaration.entries) ? declaration.entries : null;
  if (entries === null) {
    invalid("entries must be an array of entry declarations", { field: "entries" });
    return entryReport(data, findings);
  }
  const registeredMethods = Array.isArray(declaration.registeredMethods)
    ? declaration.registeredMethods.filter((item) => typeof item === "string")
    : [];
  if (!Array.isArray(declaration.registeredMethods)) {
    invalid("registeredMethods must be an array of registered method logical names", {
      field: "registeredMethods",
    });
  }

  const tokenBudget = isPlainObject(declaration.tokenBudget) ? declaration.tokenBudget : null;
  const warnLimitTokens = tokenBudget?.warnLimitTokens;
  const hardLimitTokens = tokenBudget?.hardLimitTokens;
  const budgetUsable =
    Number.isInteger(warnLimitTokens) &&
    warnLimitTokens > 0 &&
    Number.isInteger(hardLimitTokens) &&
    hardLimitTokens > 0;
  if (!budgetUsable) {
    invalid("tokenBudget.warnLimitTokens and tokenBudget.hardLimitTokens must be positive integers", {
      field: "tokenBudget",
    });
  } else if (warnLimitTokens >= hardLimitTokens) {
    invalid("tokenBudget.warnLimitTokens must be strictly below hardLimitTokens", { field: "tokenBudget" });
  }

  // ---- per-entry checks ----------------------------------------------------
  const seenLogicalNames = new Set();
  for (const [index, entry] of entries.entries()) {
    const at = `entries[${index}]`;
    if (!isPlainObject(entry)) {
      invalid(`${at} must be an object`, { field: at });
      continue;
    }
    const name = typeof entry.name === "string" ? entry.name : null;
    if (name === null || !LOCAL_NAME_PATTERN.test(name)) {
      invalid(`${at}.name must be a kebab-case local entry name`, { field: `${at}.name` });
      continue;
    }
    const expectedLogicalName = data.project ? `${data.project}:${name}` : null;

    // Check 2 (SFA-ENTRY-004): qualified logical name consistency + uniqueness.
    if (typeof entry.logicalName !== "string" || entry.logicalName.length === 0) {
      invalid(`${at}.logicalName must be a non-empty string`, { field: `${at}.logicalName` });
    } else {
      if (expectedLogicalName !== null && entry.logicalName !== expectedLogicalName) {
        findings.push(
          finding(
            KIT_ERROR_KINDS.ENTRY_NAME_INCONSISTENT,
            "SFC2004",
            `entry '${name}' logical name is ${entry.logicalName}; the qualified name must be ${expectedLogicalName} (SFA-ENTRY-004)`,
            { entry: name, declared: entry.logicalName, expected: expectedLogicalName },
          ),
        );
      }
      if (seenLogicalNames.has(entry.logicalName)) {
        findings.push(
          finding(
            KIT_ERROR_KINDS.ENTRY_NAME_INCONSISTENT,
            "SFC2004",
            `logical name ${entry.logicalName} is declared more than once (SFA-ENTRY-004)`,
            { entry: name, declared: entry.logicalName },
          ),
        );
      }
      seenLogicalNames.add(entry.logicalName);
    }

    const form = entry.form;
    if (!ENTRY_FORMS.includes(form)) {
      invalid(`${at}.form must be one of: ${ENTRY_FORMS.join(", ")} (got ${JSON.stringify(form ?? null)})`, {
        field: `${at}.form`,
      });
      continue;
    }
    const physicalRef = typeof entry.physicalRef === "string" ? entry.physicalRef : null;
    if (physicalRef === null || physicalRef.length === 0 || physicalRef.startsWith("/") || physicalRef.split("/").includes("..")) {
      invalid(`${at}.physicalRef must be a contained relative path`, { field: `${at}.physicalRef` });
      continue;
    }
    if (!physicalRef.endsWith("/SKILL.md") && physicalRef !== "SKILL.md") {
      invalid(`${at}.physicalRef must name a SKILL.md file for form skill_md`, { field: `${at}.physicalRef` });
      continue;
    }

    // Check 1 (SFA-ENTRY-003): physical presence in the declared form.
    let text = null;
    try {
      text = await readFileContained(rootAbs, physicalRef, { encoding: "utf8" });
    } catch (cause) {
      const kind = cause && cause.details ? cause.details.kind : null;
      if (kind === "missing-resource") {
        findings.push(
          finding(
            KIT_ERROR_KINDS.ENTRY_PHYSICAL_MISSING,
            "SFC2004",
            `entry '${name}' physical SKILL.md is absent: ${physicalRef} (SFA-ENTRY-003)`,
            { entry: name, path: physicalRef },
          ),
        );
      } else {
        // Escaping or unsafe references are target-supplied data: report, never follow.
        findings.push(
          finding(
            KIT_ERROR_KINDS.ENTRY_PHYSICAL_MISSING,
            "SFC2004",
            `entry '${name}' physicalRef is not safely readable inside the target: ${physicalRef} (kind: ${kind ?? "unknown"})`,
            { entry: name, path: physicalRef, causeKind: kind ?? "unknown" },
          ),
        );
      }
      continue;
    }

    // Check 3 (SFA-ENTRY-005): human entries stay outside method registration.
    if (entry.humanEntry === true && entry.logicalName && registeredMethods.includes(entry.logicalName)) {
      findings.push(
        finding(
          KIT_ERROR_KINDS.ENTRY_HUMAN_REGISTERED,
          "SFC2004",
          `human entry '${name}' appears in the method-registration boundary: ${entry.logicalName} (SFA-ENTRY-005)`,
          { entry: name, logicalName: entry.logicalName },
        ),
      );
    }

    // Check 4 (SFA-ENTRY-007): read-only obligation vs declared side-effect class.
    if (!ENTRY_SIDE_EFFECT_CLASSES.includes(entry.sideEffectClass)) {
      invalid(
        `${at}.sideEffectClass must be one of: ${ENTRY_SIDE_EFFECT_CLASSES.join(", ")} (got ${JSON.stringify(entry.sideEffectClass ?? null)})`,
        { field: `${at}.sideEffectClass` },
      );
    } else if (entry.readOnlyRequired === true && entry.sideEffectClass !== "read_only") {
      findings.push(
        finding(
          KIT_ERROR_KINDS.ENTRY_SIDE_EFFECT_VIOLATION,
          "SFC2004",
          `entry '${name}' is obligated read-only but declares side-effect class ${entry.sideEffectClass} (SFA-ENTRY-007)`,
          { entry: name, declared: entry.sideEffectClass, expected: "read_only" },
        ),
      );
    }

    // Check 5 (SFA-CONTEXT-001/002): token budget via the frozen consumption
    // contract. consumeTokenEstimateStrict throws fail-closed on a
    // non-consumable estimate; the throw propagates as a mechanism error.
    let tokens = null;
    if (budgetUsable && warnLimitTokens < hardLimitTokens) {
      const record = estimateTokens(text);
      tokens = consumeTokenEstimateStrict(record);
      if (tokens >= hardLimitTokens) {
        findings.push(
          finding(
            KIT_ERROR_KINDS.ENTRY_TOKEN_BUDGET_EXCEEDED,
            "SFC2004",
            `entry '${name}' SKILL.md reaches the hard token line (${tokens} >= ${hardLimitTokens}, SFA-CONTEXT-002)`,
            { entry: name, path: physicalRef, tokens, limit: hardLimitTokens, rule: "SFA-CONTEXT-002" },
          ),
        );
      } else if (tokens >= warnLimitTokens) {
        findings.push(
          finding(
            KIT_ERROR_KINDS.ENTRY_TOKEN_BUDGET_EXCEEDED,
            "SFC2004",
            `entry '${name}' SKILL.md reaches the warn token line (${tokens} >= ${warnLimitTokens}, SFA-CONTEXT-001)`,
            { entry: name, path: physicalRef, tokens, limit: warnLimitTokens, rule: "SFA-CONTEXT-001" },
          ),
        );
      }
    }

    data.entries.push({
      name,
      logicalName: typeof entry.logicalName === "string" ? entry.logicalName : null,
      physicalRef,
      humanEntry: entry.humanEntry === true,
      sideEffectClass: entry.sideEffectClass ?? null,
      tokens,
    });
  }

  return entryReport(data, findings);
}

function entryReport(data, findings) {
  return {
    kind: "skill-family.entry-check-report",
    schemaVersion: 1,
    generatedBy: { tool: KIT_TOOL_NAME, version: KIT_VERSION },
    target: { root: "." },
    declared: data.declared,
    documentState: data.documentState,
    ok: findings.length === 0,
    exitCode: findings.length === 0 ? 0 : 1,
    findings,
    data,
    policy:
      "entry contract gate is diagnosis only: it reads declarations and SKILL.md bytes, estimates tokens through the authoritative estimator and the frozen consumption contract, and never writes",
  };
}

/**
 * CLI sub-action wrapper (positioned as `check entries`, parallel to
 * `check report`). Returns { status, output } where status maps to the
 * stable kit exit codes: ok -> 0, findings -> 1; mechanism failures throw
 * and the CLI maps them to 2.
 */
export async function checkEntriesAction({ root } = {}) {
  const output = await runEntryContractCheck({ root });
  return { status: output.ok ? "ok" : "findings", output };
}
