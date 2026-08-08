import { CONTRACTS_VERSION, findSchemaByObject } from "skill-family-contracts";
import {
  computeResourceClosure,
  digestBytes,
  readFileContained,
  validateContractDocument,
} from "skill-family-harness-node";
import { invalidParamsError, KIT_ERROR_KINDS } from "./errors.mjs";
import { probeGitState } from "./gitprobe.mjs";
import {
  KIT_TOOL_NAME,
  KIT_VERSION,
  MANAGED_LOCK_PATH,
  PROJECT_MANIFEST_PATH,
} from "./skeleton.mjs";
import {
  listTargetEntries,
  loadTargetFacts,
  matchAnyGlob,
  normalizeRelPath,
  readOptionalFile,
  readOptionalJson,
  resolveTargetRoot,
} from "./workspace.mjs";
import {
  checkIdentityDrift,
  loadIdentityRecord,
  validateIdentityAgainstProfile,
} from "./identity-check.mjs";

/**
 * check — diagnosis only, never auto-fix.
 *
 * Seven diagnosis classes, exactly as the FND-030 and FND-045 hand-offs bound them:
 *   contracts — discovered contract documents against registered schemas;
 *   drift     — managed-file-lock entries vs actual bytes on disk;
 *   closure   — harness resource closure over declared inputs/outputs;
 *   version   — declared contracts version vs the frozen contracts version;
 *   docs      — documentation facts (README presence, identity consistency);
 *   git       — read-only Git pre-state (never a git write);
 *   identity  — licensing and identity drift checks (FND-045).
 *
 * This module contains no write call of any kind. Mutation-looking flags
 * (--fix, --apply, ...) are refused at intake by the CLI. Findings carry
 * stable kinds and registered SFC codes; the exit code is the stable
 * signal (0 clean, 1 findings, 2 rejected/usage/mechanism error).
 */

const CHECK_CLASSES = Object.freeze(["contracts", "drift", "closure", "version", "docs", "git", "identity"]);

export { CHECK_CLASSES };

function finding(checkClass, kind, code, message, extra) {
  return { class: checkClass, kind, code, message, ...(extra ?? {}) };
}

async function checkContracts(rootAbs, docs, findings) {
  const targets = [
    ["project-manifest", PROJECT_MANIFEST_PATH],
    ["managed-file-lock", MANAGED_LOCK_PATH],
  ];
  let present = 0;
  for (const [objectName, relPath] of targets) {
    const loaded = await readOptionalJson(rootAbs, relPath);
    if (loaded.reason === "missing") continue;
    present += 1;
    docs[relPath] = loaded.ok ? loaded.value : null;
    if (!loaded.ok) {
      findings.push(
        finding(
          "contracts",
          KIT_ERROR_KINDS.CONTRACT_PARSE_FAILED,
          "SFC1001",
          `${relPath} is not valid JSON`,
          { path: relPath },
        ),
      );
      continue;
    }
    const registration = findSchemaByObject(objectName);
    const outcome = validateContractDocument(loaded.value, { schemaId: registration.$id });
    if (!outcome.valid) {
      findings.push(
        finding(
          "contracts",
          "schema-validation-failed",
          outcome.errorCode,
          `${relPath} fails the registered ${objectName} schema: ${outcome.errors
            .slice(0, 3)
            .map((entry) => `${entry.instancePath || "/"} ${entry.message}`)
            .join("; ")}`,
          { path: relPath, schemaId: registration.$id },
        ),
      );
    }
  }
  if (present === 0) {
    findings.push(
      finding(
        "contracts",
        KIT_ERROR_KINDS.CONTRACTS_MISSING,
        "SFC2004",
        "no contract documents found (expected skill-family.project-manifest.json and/or skill-family.managed-file-lock.json)",
      ),
    );
  }
}

/** Contained read of a target-declared path: missing => null, escape => finding. */
async function readManagedCandidate(rootAbs, rel, findings) {
  try {
    return await readFileContained(rootAbs, rel, { encoding: "utf8" });
  } catch (cause) {
    const kind = cause && cause.details ? cause.details.kind : null;
    if (kind === "missing-resource") return null;
    // Escaping lock entries are target-supplied data: report them, never follow them.
    findings.push(
      finding(
        "drift",
        kind ?? "uncontained-lock-path",
        "SFC2004",
        `lock entry path is not safely readable inside the target: ${rel} (kind: ${kind ?? "unknown"})`,
        { path: rel },
      ),
    );
    return { escaped: true };
  }
}

async function checkDrift(rootAbs, findings) {
  const loaded = await readOptionalJson(rootAbs, MANAGED_LOCK_PATH);
  if (!loaded.ok) return null; // no lock => nothing to drift against
  const lock = loaded.value;
  const entries = Array.isArray(lock?.entries) ? lock.entries : [];
  for (const entry of entries) {
    const rel = typeof entry?.path === "string" ? normalizeRelPath(entry.path) : null;
    const declaredHash = entry?.hash?.value;
    if (!rel || typeof declaredHash !== "string" || !/^[0-9a-f]{64}$/.test(declaredHash)) {
      continue; // malformed entries are reported by the contracts class
    }
    const text = await readManagedCandidate(rootAbs, rel, findings);
    if (text === null) {
      findings.push(
        finding(
          "drift",
          KIT_ERROR_KINDS.MANAGED_FILE_MISSING,
          "SFC2004",
          `managed file declared in the lock does not exist: ${rel}`,
          { path: rel },
        ),
      );
      continue;
    }
    if (typeof text !== "string") continue; // escaping path already reported
    const actual = digestBytes(Buffer.from(text, "utf8"));
    if (actual !== declaredHash) {
      findings.push(
        finding(
          "drift",
          KIT_ERROR_KINDS.MANAGED_FILE_DRIFT,
          "SFC2004",
          `managed file drifted from its locked hash: ${rel} (lock=${declaredHash.slice(0, 12)}… actual=${actual.slice(0, 12)}…)`,
          { path: rel },
        ),
      );
    }
  }
  return lock;
}

async function checkClosure(rootAbs, lock, findings) {
  if (!lock) return { digest: null, note: "no managed-file-lock present; closure check skipped" };
  const resources = [
    { path: MANAGED_LOCK_PATH, role: "input" },
    ...(Array.isArray(lock.entries) ? lock.entries : [])
      .filter((entry) => typeof entry?.path === "string")
      .map((entry) => ({ path: normalizeRelPath(entry.path), role: "output" })),
  ];
  try {
    const closure = await computeResourceClosure({ root: rootAbs, resources });
    const missingOutputs = closure.resources.filter(
      (resource) => resource.role === "output" && !resource.exists,
    );
    for (const missing of missingOutputs) {
      findings.push(
        finding(
          "closure",
          KIT_ERROR_KINDS.CLOSURE_INPUT_MISSING,
          "SFC2004",
          `closure output resource does not exist: ${missing.path}`,
          { path: missing.path },
        ),
      );
    }
    return { digest: closure.digest, resourceCount: closure.resources.length };
  } catch (cause) {
    const kind =
      cause && cause.details && cause.details.kind === "missing-resource"
        ? KIT_ERROR_KINDS.CLOSURE_INPUT_MISSING
        : "closure-failed";
    findings.push(
      finding(
        "closure",
        kind,
        "SFC2004",
        `resource closure could not be computed: ${cause && cause.message ? cause.message : "unknown"}`,
      ),
    );
    return { digest: null };
  }
}

async function checkVersion(docs, findings) {
  const manifest = docs[PROJECT_MANIFEST_PATH];
  const declared = manifest?.contracts?.version;
  if (typeof declared !== "string") return { contractsVersion: null };
  if (declared !== CONTRACTS_VERSION) {
    findings.push(
      finding(
        "version",
        KIT_ERROR_KINDS.CONTRACTS_VERSION_MISMATCH,
        "SFC2004",
        `project manifest declares contracts version ${declared}; this kit validates against ${CONTRACTS_VERSION}`,
        { declared, expected: CONTRACTS_VERSION },
      ),
    );
  }
  return { contractsVersion: declared };
}

async function checkDocs(rootAbs, docs, findings) {
  const readme = await readOptionalFile(rootAbs, "README.md");
  if (readme === null || readme.trim().length === 0) {
    findings.push(
      finding(
        "docs",
        KIT_ERROR_KINDS.README_MISSING,
        "SFC2004",
        "README.md is missing or empty (documentation fact)",
        { path: "README.md" },
      ),
    );
  }
  const packageJson = await readOptionalJson(rootAbs, "package.json");
  const manifest = docs[PROJECT_MANIFEST_PATH];
  if (packageJson.ok && manifest && typeof manifest?.project === "object") {
    const packageName = packageJson.value?.name;
    if (typeof packageName === "string") {
      if (manifest.project.id !== packageName) {
        findings.push(
          finding(
            "docs",
            KIT_ERROR_KINDS.IDENTITY_MISMATCH,
            "SFC2004",
            `project manifest id "${manifest.project.id}" does not match package.json name "${packageName}"`,
            { manifestId: manifest.project.id, packageName },
          ),
        );
      }
    }
  }
}

async function checkGit(rootAbs, findings, allowGitSpawn) {
  const git = await probeGitState(rootAbs, { allowSpawn: allowGitSpawn });
  if (git.repository && git.headCommit === false) {
    findings.push(
      finding(
        "git",
        KIT_ERROR_KINDS.GIT_NO_COMMITS,
        "SFC2004",
        "the target is a git repository without any commit; history does not protect anything yet",
      ),
    );
  }
  if (git.repository && git.cleanState === false) {
    findings.push(
      finding(
        "git",
        KIT_ERROR_KINDS.GIT_DIRTY,
        "SFC2004",
        "the target has uncommitted changes; settle them before running write commands elsewhere",
      ),
    );
  }
  return git;
}

async function checkIdentity(rootAbs, docs, findings, profilesRoot) {
  // Load identity record
  const identityRecord = await loadIdentityRecord(rootAbs);

  if (!identityRecord) {
    findings.push(
      finding(
        "identity",
        KIT_ERROR_KINDS.IDENTITY_RECORD_MISSING,
        "SFC2004",
        "identity record not found; cannot perform identity drift check",
        { path: "skill-family.identity-record.json" },
      ),
    );
    return null;
  }

  // Store for later use
  docs["skill-family.identity-record.json"] = identityRecord;

  // Validate against profile
  if (profilesRoot) {
    const profileValidation = await validateIdentityAgainstProfile(identityRecord, profilesRoot);
    for (const f of profileValidation.findings) {
      findings.push(
        finding(
          "identity",
          f.kind,
          f.code,
          f.message,
          { source: f.source, ...f },
        ),
      );
    }
  }

  // Check identity drift
  const driftReport = await checkIdentityDrift({ rootAbs, identityRecord });
  for (const f of driftReport.findings) {
    findings.push(
      finding(
        "identity",
        f.kind,
        f.code,
        f.message,
        { source: f.source, ...f },
      ),
    );
  }

  return identityRecord;
}

/**
 * Runs all check classes over one target.
 * Options: { root, allowGitSpawn, profilesRoot }.
 * Returns the report document. Never writes anywhere; throws KitError only
 * for unusable inputs (an unreadable target).
 */
export async function runChecks({ root, allowGitSpawn = true, only, profilesRoot } = {}) {
  if (only !== undefined && !CHECK_CLASSES.includes(only)) {
    throw invalidParamsError(`--only must be one of: ${CHECK_CLASSES.join(", ")}`, { value: only });
  }
  const rootAbs = await resolveTargetRoot(root ?? ".");
  const findings = [];
  const docs = {};

  const classes = only === undefined ? CHECK_CLASSES : CHECK_CLASSES.filter((name) => name === only);
  let closureInfo = { digest: null, note: "skipped" };
  let git = null;
  let versionInfo = { contractsVersion: null };
  let identityRecord = null;

  if (classes.includes("contracts")) await checkContracts(rootAbs, docs, findings);
  if (classes.includes("drift")) {
    const lock = await checkDrift(rootAbs, findings);
    if (classes.includes("closure")) closureInfo = await checkClosure(rootAbs, lock, findings);
  }
  if (classes.includes("version")) versionInfo = await checkVersion(docs, findings);
  if (classes.includes("docs")) await checkDocs(rootAbs, docs, findings);
  if (classes.includes("git")) git = await checkGit(rootAbs, findings, allowGitSpawn);
  if (classes.includes("identity")) identityRecord = await checkIdentity(rootAbs, docs, findings, profilesRoot);

  const byClass = {};
  for (const item of findings) {
    byClass[item.class] = (byClass[item.class] ?? 0) + 1;
  }

  // The handwritten-managed classification fact is reported as data too, so
  // consumers can see which entries would be write-protected.
  const entries = await listTargetEntries(rootAbs);
  const managedDeclarations = [];
  const facts = await loadTargetFacts(rootAbs);
  for (const rel of [...facts.managedSet].sort()) {
    managedDeclarations.push({
      path: rel,
      handwrittenAlso: matchAnyGlob(facts.handwrittenPatterns, rel),
    });
  }

  return {
    kind: "skill-family.check-report",
    schemaVersion: 1,
    generatedBy: { tool: KIT_TOOL_NAME, version: KIT_VERSION },
    target: { root: ".", entryCount: entries.length },
    ok: findings.length === 0,
    classes: CHECK_CLASSES.map((name) => ({
      name,
      ran: classes.includes(name),
      findings: byClass[name] ?? 0,
    })),
    findings,
    data: {
      closure: closureInfo,
      git,
      version: versionInfo,
      managedDeclarations,
      identity: identityRecord ? {
        record: identityRecord,
        licensing: identityRecord.licensing,
        authors: identityRecord.authors,
      } : null,
    },
    policy:
      "check is diagnosis only: it never writes, never fixes, and never calls git write commands; findings must be resolved by a human or an authorized generator",
  };
}
