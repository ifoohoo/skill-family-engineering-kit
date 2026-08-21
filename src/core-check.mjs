import { lstat } from "node:fs/promises";
import path from "node:path";
import { KIT_ERROR_KINDS } from "./errors.mjs";
import { CHECK_CLASSES, runChecks } from "./check.mjs";
import {
  IDENTITY_RECORD_PATH,
  MANAGED_LOCK_PATH,
  PLATFORM_SUBSET_DECLARATION_PATH,
  PROJECT_MANIFEST_PATH,
  PUBLIC_BOUNDARY_DECLARATION_PATH,
} from "./skeleton.mjs";
import {
  listTargetEntries,
  loadTargetFacts,
  matchAnyGitignorePattern,
  matchAnyGlob,
  resolveTargetRoot,
} from "./workspace.mjs";

/**
 * runCoreCheck — the single shared production entry of the closed-world
 * project check (C2).
 *
 * The generated `scripts/check-core.mjs` entrypoints of scaffolded projects
 * ONLY import this function: safe file-tree enumeration, lstat/symlink/FIFO
 * and special-entry rejection, file-registry classification (managed /
 * handwritten / artifact closed world), declaration path containment, the
 * nine check classes, and the stable finding/exit mapping all live here and
 * nowhere else. No generated string may re-derive a recursive walk, an lstat
 * classification, a glob match, or a local closed-world algorithm.
 *
 * Stages (all read-only; never opens a file before it is lstat-classified):
 *   1. declaration containment — escaping managed declarations (absolute
 *      paths, `..` segments) are reported lexically and never touch the fs;
 *   2. managed preflight — lstat only: missing / symlink / non-regular
 *      managed paths fail closed before anything could read them;
 *   3. tree enumeration — every symlink and special entry fails closed;
 *      every regular file must belong to the registered closed world
 *      (managed, handwritten, artifact, or a tracked tool lock);
 *   4. the nine check classes through runChecks — skipped whenever an
 *      unsafe path (symlink/special at a managed or class-read path) would
 *      be opened by them: FIFOs must never be read (they block), symlinks
 *      must never be followed.
 *
 * Exit mapping: 0 clean; 2 when any finding carries a security kind
 * (CORE_CHECK_SECURITY_KINDS, including the harness containment kinds that
 * can surface through escaping lock entries); 1 otherwise.
 */

/** Finding kinds that always map to the security exit code 2. */
export const CORE_CHECK_SECURITY_KINDS = Object.freeze([
  // Kit kinds of this entry.
  KIT_ERROR_KINDS.SYMLINK_AT_MANAGED_PATH,
  KIT_ERROR_KINDS.NOT_A_REGULAR_FILE,
  KIT_ERROR_KINDS.SYMLINK_ENTRY,
  KIT_ERROR_KINDS.SPECIAL_ENTRY,
  KIT_ERROR_KINDS.UNCONTAINED_DECLARATION,
  // Stable harness containment kinds that surface through drift findings when
  // a lock entry tries to escape the target (reported, never followed).
  "absolute-path",
  "windows-drive-path",
  "windows-path",
  "unc-path",
  "path-traversal",
  "symlink-escape",
  "realpath-escape",
  "invalid-path",
]);

const CORE_CLASS = "core";

/**
 * Paths the nine check classes open by name. They take part in the unsafe
 * read-set even when they are not declared managed (README.md is handwritten
 * in the skeleton), so a symlink/FIFO there can never hang or escape a read.
 */
const CLASS_READ_PATHS = Object.freeze([
  "README.md",
  "package.json",
  PROJECT_MANIFEST_PATH,
  MANAGED_LOCK_PATH,
  IDENTITY_RECORD_PATH,
  "identity-record.json",
  PUBLIC_BOUNDARY_DECLARATION_PATH,
  PLATFORM_SUBSET_DECLARATION_PATH,
]);

/** Lexical containment of a managed declaration; never touches the fs. */
export function isContainedDeclaration(rel) {
  if (typeof rel !== "string" || rel.length === 0) return false;
  if (rel.startsWith("/")) return false;
  if (rel.split("/").includes("..")) return false;
  return true;
}

/**
 * Runs the unified closed-world check over one target.
 * Options: { root, allowGitSpawn, profilesRoot }.
 * Returns { kind, ok, exitCode, findings, classes, unsafeReadPaths }.
 * Never writes anywhere.
 */
export async function runCoreCheck({ root, allowGitSpawn = true, profilesRoot } = {}) {
  const rootAbs = await resolveTargetRoot(root ?? ".");
  const facts = await loadTargetFacts(rootAbs);
  const findings = [];
  const push = (kind, message, extra) =>
    findings.push({ class: CORE_CLASS, kind, code: "SFC2004", message, ...(extra ?? {}) });

  // ---- Stage 1: declaration containment (purely lexical) -----------------
  const declarations = [...facts.managedSet].sort();
  const containedDeclarations = [];
  for (const rel of declarations) {
    if (isContainedDeclaration(rel)) {
      containedDeclarations.push(rel);
    } else {
      push(
        KIT_ERROR_KINDS.UNCONTAINED_DECLARATION,
        `managed declaration escapes the target root (absolute path or '..' segment): ${rel}`,
        { path: rel },
      );
    }
  }

  // ---- Stage 2: managed preflight (lstat only, never open/read) ----------
  const unsafeReadPaths = new Set();
  for (const rel of containedDeclarations) {
    let st;
    try {
      st = await lstat(path.join(rootAbs, rel));
    } catch {
      push(
        KIT_ERROR_KINDS.MANAGED_FILE_MISSING,
        `managed file declared in the registry/manifest/lock does not exist: ${rel}`,
        { path: rel },
      );
      continue;
    }
    if (st.isSymbolicLink()) {
      push(KIT_ERROR_KINDS.SYMLINK_AT_MANAGED_PATH, `managed path is a symbolic link: ${rel}`, { path: rel });
      unsafeReadPaths.add(rel);
    } else if (!st.isFile()) {
      push(
        KIT_ERROR_KINDS.NOT_A_REGULAR_FILE,
        `managed path is not a regular file (FIFO/socket/device/directory): ${rel}`,
        { path: rel },
      );
      unsafeReadPaths.add(rel);
    }
  }

  // ---- Stage 3: safe tree enumeration + closed-world classification ------
  const entries = await listTargetEntries(rootAbs);
  for (const entry of entries) {
    if (entry.kind === "directory" || entry.kind === "directory-opaque") continue;
    if (entry.kind === "symlink") {
      // Symlinks are never classified by content patterns: unregistered ones
      // fail closed; managed ones were already reported by the preflight.
      if (!facts.managedSet.has(entry.path)) {
        push(
          KIT_ERROR_KINDS.SYMLINK_ENTRY,
          `symbolic link is outside the registered closed world (managed/handwritten/artifact): ${entry.path}`,
          { path: entry.path },
        );
      }
      if (facts.managedSet.has(entry.path) || CLASS_READ_PATHS.includes(entry.path)) {
        unsafeReadPaths.add(entry.path);
      }
      continue;
    }
    if (entry.kind === "special") {
      if (!facts.managedSet.has(entry.path)) {
        push(
          KIT_ERROR_KINDS.SPECIAL_ENTRY,
          `special entry (FIFO/socket/device) is outside the registered closed world: ${entry.path}`,
          { path: entry.path },
        );
      }
      if (facts.managedSet.has(entry.path) || CLASS_READ_PATHS.includes(entry.path)) {
        unsafeReadPaths.add(entry.path);
      }
      continue;
    }
    // Regular files must belong to exactly one registered class. Managed
    // bytes are verified by the drift class, never re-derived here.
    if (facts.managedSet.has(entry.path)) continue;
    if (matchAnyGlob(facts.handwrittenPatterns, entry.path)) continue;
    if (matchAnyGitignorePattern(facts.artifactPatterns, entry.path)) continue;
    if (facts.trackedToolLocks.includes(entry.path)) continue;
    push(
      KIT_ERROR_KINDS.UNREGISTERED_FILE,
      `regular file is not registered in the closed world (managed/handwritten/artifact): ${entry.path}`,
      { path: entry.path },
    );
  }

  // ---- Stage 4: the nine check classes through the shared entry ---------
  let classReport = null;
  if (unsafeReadPaths.size === 0) {
    classReport = await runChecks({ root: rootAbs, allowGitSpawn, profilesRoot });
    findings.push(...classReport.findings);
  }

  let exitCode = 0;
  if (findings.length > 0) {
    const securityKinds = new Set(CORE_CHECK_SECURITY_KINDS);
    exitCode = findings.some((f) => securityKinds.has(f.kind)) ? 2 : 1;
  }
  if (classReport && classReport.mechanism) exitCode = 2;

  return {
    kind: "skill-family.core-check-report",
    schemaVersion: 1,
    target: { root: ".", entryCount: entries.length },
    ok: findings.length === 0,
    exitCode,
    findings,
    classes:
      classReport?.classes ??
      CHECK_CLASSES.map((name) => ({ name, selected: false, completed: false, findings: 0 })),
    classChecksSkipped:
      unsafeReadPaths.size > 0
        ? { reason: "unsafe read-set (symlink/special at a managed or class-read path)", paths: [...unsafeReadPaths].sort() }
        : null,
    policy:
      "core check is diagnosis only: it enumerates with lstat, never opens an unclassified entry, never follows symlinks, and never writes",
  };
}
