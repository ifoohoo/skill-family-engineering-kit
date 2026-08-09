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
 * Every class is independently complete: it loads its own inputs and never
 * consumes another class's cache, so a full run and a `--only <class>` run
 * produce byte-identical findings for that class (the equivalence matrix in
 * test/check-equivalence.test.mjs is the mechanical witness). Document
 * loading distinguishes the four stable states missing / parse-failed /
 * schema-invalid / incomplete, and class results distinguish selected /
 * completed / findings — a class that never ran is never reported as having
 * run.
 *
 * This module contains no write call of any kind. Mutation-looking flags
 * (--fix, --apply, ...) are refused at intake by the CLI. Findings carry
 * stable kinds and registered SFC codes; the exit code is the stable
 * signal (0 clean, 1 findings, 2 rejected/usage/mechanism error).
 */

const CHECK_CLASSES = Object.freeze(["contracts", "drift", "closure", "version", "docs", "git", "identity"]);

export { CHECK_CLASSES };

/**
 * Stable document loading states every check class must distinguish:
 *   missing        — the file does not exist;
 *   parse-failed   — the bytes are not valid JSON;
 *   schema-invalid — the parsed document fails its registered schema;
 *   incomplete     — parsed (and schema-checked where requested) but a fact
 *                    the consuming class needs is absent;
 *   ok             — every requested state passed.
 */
export const DOCUMENT_STATES = Object.freeze([
  "missing",
  "parse-failed",
  "schema-invalid",
  "incomplete",
  "ok",
]);

function finding(checkClass, kind, code, message, extra) {
  return { class: checkClass, kind, code, message, ...(extra ?? {}) };
}

/**
 * Loads one JSON document and classifies it into the stable document states.
 * Options:
 *   schemaObject — when given, an ok state additionally requires the parsed
 *                  document to pass the registered schema of that object;
 *   completeWhen — when given, an ok state additionally requires the predicate
 *                  to hold on the parsed value (absence => "incomplete").
 */
async function loadDocument(rootAbs, relPath, { schemaObject, completeWhen } = {}) {
  const loaded = await readOptionalJson(rootAbs, relPath);
  if (loaded.reason === "missing") return { state: "missing", value: null };
  if (!loaded.ok) return { state: "parse-failed", value: null };
  if (schemaObject !== undefined) {
    const registration = findSchemaByObject(schemaObject);
    const outcome = validateContractDocument(loaded.value, { schemaId: registration.$id });
    if (!outcome.valid) return { state: "schema-invalid", value: loaded.value, outcome };
  }
  if (completeWhen !== undefined && !completeWhen(loaded.value)) {
    return { state: "incomplete", value: loaded.value };
  }
  return { state: "ok", value: loaded.value };
}

async function checkContracts(rootAbs, findings) {
  const targets = [
    ["project-manifest", PROJECT_MANIFEST_PATH],
    ["managed-file-lock", MANAGED_LOCK_PATH],
  ];
  let present = 0;
  for (const [objectName, relPath] of targets) {
    const document = await loadDocument(rootAbs, relPath, { schemaObject: objectName });
    if (document.state === "missing") continue;
    present += 1;
    if (document.state === "parse-failed") {
      findings.push(
        finding(
          "contracts",
          KIT_ERROR_KINDS.CONTRACT_PARSE_FAILED,
          "SFC1001",
          `${relPath} is not valid JSON`,
          { path: relPath, documentState: document.state },
        ),
      );
      continue;
    }
    if (document.state === "schema-invalid") {
      findings.push(
        finding(
          "contracts",
          "schema-validation-failed",
          "SFC1001",
          `${relPath} fails the registered ${objectName} schema: ${document.outcome.errors
            .slice(0, 3)
            .map((entry) => `${entry.instancePath || "/"} ${entry.message}`)
            .join("; ")}`,
          { path: relPath, schemaId: findSchemaByObject(objectName).$id, documentState: document.state },
        ),
      );
      continue;
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

/**
 * Loads and parses the managed-file-lock JSON independently of any check class.
 * Returns the parsed lock object, or null when the lock is absent or unreadable.
 */
async function loadManagedFileLock(rootAbs) {
  const loaded = await readOptionalJson(rootAbs, MANAGED_LOCK_PATH);
  if (!loaded.ok) return null;
  return loaded.value;
}

async function checkDrift(rootAbs, findings) {
  const lock = await loadManagedFileLock(rootAbs);
  if (!lock) {
    findings.push(
      finding(
        "drift",
        KIT_ERROR_KINDS.MANAGED_FILE_MISSING,
        "SFC2004",
        "managed-file-lock is absent; drift check cannot run without it",
        { path: MANAGED_LOCK_PATH },
      ),
    );
    return null;
  }
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

async function checkClosure(rootAbs, findings) {
  // The closure class loads its own lock: it never depends on the drift
  // class having run first.
  const lock = await loadManagedFileLock(rootAbs);
  if (!lock) {
    findings.push(
      finding(
        "closure",
        KIT_ERROR_KINDS.CLOSURE_INPUT_MISSING,
        "SFC2004",
        "managed-file-lock is absent; resource closure cannot be computed without it",
        { path: MANAGED_LOCK_PATH },
      ),
    );
    return { digest: null };
  }
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

async function checkVersion(rootAbs, findings) {
  // Loads its own manifest without schema validation: schema conformance is
  // the contracts class's finding, the version class only needs the fact.
  const document = await loadDocument(rootAbs, PROJECT_MANIFEST_PATH, {
    completeWhen: (value) => typeof value?.contracts?.version === "string",
  });
  if (document.state === "missing") {
    findings.push(
      finding(
        "version",
        KIT_ERROR_KINDS.CONTRACTS_MISSING,
        "SFC2004",
        "project manifest is absent; version check cannot run without it",
        { path: PROJECT_MANIFEST_PATH, documentState: document.state },
      ),
    );
    return { contractsVersion: null };
  }
  if (document.state === "parse-failed") {
    findings.push(
      finding(
        "version",
        KIT_ERROR_KINDS.CONTRACT_PARSE_FAILED,
        "SFC2004",
        "project manifest is not valid JSON; version check cannot run without it",
        { path: PROJECT_MANIFEST_PATH, documentState: document.state },
      ),
    );
    return { contractsVersion: null };
  }
  if (document.state === "incomplete") {
    findings.push(
      finding(
        "version",
        KIT_ERROR_KINDS.DOCUMENT_INCOMPLETE,
        "SFC2004",
        "project manifest lacks contracts.version; version check cannot run without it",
        { path: PROJECT_MANIFEST_PATH, documentState: document.state },
      ),
    );
    return { contractsVersion: null };
  }
  const declared = document.value.contracts.version;
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

async function checkDocs(rootAbs, findings) {
  // The docs class reads every documentation fact itself: README, package.json
  // and the project manifest. It never consumes another class's state.
  const readme = await readOptionalFile(rootAbs, "README.md");
  if (readme === null || readme.trim().length === 0) {
    findings.push(
      finding(
        "docs",
        KIT_ERROR_KINDS.README_MISSING,
        "SFC2004",
        "README.md is missing or empty (documentation fact)",
        { path: "README.md", documentState: "missing" },
      ),
    );
  }
  const packageDocument = await loadDocument(rootAbs, "package.json");
  if (packageDocument.state === "parse-failed") {
    findings.push(
      finding(
        "docs",
        KIT_ERROR_KINDS.CONTRACT_PARSE_FAILED,
        "SFC2004",
        "package.json is not valid JSON; documentation identity facts cannot be compared",
        { path: "package.json", documentState: packageDocument.state },
      ),
    );
  }
  const manifestDocument = await loadDocument(rootAbs, PROJECT_MANIFEST_PATH, {
    completeWhen: (value) => typeof value?.project?.id === "string",
  });
  if (manifestDocument.state === "parse-failed") {
    findings.push(
      finding(
        "docs",
        KIT_ERROR_KINDS.CONTRACT_PARSE_FAILED,
        "SFC2004",
        "project manifest is not valid JSON; documentation identity facts cannot be compared",
        { path: PROJECT_MANIFEST_PATH, documentState: manifestDocument.state },
      ),
    );
  } else if (manifestDocument.state === "incomplete") {
    findings.push(
      finding(
        "docs",
        KIT_ERROR_KINDS.DOCUMENT_INCOMPLETE,
        "SFC2004",
        "project manifest lacks a comparable project.id; documentation identity facts cannot be compared",
        { path: PROJECT_MANIFEST_PATH, documentState: manifestDocument.state },
      ),
    );
  } else if (manifestDocument.state === "ok" && packageDocument.state === "ok") {
    const packageName = packageDocument.value?.name;
    if (typeof packageName === "string" && manifestDocument.value.project.id !== packageName) {
      findings.push(
        finding(
          "docs",
          KIT_ERROR_KINDS.IDENTITY_MISMATCH,
          "SFC2004",
          `project manifest id "${manifestDocument.value.project.id}" does not match package.json name "${packageName}"`,
          { manifestId: manifestDocument.value.project.id, packageName },
        ),
      );
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

async function checkIdentity(rootAbs, findings, profilesRoot) {
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
 * Options: { root, allowGitSpawn, only, profilesRoot }.
 * Returns the report document. Never writes anywhere; throws KitError only
 * for unusable inputs (an unreadable target).
 *
 * Class results distinguish three facts: selected (included by --only),
 * completed (actually ran to its end), and findings (count). A class that
 * throws mid-flight stays completed=false and contributes a mechanism
 * finding; the report's mechanism flag maps to exit code 2.
 */
export async function runChecks({ root, allowGitSpawn = true, only, profilesRoot } = {}) {
  if (only !== undefined && !CHECK_CLASSES.includes(only)) {
    throw invalidParamsError(`--only must be one of: ${CHECK_CLASSES.join(", ")}`, { value: only });
  }
  const rootAbs = await resolveTargetRoot(root ?? ".");
  const findings = [];
  const selected = new Set(only === undefined ? CHECK_CLASSES : [only]);
  const completed = new Set();
  let mechanismFailure = false;

  const runners = {
    contracts: () => checkContracts(rootAbs, findings),
    drift: () => checkDrift(rootAbs, findings),
    closure: () => checkClosure(rootAbs, findings),
    version: () => checkVersion(rootAbs, findings),
    docs: () => checkDocs(rootAbs, findings),
    git: () => checkGit(rootAbs, findings, allowGitSpawn),
    identity: () => checkIdentity(rootAbs, findings, profilesRoot),
  };

  const classData = {
    closure: { digest: null, note: "not-selected" },
    git: null,
    version: { contractsVersion: null },
    identity: null,
  };

  for (const name of CHECK_CLASSES) {
    if (!selected.has(name)) continue;
    try {
      const result = await runners[name]();
      completed.add(name);
      if (name === "closure") classData.closure = result;
      if (name === "git") classData.git = result;
      if (name === "version") classData.version = result;
      if (name === "identity") {
        classData.identity = result
          ? { record: result, licensing: result.licensing, authors: result.authors }
          : null;
      }
    } catch (cause) {
      // A selected class that could not finish is a mechanism finding, never a
      // silent skip: completed stays false and the report says so.
      mechanismFailure = true;
      const causeKind =
        cause && cause.details && typeof cause.details.kind === "string"
          ? cause.details.kind
          : "unknown";
      findings.push(
        finding(
          name,
          KIT_ERROR_KINDS.CHECK_CLASS_FAILED,
          "SFC2004",
          `check class '${name}' could not complete: ${cause && cause.message ? cause.message : String(cause)}`,
          { causeKind },
        ),
      );
    }
  }

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
    mechanism: mechanismFailure,
    classes: CHECK_CLASSES.map((name) => ({
      name,
      selected: selected.has(name),
      completed: completed.has(name),
      findings: byClass[name] ?? 0,
    })),
    findings,
    data: {
      closure: classData.closure,
      git: classData.git,
      version: classData.version,
      managedDeclarations,
      identity: classData.identity,
    },
    policy:
      "check is diagnosis only: it never writes, never fixes, and never calls git write commands; findings must be resolved by a human or an authorized generator",
  };
}
