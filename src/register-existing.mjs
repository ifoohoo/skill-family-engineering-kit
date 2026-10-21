import { lstat } from "node:fs/promises";
import { CONTRACTS_VERSION, ContractsError, findSchemaByObject, validateDocument } from "skill-family-contracts";
import { classifyPathInput, digestBytes, publishFileExclusive, readFileContained, resolveContained } from "skill-family-harness-node";
import { isContainedDeclaration } from "./core-check.mjs";
import { KIT_ERROR_KINDS, kitError } from "./errors.mjs";
import {
  FILE_REGISTRY_PATH,
  KIT_TOOL_NAME,
  KIT_VERSION,
  MANAGED_LOCK_PATH,
  PROJECT_MANIFEST_PATH,
} from "./skeleton.mjs";
import { matchAnyGitignorePattern, matchAnyGlob, normalizeRelPath, resolveTargetRoot } from "./workspace.mjs";

/**
 * check register-existing — official first nonempty-project registration.
 *
 * Seeds the three closed-world state documents for an existing nonempty
 * tree that already has a valid profile.json. It does not scaffold, does
 * not apply adopt-plan, and never overwrites existing bytes. Relock still
 * never seeds; this sub-action is the only legal first write of the
 * registry, project-manifest, and managed-file-lock into a nonempty root.
 *
 * Transaction:
 *   1. All reads and validation complete before the first write.
 *   2. The three documents are computed in memory; the lock already binds
 *      the new registry and manifest bytes.
 *   3. Missing all three → exclusive create (registry, manifest, lock).
 *      All three present and byte-identical → idempotent success, zero write.
 *      Any other combination, overlapping classes, or drifted bytes → refuse
 *      with zero overwrite.
 */

export const REGISTER_EXISTING_REPORT_KIND = "skill-family.register-existing-report";

const DEFAULT_ARTIFACT_PATTERNS = Object.freeze([
  "node_modules/",
  "/site/",
  ".cache/",
  "/.qoder/",
  "*.log",
  ".DS_Store",
  ".env",
  ".env.*",
  "/.artifacts/",
  "/.runs/",
  "/.evidence/",
]);

const KIT_MANAGED_FILES = Object.freeze([
  FILE_REGISTRY_PATH,
  PROJECT_MANIFEST_PATH,
  MANAGED_LOCK_PATH,
]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonString(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function refuse(message, extra) {
  throw kitError(KIT_ERROR_KINDS.REGISTER_EXISTING_REFUSED, message, extra);
}

function splitCsv(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") {
    refuse("register-existing list options must be string arrays or comma-separated strings", {
      field: "lists",
    });
  }
  return value.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
}

function normalizeList(value, field) {
  const items = splitCsv(value);
  const normalized = [];
  const seen = new Set();
  for (const item of items) {
    if (typeof item !== "string" || item.trim().length === 0) {
      refuse(`register-existing ${field} must contain non-empty relative paths or globs`, { field });
    }
    const rel = normalizeRelPath(item.trim());
    if (rel.length === 0 || rel.startsWith("/") || rel.split("/").includes("..")) {
      refuse(`register-existing ${field} entry escapes the target root: ${item}`, { field, path: item });
    }
    if (seen.has(rel)) continue;
    seen.add(rel);
    normalized.push(rel);
  }
  normalized.sort();
  return normalized;
}

function normalizeArtifactList(value) {
  const items = splitCsv(value);
  const normalized = [];
  const seen = new Set();
  for (const item of items) {
    if (typeof item !== "string" || item.trim().length === 0) {
      refuse("register-existing artifacts must contain non-empty gitignore-style patterns", {
        field: "artifacts",
      });
    }
    const raw = item.trim().replaceAll("\\", "/").replace(/\/+/g, "/");
    if (raw.includes("\0") || raw.split("/").filter((part) => part.length > 0).includes("..")) {
      refuse(`register-existing artifacts entry escapes the target root: ${item}`, {
        field: "artifacts",
        path: item,
      });
    }
    if (seen.has(raw)) continue;
    seen.add(raw);
    normalized.push(raw);
  }
  normalized.sort();
  return normalized;
}

async function readOptionalBytes(rootAbs, rel) {
  try {
    return await readFileContained(rootAbs, rel);
  } catch {
    return null;
  }
}

async function loadValidProfile(rootAbs) {
  let bytes;
  try {
    bytes = await readFileContained(rootAbs, "profile.json");
  } catch {
    refuse("register-existing requires a readable profile.json at the target root", {
      path: "profile.json",
    });
  }
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    refuse("register-existing requires parseable JSON in profile.json", { path: "profile.json" });
  }
  const registration = findSchemaByObject("project-profile");
  if (!registration) {
    refuse("register-existing cannot resolve the project-profile contract", { path: "profile.json" });
  }
  const validation = validateDocument(value, {
    schemaId: registration.$id,
    dialect: registration.dialect,
    policy: "strict",
  });
  if (!validation.valid) {
    refuse("register-existing requires a contract-valid profile.json", {
      path: "profile.json",
      errors: validation.errors,
    });
  }
  return validation.data;
}

function assertNoClassOverlap({ handwritten, trackedToolLocks, artifacts }) {
  for (const rel of KIT_MANAGED_FILES) {
    if (handwritten.includes(rel) || matchAnyGlob(handwritten, rel)) {
      refuse(`classification overlap: kit-managed ${rel} also matches handwritten`, { path: rel });
    }
    if (trackedToolLocks.includes(rel)) {
      refuse(`classification overlap: kit-managed ${rel} also listed as trackedToolLocks`, { path: rel });
    }
    if (matchAnyGitignorePattern(artifacts, rel)) {
      refuse(`classification overlap: kit-managed ${rel} also matches artifacts`, { path: rel });
    }
  }
  for (const rel of trackedToolLocks) {
    if (handwritten.includes(rel) || matchAnyGlob(handwritten, rel)) {
      refuse(`classification overlap: trackedToolLocks ${rel} also matches handwritten`, { path: rel });
    }
    if (matchAnyGitignorePattern(artifacts, rel)) {
      refuse(`classification overlap: trackedToolLocks ${rel} also matches artifacts`, { path: rel });
    }
  }
}

async function assertTrackedToolLocksExist(rootAbs, trackedToolLocks) {
  for (const rel of trackedToolLocks) {
    const classification = classifyPathInput(rel);
    if (!classification.ok) {
      refuse(`trackedToolLocks path is not a contained project path: ${rel}`, {
        path: rel,
        kind: classification.kind,
      });
    }
    if (!isContainedDeclaration(rel)) {
      refuse(`trackedToolLocks path escapes the target root: ${rel}`, { path: rel });
    }
    let st;
    try {
      const abs = await resolveContained(rootAbs, rel);
      st = await lstat(abs);
    } catch {
      refuse(`trackedToolLocks path is missing: ${rel}`, { path: rel });
    }
    if (st.isSymbolicLink()) {
      refuse(`trackedToolLocks path is a symbolic link: ${rel}`, { path: rel });
    }
    if (!st.isFile()) {
      refuse(`trackedToolLocks path is not a regular file: ${rel}`, { path: rel });
    }
  }
}

function renderRegistry({ workspace, handwritten, artifacts, trackedToolLocks }) {
  const classes = {
    projenManaged: {
      files: [],
      note: "Existing nonempty projects keep their current toolchain; this path does not introduce projen.",
    },
    kitManaged: {
      files: [FILE_REGISTRY_PATH, PROJECT_MANIFEST_PATH, MANAGED_LOCK_PATH],
      note: "Foundation closed-world state documents generated by check register-existing / relock.",
    },
    handwritten: {
      entries: handwritten,
      note: "Caller-declared source material; tools never overwrite it.",
    },
    artifacts: {
      patterns: artifacts,
      note: "Ignored runtime/cache/evidence paths. Tracked generated products must not be listed here.",
    },
  };
  if (trackedToolLocks.length > 0) {
    classes.trackedToolLocks = {
      entries: trackedToolLocks,
      note: "Persistent tool-generated lock files; contents are not bound by the managed-file lock.",
    };
  }
  return {
    schemaVersion: 1,
    kind: "skill-family.file-registry",
    workspace,
    generatedBy: { tool: KIT_TOOL_NAME, version: KIT_VERSION },
    classes,
    rules: {
      closedWorld: "每个拟跟踪文件恰好属于 projenManaged/kitManaged/handwritten 之一；每个忽略项属于 artifacts；持久工具锁可登记 trackedToolLocks。",
      gitPolicy: "工具只生成 Git 规则文本，绝不执行任何 Git 写操作。",
    },
  };
}

function renderManifest({ projectId, projectName, profileId, engineering }) {
  const document = {
    schemaVersion: 1,
    kind: "skill-family.project-manifest",
    project: {
      id: projectId,
      name: projectName,
      description: `Skill Family project ${projectName}.`,
    },
    contracts: {
      version: CONTRACTS_VERSION,
      profile: profileId,
    },
    managedFiles: [FILE_REGISTRY_PATH, PROJECT_MANIFEST_PATH, MANAGED_LOCK_PATH],
    ...(engineering === undefined ? {} : { engineering }),
  };
  const registration = findSchemaByObject("project-manifest");
  const validation = validateDocument(document, {
    schemaId: registration.$id,
    dialect: registration.dialect,
    policy: "strict",
  });
  if (!validation.valid) {
    throw new ContractsError(validation.errorCode, "register-existing project-manifest violates its contract", {
      errors: validation.errors,
    });
  }
  if (engineering !== undefined) {
    const references = [
      ...(engineering.entries ?? []).map((entry) => entry.physicalRef),
      ...(engineering.releaseUnits ?? []).flatMap((unit) => [
        unit.versionSource.path,
        ...(unit.versionMirrors ?? []).map((mirror) => mirror.path),
      ]),
    ];
    for (const reference of references) {
      const classification = classifyPathInput(reference);
      if (!classification.ok) {
        refuse("engineering reference is not a contained project path", {
          path: reference,
          kind: classification.kind,
        });
      }
    }
  }
  return document;
}

function renderLock({ registryBytes, manifestBytes }) {
  const entries = [
    {
      path: FILE_REGISTRY_PATH,
      hash: { algorithm: "sha256", value: digestBytes(registryBytes) },
      generator: { tool: KIT_TOOL_NAME, version: KIT_VERSION },
      policy: "managed",
    },
    {
      path: PROJECT_MANIFEST_PATH,
      hash: { algorithm: "sha256", value: digestBytes(manifestBytes) },
      generator: { tool: KIT_TOOL_NAME, version: KIT_VERSION },
      policy: "managed",
    },
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    schemaVersion: 1,
    kind: "skill-family.managed-file-lock",
    lockVersion: 1,
    entries,
  };
}

function sameBytes(actual, expected) {
  return actual !== null && actual.equals(expected);
}

/**
 * Official first nonempty registration.
 * Options: { root, handwritten, engineering, artifacts, trackedToolLocks }.
 */
export async function runRegisterExisting({
  root,
  handwritten,
  engineering,
  artifacts,
  trackedToolLocks,
} = {}) {
  const rootAbs = await resolveTargetRoot(root ?? ".");
  const handwrittenList = normalizeList(handwritten, "handwritten");
  if (handwrittenList.length === 0) {
    refuse("register-existing requires a non-empty handwritten classification list", {
      field: "handwritten",
    });
  }
  const toolLocks = normalizeList(trackedToolLocks, "trackedToolLocks");
  const artifactPatterns = [...new Set([...DEFAULT_ARTIFACT_PATTERNS, ...normalizeArtifactList(artifacts)])].sort();
  assertNoClassOverlap({ handwritten: handwrittenList, trackedToolLocks: toolLocks, artifacts: artifactPatterns });
  await assertTrackedToolLocksExist(rootAbs, toolLocks);

  const profile = await loadValidProfile(rootAbs);
  const projectId = profile.project.id;
  const projectName = profile.project.workspace;
  const profileId = profile.adoption?.foundation_profile?.id;
  if (typeof profileId !== "string" || profileId.length === 0) {
    refuse("register-existing requires profile.adoption.foundation_profile.id", {
      path: "profile.json",
    });
  }

  const registryDoc = renderRegistry({
    workspace: projectName,
    handwritten: handwrittenList,
    artifacts: artifactPatterns,
    trackedToolLocks: toolLocks,
  });
  const manifestDoc = renderManifest({ projectId, projectName, profileId, engineering });
  const registryBytes = Buffer.from(jsonString(registryDoc), "utf8");
  const manifestBytes = Buffer.from(jsonString(manifestDoc), "utf8");
  const lockDoc = renderLock({ registryBytes, manifestBytes });
  const lockBytes = Buffer.from(jsonString(lockDoc), "utf8");

  const existing = {
    [FILE_REGISTRY_PATH]: await readOptionalBytes(rootAbs, FILE_REGISTRY_PATH),
    [PROJECT_MANIFEST_PATH]: await readOptionalBytes(rootAbs, PROJECT_MANIFEST_PATH),
    [MANAGED_LOCK_PATH]: await readOptionalBytes(rootAbs, MANAGED_LOCK_PATH),
  };
  const computed = {
    [FILE_REGISTRY_PATH]: registryBytes,
    [PROJECT_MANIFEST_PATH]: manifestBytes,
    [MANAGED_LOCK_PATH]: lockBytes,
  };
  const present = KIT_MANAGED_FILES.filter((rel) => existing[rel] !== null);
  const missing = KIT_MANAGED_FILES.filter((rel) => existing[rel] === null);

  if (present.length === 3 && KIT_MANAGED_FILES.every((rel) => sameBytes(existing[rel], computed[rel]))) {
    return {
      kind: REGISTER_EXISTING_REPORT_KIND,
      schemaVersion: 1,
      generatedBy: { tool: KIT_TOOL_NAME, version: KIT_VERSION },
      target: { root: "." },
      ok: true,
      mode: "idempotent",
      wrote: [],
      registry: { path: FILE_REGISTRY_PATH, sha256: digestBytes(registryBytes) },
      manifest: { path: PROJECT_MANIFEST_PATH, sha256: digestBytes(manifestBytes) },
      lock: { path: MANAGED_LOCK_PATH, sha256: digestBytes(lockBytes), lockVersion: 1 },
      policy: "rerun with identical classification is idempotent and writes nothing",
    };
  }

  if (present.length > 0) {
    const drifted = present.filter((rel) => !sameBytes(existing[rel], computed[rel]));
    refuse("register-existing refuses because closed-world documents already exist and do not match the computed registration; zero overwrite", {
      present,
      missing,
      drifted,
    });
  }

  const receipts = {};
  const publishOrder = [
    [FILE_REGISTRY_PATH, registryBytes, true],
    [PROJECT_MANIFEST_PATH, manifestBytes, false],
    [MANAGED_LOCK_PATH, lockBytes, false],
  ];
  for (const [rel, bytes, createParents] of publishOrder) {
    try {
      receipts[rel] = await publishFileExclusive(rootAbs, rel, bytes, { createParents });
    } catch (cause) {
      throw kitError(
        KIT_ERROR_KINDS.PROJECTION_WRITE_FAILED,
        `register-existing publication failed at ${rel}: ${cause?.message ?? "unknown"}`,
        {
          path: rel,
          publicationState: cause?.details?.publicationState ?? "indeterminate",
          causeKind: cause?.details?.kind ?? "unknown",
          receipts,
        },
      );
    }
  }

  return {
    kind: REGISTER_EXISTING_REPORT_KIND,
    schemaVersion: 1,
    generatedBy: { tool: KIT_TOOL_NAME, version: KIT_VERSION },
    target: { root: "." },
    ok: true,
    mode: "created",
    wrote: [...KIT_MANAGED_FILES],
    registry: {
      path: FILE_REGISTRY_PATH,
      sha256: receipts[FILE_REGISTRY_PATH].sha256,
      publicationState: receipts[FILE_REGISTRY_PATH].publicationState,
    },
    manifest: {
      path: PROJECT_MANIFEST_PATH,
      sha256: receipts[PROJECT_MANIFEST_PATH].sha256,
      publicationState: receipts[PROJECT_MANIFEST_PATH].publicationState,
    },
    lock: {
      path: MANAGED_LOCK_PATH,
      sha256: receipts[MANAGED_LOCK_PATH].sha256,
      publicationState: receipts[MANAGED_LOCK_PATH].publicationState,
      lockVersion: 1,
    },
    policy:
      "register-existing is one fail-closed transaction: validation completes before the first write; existing mismatched documents refuse with zero overwrite; identical documents are idempotent",
  };
}

export async function registerExistingAction(options) {
  const output = await runRegisterExisting(options);
  return { status: "ok", output };
}
