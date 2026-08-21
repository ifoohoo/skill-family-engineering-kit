import { CONTRACTS_VERSION, findSchemaByObject } from "skill-family-contracts";
import {
  computeResourceClosure,
  digestBytes,
  readFileContained,
  validateContractDocument,
} from "skill-family-harness-node";
import { readFileSync } from "node:fs";
import { invalidParamsError, KIT_ERROR_KINDS } from "./errors.mjs";
import { probeGitState } from "./gitprobe.mjs";
import {
  KIT_TOOL_NAME,
  KIT_VERSION,
  MANAGED_LOCK_PATH,
  PLATFORM_SUBSET_DECLARATION_PATH,
  PROJECT_MANIFEST_PATH,
  PUBLIC_BOUNDARY_DECLARATION_PATH,
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
 * Nine diagnosis classes. The first seven are exactly as the FND-030 and
 * FND-045 hand-offs bound them; the audit remediation C2 delivery extends
 * the closed set to nine (boundary, platform) and extends the version class
 * with the version single-source consistency facts:
 *   contracts — discovered contract documents against registered schemas;
 *   drift     — managed-file-lock entries vs actual bytes on disk (the
 *               managed-artifact drift check; C2 "生成物漂移" is carried by
 *               this existing class, aligned, not duplicated; SG-37: on a
 *               fresh checkout the build outputs simply do not exist yet, so
 *               when EVERY well-formed lock entry is absent on disk the
 *               target is diagnosed as never-built — one dedicated
 *               NEVER_BUILT finding carrying build-first guidance, kept
 *               distinct from both content drift and partial loss; the
 *               fail-closed semantics are unchanged: it remains a finding);
 *   closure   — harness resource closure over declared inputs/outputs;
 *   version   — declared contracts version vs the frozen contracts version,
 *               plus version single-source consistency (SG-13/14, VRG-001/002:
 *               package.json is the single version authority; no double-headed
 *               VERSION authority; every workspace package.json carries the
 *               same single-source version);
 *   docs      — documentation facts (README presence, identity consistency);
 *   git       — read-only Git pre-state (never a git write);
 *   identity  — licensing and identity drift checks (FND-045);
 *   boundary  — public release boundary declaration (SG-17, VRG-005): when a
 *               public-boundary-declaration document is present it is schema-
 *               verified and mechanically reconciled against the actual file
 *               set (required paths present, forbidden paths absent, no
 *               undeclared file under a public root); absence is data, not a
 *               finding — whether a project owes a boundary declaration is a
 *               semantic/release decision;
 *   platform  — platform subset restriction declaration (SFA-PLAT-002 / B3):
 *               when a platform-subset-declaration document is present it is
 *               verified against the frozen four-field template with the
 *               controlled platform vocabulary of the observation-scope
 *               contract, and its declared version is reconciled against the
 *               single-source package.json version; absence is data, not a
 *               finding (declaration completeness is carried by semantic
 *               review until a project declares).
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

const CHECK_CLASSES = Object.freeze([
  "contracts",
  "drift",
  "closure",
  "version",
  "docs",
  "git",
  "identity",
  "boundary",
  "platform",
]);

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
  // SG-37: classify every well-formed lock entry before emitting findings, so
  // a target whose managed build outputs were NEVER built is diagnosed with
  // the dedicated never-built finding (plus build-first guidance) instead of
  // N per-file missing findings that are indistinguishable from content
  // drift or partial loss. Fail-closed semantics are unchanged: every branch
  // below remains a finding (exit code 1), never a silent pass.
  const missingPaths = [];
  const driftFindings = [];
  let wellFormed = 0;
  let escaped = 0;
  for (const entry of entries) {
    const rel = typeof entry?.path === "string" ? normalizeRelPath(entry.path) : null;
    const declaredHash = entry?.hash?.value;
    if (!rel || typeof declaredHash !== "string" || !/^[0-9a-f]{64}$/.test(declaredHash)) {
      continue; // malformed entries are reported by the contracts class
    }
    wellFormed += 1;
    const text = await readManagedCandidate(rootAbs, rel, findings);
    if (text === null) {
      missingPaths.push(rel);
      continue;
    }
    if (typeof text !== "string") {
      escaped += 1; // escaping path already reported by readManagedCandidate
      continue;
    }
    const actual = digestBytes(Buffer.from(text, "utf8"));
    if (actual !== declaredHash) {
      driftFindings.push(
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
  if (wellFormed > 0 && escaped === 0 && missingPaths.length === wellFormed) {
    // Every managed output declared in the lock is absent on disk: the build
    // was never run. This is the fresh-checkout state, not content drift.
    findings.push(
      finding(
        "drift",
        KIT_ERROR_KINDS.NEVER_BUILT,
        "SFC2004",
        `managed build outputs have never been built: all ${wellFormed} managed file(s) declared in the lock are absent on disk; this is a never-built target, not content drift — run the project's build first, then re-run verify/check`,
        { neverBuilt: true, absentPaths: [...missingPaths].sort() },
      ),
    );
  } else {
    for (const rel of missingPaths) {
      findings.push(
        finding(
          "drift",
          KIT_ERROR_KINDS.MANAGED_FILE_MISSING,
          "SFC2004",
          `managed file declared in the lock does not exist: ${rel}`,
          { path: rel },
        ),
      );
    }
  }
  findings.push(...driftFindings);
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

/**
 * Version single-source consistency (SG-13/14; audit VRG-001/VRG-002).
 *
 * The version truth source of a release unit is the `version` field of its
 * package.json. Two mechanical facts follow:
 * - VRG-001: a VERSION file alongside package.json is a double-headed
 *   version authority; the authority must converge on package.json;
 * - VRG-002: the version value is declared once; every other occurrence is
 *   mechanically synchronized — here: every nested workspace package.json
 *   must carry exactly the root package.json version.
 *
 * When no root package.json version exists there is no single source to
 * compare against and the sub-check reports nothing (never guesses).
 * Returns { rootVersion, versionFilePresent, drifted }.
 */
async function checkVersionSingleSource(rootAbs, findings) {
  const facts = { rootVersion: null, versionFilePresent: false, drifted: [] };
  const packageDocument = await loadDocument(rootAbs, "package.json");
  if (packageDocument.state !== "ok" || typeof packageDocument.value?.version !== "string") {
    return facts;
  }
  facts.rootVersion = packageDocument.value.version;

  const versionFile = await readOptionalFile(rootAbs, "VERSION");
  if (versionFile !== null) {
    facts.versionFilePresent = true;
    findings.push(
      finding(
        "version",
        KIT_ERROR_KINDS.VERSION_AUTHORITY_DUAL,
        "SFC2004",
        "VERSION file exists alongside package.json; version authority must converge on the package.json version field as the single source (VRG-001)",
        { path: "VERSION" },
      ),
    );
  }

  const entries = await listTargetEntries(rootAbs);
  for (const entry of entries) {
    if (entry.kind !== "file" || entry.path === "package.json" || !entry.path.endsWith("package.json")) {
      continue;
    }
    const nested = await loadDocument(rootAbs, entry.path);
    if (nested.state !== "ok" || typeof nested.value?.version !== "string") continue;
    if (nested.value.version !== facts.rootVersion) {
      facts.drifted.push({ path: entry.path, version: nested.value.version });
      findings.push(
        finding(
          "version",
          KIT_ERROR_KINDS.VERSION_SINGLE_SOURCE_DRIFT,
          "SFC2004",
          `${entry.path} declares version ${nested.value.version}; the single version source is the root package.json version ${facts.rootVersion} (VRG-002)`,
          { path: entry.path, declared: nested.value.version, expected: facts.rootVersion },
        ),
      );
    }
  }
  return facts;
}

async function checkVersion(rootAbs, findings) {
  // The single-source consistency facts do not depend on the project manifest;
  // they are computed on every run (class independence).
  const singleSource = await checkVersionSingleSource(rootAbs, findings);
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
    return { contractsVersion: null, singleSource };
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
    return { contractsVersion: null, singleSource };
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
    return { contractsVersion: null, singleSource };
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
  return { contractsVersion: declared, singleSource };
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
 * Public boundary verification (SG-17; audit VRG-005, carrier of the C5
 * public-boundary-declaration contract).
 *
 * When the target holds a public-boundary-declaration document it is
 * verified in two steps: (1) the document must pass the registered
 * public-boundary-declaration schema; (2) the declaration is mechanically
 * reconciled against the actual regular file set — every required path must
 * exist, every forbidden path must be absent, every declared public file
 * must exist and live under a declared public root, and every regular file
 * under a public root must be declared (an undeclared file is a leak).
 *
 * Absence of the declaration is data, never a finding: whether a project
 * owes a boundary declaration depends on its release surface and is decided
 * by semantic review / the release process (VRG-005). Returns
 * { declared, declarationId, declaredVersion, documentState }.
 */
async function checkBoundary(rootAbs, findings) {
  const data = { declared: false, declarationId: null, declaredVersion: null, documentState: "missing" };
  const document = await loadDocument(rootAbs, PUBLIC_BOUNDARY_DECLARATION_PATH, {
    schemaObject: "public-boundary-declaration",
  });
  data.documentState = document.state;
  if (document.state === "missing") return data;
  data.declared = true;
  if (document.state === "parse-failed") {
    findings.push(
      finding(
        "boundary",
        KIT_ERROR_KINDS.CONTRACT_PARSE_FAILED,
        "SFC2004",
        `${PUBLIC_BOUNDARY_DECLARATION_PATH} is not valid JSON`,
        { path: PUBLIC_BOUNDARY_DECLARATION_PATH, documentState: document.state },
      ),
    );
    return data;
  }
  if (document.state === "schema-invalid") {
    findings.push(
      finding(
        "boundary",
        "schema-validation-failed",
        "SFC1001",
        `${PUBLIC_BOUNDARY_DECLARATION_PATH} fails the registered public-boundary-declaration schema: ${document.outcome.errors
          .slice(0, 3)
          .map((entry) => `${entry.instancePath || "/"} ${entry.message}`)
          .join("; ")}`,
        {
          path: PUBLIC_BOUNDARY_DECLARATION_PATH,
          schemaId: findSchemaByObject("public-boundary-declaration").$id,
          documentState: document.state,
        },
      ),
    );
    return data;
  }

  const declaration = document.value;
  data.declarationId = declaration.declarationId;
  data.declaredVersion = declaration.declaredVersion;
  const violation = (message, extra) =>
    findings.push(
      finding("boundary", KIT_ERROR_KINDS.PUBLIC_BOUNDARY_VIOLATION, "SFC2004", message, {
        path: PUBLIC_BOUNDARY_DECLARATION_PATH,
        ...(extra ?? {}),
      }),
    );

  const entries = await listTargetEntries(rootAbs);
  const regularFiles = new Set(entries.filter((entry) => entry.kind === "file").map((entry) => entry.path));
  const publicFiles = new Set(declaration.publicFiles);
  const underPublicRoot = (rel) =>
    declaration.publicRoots.some((root) => rel.startsWith(`${root}/`));

  for (const required of declaration.requiredPaths) {
    if (!regularFiles.has(required)) {
      violation(`required public path is missing from the release set: ${required}`, {
        subject: required,
        rule: "requiredPaths",
      });
    }
  }
  for (const forbidden of declaration.forbiddenPaths) {
    if (regularFiles.has(forbidden)) {
      violation(`forbidden path is present in the release set: ${forbidden}`, {
        subject: forbidden,
        rule: "forbiddenPaths",
      });
    }
  }
  for (const declared of declaration.publicFiles) {
    if (!regularFiles.has(declared)) {
      violation(`declared public file does not exist on disk: ${declared}`, {
        subject: declared,
        rule: "publicFiles",
      });
    }
    if (!underPublicRoot(declared)) {
      violation(`declared public file is outside every declared public root: ${declared}`, {
        subject: declared,
        rule: "publicRoots",
      });
    }
  }
  for (const actual of regularFiles) {
    if (underPublicRoot(actual) && !publicFiles.has(actual)) {
      violation(`file under a public root is not declared in publicFiles (undeclared leak): ${actual}`, {
        subject: actual,
        rule: "publicFiles",
      });
    }
  }
  return data;
}

/** Kind of the kit-owned platform subset restriction declaration template. */
export const PLATFORM_SUBSET_DECLARATION_KIND = "skill-family.platform-subset-declaration";

const SEMVER_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/;

/**
 * Loads the controlled platform vocabulary frozen by the observation-scope
 * contract (standardPlatforms enum). Derived mechanically from the
 * registered schema document of skill-family-contracts — the kit never
 * restates the vocabulary as a second owned copy. Throws when the contract
 * cannot be located (a mechanism failure of the platform class).
 */
function loadStandardPlatformVocabulary() {
  const registration = findSchemaByObject("observation-scope");
  const contractsIndexUrl = import.meta.resolve("skill-family-contracts");
  const packageRootUrl = new URL("..", contractsIndexUrl);
  const schemaUrl = new URL(registration.file, packageRootUrl);
  const schema = JSON.parse(readFileSync(schemaUrl, "utf8"));
  const vocabulary = schema?.properties?.standardPlatforms?.items?.enum;
  if (!Array.isArray(vocabulary) || vocabulary.length === 0) {
    throw new Error("observation-scope schema does not freeze a standardPlatforms vocabulary");
  }
  return Object.freeze([...vocabulary]);
}

/**
 * Platform subset restriction declaration verification (SFA-PLAT-002 / B3;
 * audit OC-3, decision D-9). Platform coverage is optional; the obligation
 * is an honest, machine-checkable declaration of the released platform
 * subset. The frozen four-field template:
 *   project / released_platform_subset / missing_platforms / declared_version.
 *
 * When the target holds a platform-subset-declaration document it is
 * verified mechanically: the template shape, platform ids restricted to the
 * controlled observation-scope vocabulary, no duplicate or overlapping
 * entries, and the declared version reconciled against the single-source
 * root package.json version. Absence is data, never a finding: declaration
 * completeness is carried by semantic review until a project declares.
 * Returns { declared, project, released, missing, declaredVersion, documentState }.
 */
async function checkPlatform(rootAbs, findings) {
  const data = {
    declared: false,
    project: null,
    released: [],
    missing: [],
    declaredVersion: null,
    documentState: "missing",
  };
  const loaded = await readOptionalJson(rootAbs, PLATFORM_SUBSET_DECLARATION_PATH);
  if (loaded.reason === "missing") return data;
  data.declared = true;
  const invalid = (message, extra) =>
    findings.push(
      finding("platform", KIT_ERROR_KINDS.PLATFORM_SUBSET_INVALID, "SFC2004", message, {
        path: PLATFORM_SUBSET_DECLARATION_PATH,
        ...(extra ?? {}),
      }),
    );
  if (!loaded.ok) {
    data.documentState = "parse-failed";
    findings.push(
      finding(
        "platform",
        KIT_ERROR_KINDS.CONTRACT_PARSE_FAILED,
        "SFC2004",
        `${PLATFORM_SUBSET_DECLARATION_PATH} is not valid JSON`,
        { path: PLATFORM_SUBSET_DECLARATION_PATH, documentState: data.documentState },
      ),
    );
    return data;
  }
  data.documentState = "ok";
  const declaration = loaded.value;
  if (declaration?.schemaVersion !== 1) {
    invalid(`schemaVersion must be exactly 1 (got ${JSON.stringify(declaration?.schemaVersion ?? null)})`, {
      field: "schemaVersion",
    });
  }
  if (declaration?.kind !== PLATFORM_SUBSET_DECLARATION_KIND) {
    invalid(`kind must be "${PLATFORM_SUBSET_DECLARATION_KIND}" (got ${JSON.stringify(declaration?.kind ?? null)})`, {
      field: "kind",
    });
  }
  if (typeof declaration?.project !== "string" || declaration.project.length === 0) {
    invalid("project must be a non-empty string (template field 1/4)", { field: "project" });
  } else {
    data.project = declaration.project;
  }

  const vocabulary = loadStandardPlatformVocabulary();
  const verifyPlatformList = (fieldName) => {
    const value = declaration?.[fieldName];
    if (!Array.isArray(value)) {
      invalid(`${fieldName} must be an array of platform ids (got ${JSON.stringify(value ?? null)})`, {
        field: fieldName,
      });
      return [];
    }
    const seen = new Set();
    for (const platform of value) {
      if (typeof platform !== "string" || platform.length === 0) {
        invalid(`${fieldName} entries must be non-empty strings`, { field: fieldName });
        continue;
      }
      if (seen.has(platform)) {
        invalid(`${fieldName} contains a duplicate platform id: ${platform}`, { field: fieldName, subject: platform });
        continue;
      }
      seen.add(platform);
      if (!vocabulary.includes(platform)) {
        invalid(
          `${fieldName} entry is outside the controlled platform vocabulary of the observation-scope contract: ${platform}`,
          { field: fieldName, subject: platform },
        );
      }
    }
    return [...seen];
  };
  data.released = verifyPlatformList("released_platform_subset");
  data.missing = verifyPlatformList("missing_platforms");

  const overlap = data.released.filter((platform) => data.missing.includes(platform));
  if (overlap.length > 0) {
    invalid(
      `released_platform_subset and missing_platforms must be disjoint; overlap: ${overlap.join(", ")}`,
      { field: "released_platform_subset/missing_platforms", subject: overlap },
    );
  }

  if (typeof declaration?.declared_version !== "string" || !SEMVER_PATTERN.test(declaration.declared_version)) {
    invalid(
      `declared_version must be a semantic version string X.Y.Z (got ${JSON.stringify(declaration?.declared_version ?? null)})`,
      { field: "declared_version" },
    );
  } else {
    data.declaredVersion = declaration.declared_version;
    // The declared version is reconciled against the single version source
    // (root package.json); without one there is nothing to compare.
    const packageDocument = await loadDocument(rootAbs, "package.json");
    if (
      packageDocument.state === "ok" &&
      typeof packageDocument.value?.version === "string" &&
      packageDocument.value.version !== declaration.declared_version
    ) {
      findings.push(
        finding(
          "platform",
          KIT_ERROR_KINDS.PLATFORM_SUBSET_VERSION_DRIFT,
          "SFC2004",
          `platform subset declaration declares version ${declaration.declared_version}; the single version source (package.json) is ${packageDocument.value.version}`,
          {
            path: PLATFORM_SUBSET_DECLARATION_PATH,
            declared: declaration.declared_version,
            expected: packageDocument.value.version,
          },
        ),
      );
    }
  }
  return data;
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
    boundary: () => checkBoundary(rootAbs, findings),
    platform: () => checkPlatform(rootAbs, findings),
  };

  const classData = {
    closure: { digest: null, note: "not-selected" },
    git: null,
    version: { contractsVersion: null, singleSource: null },
    identity: null,
    boundary: { declared: false, declarationId: null, declaredVersion: null, documentState: "missing" },
    platform: { declared: false, project: null, released: [], missing: [], declaredVersion: null, documentState: "missing" },
  };

  for (const name of CHECK_CLASSES) {
    if (!selected.has(name)) continue;
    try {
      const result = await runners[name]();
      completed.add(name);
      if (name === "closure") classData.closure = result;
      if (name === "git") classData.git = result;
      if (name === "version") classData.version = result;
      if (name === "boundary") classData.boundary = result;
      if (name === "platform") classData.platform = result;
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
      boundary: classData.boundary,
      platform: classData.platform,
    },
    policy:
      "check is diagnosis only: it never writes, never fixes, and never calls git write commands; findings must be resolved by a human or an authorized generator",
  };
}
