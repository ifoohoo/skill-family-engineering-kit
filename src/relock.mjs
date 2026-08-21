import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { digestBytes, publishFileOrReplace, resolveContained } from "skill-family-harness-node";
import { KIT_ERROR_KINDS, kitError } from "./errors.mjs";
import { KIT_TOOL_NAME, KIT_VERSION } from "./skeleton.mjs";
import { FILE_REGISTRY_PATH, MANAGED_LOCK_PATH } from "./skeleton.mjs";
import {
  isContainedDeclaration,
} from "./core-check.mjs";
import {
  listTargetEntries,
  loadTargetFacts,
  matchAnyGitignorePattern,
  matchAnyGlob,
  normalizeRelPath,
  resolveTargetRoot,
} from "./workspace.mjs";

/**
 * runRelock — the controlled relock channel (SG-36; audit friction F5).
 *
 * Before this sub-action existed, the closed world had no legal channel for
 * newly handwritten files: adding one at the target root surfaced as an
 * `unregistered-file` finding, while hand-editing the closed-world registry
 * to register it drifted the managed-file-lock entry that binds the registry
 * itself — a structural deadlock in which every fix attempt created the next
 * violation. Relock breaks the deadlock with one transactional sub-action:
 * register the new handwritten files into `.foundation/file-registry.json`
 * AND recompute `skill-family.managed-file-lock.json` from the current bytes
 * of every managed file, in a single fail-closed operation.
 *
 * Transaction discipline:
 *   1. ALL reads and ALL validation happen before the first write. Any
 *      refusal (escaping/invalid path, non-regular or missing candidate,
 *      candidate already registered, absent/unparseable registry, lock drift
 *      conflict, lock entry escaping the target) leaves the target untouched.
 *   2. The complete new registry and the complete new lock are computed in
 *      memory first — the new lock already binds the new registry bytes, so
 *      the two documents are mutually consistent before either is written.
 *   3. Writes happen in dependency order (registry first, lock second), each
 *      through the harness strict publication primitive (staging + fsync +
 *      verified rename, symlinks refused). A failure after the first commit
 *      propagates the harness publicationState; the resulting drift between
 *      the committed registry and the stale lock is mechanically detectable
 *      by the drift class — a half-updated state is never presented as
 *      success.
 *
 * Lock recomputation rules (fail closed on any conflict):
 *   - every surviving lock entry must stay contained, bind a path still
 *     declared managed, and its locked hash must equal the current bytes of
 *     that file (a drifted managed file means someone hand-edited outside
 *     the managed channel: relock refuses to legitimize it);
 *   - every managed declaration must be lockable (present, regular file);
 *   - the lock never binds itself; lockVersion is bumped by one; an absent
 *     or unparseable lock is refused (relock recomputes, it never seeds);
 *   - entries are sorted by path, hashed with the frozen sha256 algorithm,
 *     and carry the relock tool/version generator.
 *
 * Registration rules: each candidate is appended verbatim to the registry's
 * `classes.handwritten.entries` (handwritten source material — never to a
 * managed class, so it never becomes re-projectable). A candidate is refused
 * when it escapes the root, fails the frozen lock path shape, is not an
 * existing regular file, or is already admitted by any closed-world class.
 *
 * Options: { root, files } where `files` is the explicit registration list;
 * a null/empty list auto-discovers the unregistered regular files exactly as
 * the closed-world stage of the core check classifies them (symlinks and
 * special entries are never registerable and refuse the transaction).
 *
 * Returns the relock report document; throws KitError/HarnessError for every
 * refusal (CLI exit 2). Never writes outside the two state documents.
 */

/** Frozen lock entry path shape (managed-file-lock.schema.json, v1). */
export const RELOCK_LOCK_PATH_PATTERN = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
export const RELOCK_REPORT_KIND = "skill-family.relock-report";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function refuse(kind, message, extra) {
  throw kitError(kind, message, extra);
}

function jsonString(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function statContained(rootAbs, rel) {
  const abs = await resolveContained(rootAbs, rel);
  return lstat(abs);
}

async function readContainedBytes(rootAbs, rel) {
  const abs = await resolveContained(rootAbs, rel);
  return readFile(abs);
}

/**
 * Runs the controlled relock transaction over one target.
 * Returns the relock report; throws on every refusal (fail closed).
 */
export async function runRelock({ root, files = null } = {}) {
  const rootAbs = await resolveTargetRoot(root ?? ".");
  const facts = await loadTargetFacts(rootAbs);

  // ---- candidate selection ------------------------------------------------
  let candidates;
  let mode;
  if (files === null || (Array.isArray(files) && files.length === 0)) {
    mode = "auto-discover";
    // The exact unregistered predicate of the core check's closed-world
    // stage: regular files in no registered class.
    const entries = await listTargetEntries(rootAbs);
    candidates = [];
    for (const entry of entries) {
      if (entry.kind !== "file") continue;
      if (facts.managedSet.has(entry.path)) continue;
      if (matchAnyGlob(facts.handwrittenPatterns, entry.path)) continue;
      if (matchAnyGitignorePattern(facts.artifactPatterns, entry.path)) continue;
      if (facts.trackedToolLocks.includes(entry.path)) continue;
      candidates.push(entry.path);
    }
  } else {
    if (!Array.isArray(files)) {
      refuse(KIT_ERROR_KINDS.RELOCK_REGISTRATION_REFUSED, "relock files must be an array of relative paths", {
        field: "files",
      });
    }
    mode = "explicit";
    candidates = files.map((entry) => normalizeRelPath(entry));
  }
  candidates = [...new Set(candidates)].sort();

  // ---- candidate validation (all before any write) --------------------------
  for (const rel of candidates) {
    if (!isContainedDeclaration(rel) || !RELOCK_LOCK_PATH_PATTERN.test(rel)) {
      refuse(
        KIT_ERROR_KINDS.RELOCK_REGISTRATION_REFUSED,
        `relock refuses a candidate outside the contained lock path shape: ${rel}`,
        { path: rel },
      );
    }
    let st;
    try {
      st = await statContained(rootAbs, rel);
    } catch (cause) {
      const kind = cause?.details?.kind;
      refuse(
        KIT_ERROR_KINDS.RELOCK_REGISTRATION_REFUSED,
        `relock cannot safely stat candidate ${rel} inside the target (kind: ${kind ?? cause?.code ?? "unknown"})`,
        { path: rel, causeKind: kind ?? cause?.code ?? "unknown" },
      );
    }
    if (st.isSymbolicLink()) {
      refuse(KIT_ERROR_KINDS.RELOCK_REGISTRATION_REFUSED, `relock refuses a symbolic-link candidate: ${rel}`, {
        path: rel,
      });
    }
    if (!st.isFile()) {
      refuse(KIT_ERROR_KINDS.RELOCK_REGISTRATION_REFUSED, `relock candidate is not a regular file: ${rel}`, {
        path: rel,
      });
    }
    // Already admitted by any closed-world class: registration is refused so
    // relock can never re-register managed, artifact, or tool-lock paths.
    if (
      facts.managedSet.has(rel) ||
      matchAnyGlob(facts.handwrittenPatterns, rel) ||
      matchAnyGitignorePattern(facts.artifactPatterns, rel) ||
      facts.trackedToolLocks.includes(rel)
    ) {
      refuse(
        KIT_ERROR_KINDS.RELOCK_REGISTRATION_REFUSED,
        `relock candidate is already registered in the closed world (managed/handwritten/artifact/tracked-tool-lock): ${rel}`,
        { path: rel },
      );
    }
    if (rel === MANAGED_LOCK_PATH || rel === FILE_REGISTRY_PATH) {
      refuse(KIT_ERROR_KINDS.RELOCK_REGISTRATION_REFUSED, `relock refuses to register its own state document: ${rel}`, {
        path: rel,
      });
    }
  }

  // ---- registry: load, extend ------------------------------------------------
  const registryAbs = await resolveContained(rootAbs, FILE_REGISTRY_PATH);
  let registryText;
  try {
    registryText = await readFile(registryAbs, "utf8");
  } catch {
    refuse(
      KIT_ERROR_KINDS.RELOCK_REGISTRATION_REFUSED,
      `relock requires the closed-world registry ${FILE_REGISTRY_PATH}: absent or unreadable`,
      { path: FILE_REGISTRY_PATH },
    );
  }
  let registryDoc;
  try {
    registryDoc = JSON.parse(registryText);
  } catch {
    refuse(KIT_ERROR_KINDS.RELOCK_REGISTRATION_REFUSED, `relock requires a parseable closed-world registry: ${FILE_REGISTRY_PATH}`, {
      path: FILE_REGISTRY_PATH,
    });
  }
  if (!isPlainObject(registryDoc) || !isPlainObject(registryDoc.classes)) {
    refuse(KIT_ERROR_KINDS.RELOCK_REGISTRATION_REFUSED, `relock requires a registry document with a classes object: ${FILE_REGISTRY_PATH}`, {
      path: FILE_REGISTRY_PATH,
    });
  }
  if (!isPlainObject(registryDoc.classes.handwritten) || !Array.isArray(registryDoc.classes.handwritten.entries)) {
    refuse(
      KIT_ERROR_KINDS.RELOCK_REGISTRATION_REFUSED,
      `relock requires a classes.handwritten.entries array to register into: ${FILE_REGISTRY_PATH}`,
      { path: FILE_REGISTRY_PATH },
    );
  }
  const newRegistryDoc = JSON.parse(JSON.stringify(registryDoc));
  newRegistryDoc.classes.handwritten.entries = [...newRegistryDoc.classes.handwritten.entries, ...candidates];
  const registryBytes = Buffer.from(jsonString(newRegistryDoc), "utf8");

  // ---- lock: validate the surviving state, then recompute --------------------
  const lock = facts.managedLock;
  if (lock === null) {
    refuse(
      KIT_ERROR_KINDS.RELOCK_LOCK_DRIFT,
      `relock requires an existing parseable managed-file lock: ${MANAGED_LOCK_PATH} (an absent or unparseable lock is refused, never seeded)`,
      { path: MANAGED_LOCK_PATH },
    );
  }
  if (!isPlainObject(lock) || lock.kind !== "skill-family.managed-file-lock" || lock.schemaVersion !== 1) {
    refuse(KIT_ERROR_KINDS.RELOCK_LOCK_DRIFT, `relock refuses an unrecognized lock document: ${MANAGED_LOCK_PATH}`, {
      path: MANAGED_LOCK_PATH,
    });
  }
  if (!Number.isInteger(lock.lockVersion) || lock.lockVersion < 1) {
    refuse(KIT_ERROR_KINDS.RELOCK_LOCK_DRIFT, `relock refuses a lock with a non-positive lockVersion: ${MANAGED_LOCK_PATH}`, {
      path: MANAGED_LOCK_PATH,
    });
  }
  const lockVersion = lock.lockVersion + 1;
  const entries = Array.isArray(lock.entries) ? lock.entries : [];
  for (const entry of entries) {
    const rel = isPlainObject(entry) && typeof entry.path === "string" ? entry.path : null;
    if (rel === null) {
      refuse(KIT_ERROR_KINDS.RELOCK_LOCK_DRIFT, `relock refuses a lock entry without a string path: ${MANAGED_LOCK_PATH}`, {
        path: MANAGED_LOCK_PATH,
      });
    }
    if (!isContainedDeclaration(rel)) {
      refuse(KIT_ERROR_KINDS.RELOCK_LOCK_DRIFT, `relock refuses a lock entry escaping the target root: ${rel}`, {
        path: rel,
      });
    }
    if (rel === MANAGED_LOCK_PATH) {
      refuse(KIT_ERROR_KINDS.RELOCK_LOCK_DRIFT, "relock refuses a lock entry binding the lock document itself", {
        path: rel,
      });
    }
    if (!facts.managedSet.has(rel)) {
      refuse(
        KIT_ERROR_KINDS.RELOCK_LOCK_DRIFT,
        `relock refuses a lock entry no longer declared managed by the closed world: ${rel}`,
        { path: rel },
      );
    }
    const lockedHash = isPlainObject(entry?.hash) ? entry.hash.value : null;
    let currentBytes;
    try {
      currentBytes = await readContainedBytes(rootAbs, rel);
    } catch {
      refuse(KIT_ERROR_KINDS.RELOCK_LOCK_DRIFT, `relock cannot read a locked managed file: ${rel}`, { path: rel });
    }
    if (lockedHash !== digestBytes(currentBytes)) {
      refuse(
        KIT_ERROR_KINDS.RELOCK_LOCK_DRIFT,
        `relock refuses to relock over drifted managed bytes: ${rel} no longer matches its locked sha256 (hand-edit outside the managed channel must be reconciled first)`,
        { path: rel, lockedHash, actualHash: digestBytes(currentBytes) },
      );
    }
  }

  // Every managed declaration must be lockable from current bytes. The
  // registry itself is excluded here: its lock entry is appended below from
  // the in-memory NEW registry bytes, and the sorted dedup keeps the first
  // of two adjacent same-path entries — so a disk-derived registry entry
  // would shadow the new bytes and the fresh lock would drift immediately.
  const lockTargets = [...facts.managedSet]
    .filter((rel) => rel !== MANAGED_LOCK_PATH && rel !== FILE_REGISTRY_PATH)
    .sort();
  const newEntries = [];
  for (const rel of lockTargets) {
    if (!isContainedDeclaration(rel)) {
      refuse(KIT_ERROR_KINDS.RELOCK_LOCK_DRIFT, `relock refuses a managed declaration escaping the target root: ${rel}`, {
        path: rel,
      });
    }
    let bytes;
    try {
      bytes = await readContainedBytes(rootAbs, rel);
    } catch {
      refuse(KIT_ERROR_KINDS.RELOCK_LOCK_DRIFT, `relock cannot read a declared managed file for locking: ${rel}`, {
        path: rel,
      });
    }
    newEntries.push({
      path: rel,
      hash: { algorithm: "sha256", value: digestBytes(bytes) },
      generator: { tool: KIT_TOOL_NAME, version: KIT_VERSION },
      policy: "managed",
    });
  }
  if (newEntries.length === 0) {
    refuse(KIT_ERROR_KINDS.RELOCK_LOCK_DRIFT, "relock refuses to produce an empty lock (schema requires at least one entry)", {
      path: MANAGED_LOCK_PATH,
    });
  }
  newEntries.push({
    path: FILE_REGISTRY_PATH,
    hash: { algorithm: "sha256", value: digestBytes(registryBytes) },
    generator: { tool: KIT_TOOL_NAME, version: KIT_VERSION },
    policy: "managed",
  });
  newEntries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  // Deduplicate by path (managed declarations may overlap across sources);
  // the sorted order keeps this deterministic.
  const dedupedEntries = [];
  for (const entry of newEntries) {
    if (dedupedEntries.length > 0 && dedupedEntries[dedupedEntries.length - 1].path === entry.path) continue;
    dedupedEntries.push(entry);
  }
  const newLockDoc = {
    schemaVersion: 1,
    kind: "skill-family.managed-file-lock",
    lockVersion,
    entries: dedupedEntries,
  };
  const lockBytes = Buffer.from(jsonString(newLockDoc), "utf8");

  // ---- commit phase: registry first, lock second (fail closed) ------------
  const registryReceipt = await publishFileOrReplace(rootAbs, FILE_REGISTRY_PATH, registryBytes);
  let lockReceipt;
  try {
    lockReceipt = await publishFileOrReplace(rootAbs, MANAGED_LOCK_PATH, lockBytes);
  } catch (cause) {
    // The registry commit already happened: do not mask it. The harness
    // publicationState makes the partial state explicit; the drift class will
    // mechanically detect the stale lock. Never claim success from here.
    throw kitError(
      KIT_ERROR_KINDS.PROJECTION_WRITE_FAILED,
      `relock committed the registry but the lock publication failed: ${cause?.message ?? "unknown"}`,
      {
        registryReceipt,
        publicationState: cause?.details?.publicationState ?? "indeterminate",
        causeKind: cause?.details?.kind ?? "unknown",
      },
    );
  }

  return {
    kind: RELOCK_REPORT_KIND,
    schemaVersion: 1,
    generatedBy: { tool: KIT_TOOL_NAME, version: KIT_VERSION },
    target: { root: "." },
    ok: true,
    mode,
    registered: candidates,
    registry: {
      path: FILE_REGISTRY_PATH,
      sha256: registryReceipt.sha256,
      bytes: registryReceipt.bytes,
      publicationState: registryReceipt.publicationState,
    },
    lock: {
      path: MANAGED_LOCK_PATH,
      lockVersion,
      entryCount: dedupedEntries.length,
      sha256: lockReceipt.sha256,
      bytes: lockReceipt.bytes,
      publicationState: lockReceipt.publicationState,
    },
    policy:
      "relock is one fail-closed transaction: every validation runs before the first write; the new lock binds the new registry bytes before either document is committed; a mid-transaction failure is reported with its harness publicationState and is mechanically detectable by the drift class, never presented as success",
  };
}

/**
 * CLI sub-action wrapper (positioned as `check relock`, parallel to
 * `check entries`). Returns { status, output }; every refusal throws and
 * the CLI maps it to exit 2 — relock has no findings state: it either
 * commits the whole transaction or refuses with zero writes.
 */
export async function relockAction({ root, files = null } = {}) {
  const output = await runRelock({ root, files });
  return { status: "ok", output };
}
