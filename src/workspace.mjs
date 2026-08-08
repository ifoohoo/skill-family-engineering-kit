import { lstat, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { KIT_ERROR_KINDS, kitError } from "./errors.mjs";

/**
 * Read-only introspection of one target workspace.
 *
 * Everything here only reads. Absolute paths are resolved once at the edge
 * (resolveTargetRoot); every deeper access goes through the harness
 * containment layer with root-relative paths, so no introspection can ever
 * be pointed outside the target.
 */

/** Files the bounded walk never descends into (opaque tooling state). */
export const OPAQUE_DIRECTORIES = Object.freeze([".git", "node_modules"]);

/**
 * Default handwritten patterns for targets that carry no file registry of
 * their own. Mirrors the three-class file registration of the foundation
 * workspace: what is obviously hand-maintained source material is never
 * treated as a re-projectable managed artifact.
 */
export const DEFAULT_HANDWRITTEN_PATTERNS = Object.freeze([
  "**/*.md",
  ".projenrc.js",
  "src/**",
  "docs/**",
  "test/**",
  "tests/**",
  "fixtures/**",
  "profiles/**",
  "scripts/**",
]);

/**
 * Resolves and validates the target root directory.
 * Returns the absolute path. Throws KitError (invalid-root /
 * target-not-directory) when the root is unusable.
 */
export async function resolveTargetRoot(rootInput) {
  if (typeof rootInput !== "string" || rootInput.length === 0) {
    throw kitError(KIT_ERROR_KINDS.INVALID_ROOT, "target root must be a non-empty path string");
  }
  const root = path.resolve(rootInput);
  let st;
  try {
    st = await lstat(root);
  } catch {
    throw kitError(
      KIT_ERROR_KINDS.INVALID_ROOT,
      "target root does not exist",
      { root: "<opaque>" },
    );
  }
  if (st.isSymbolicLink()) {
    // A symlinked root is followed by every later fs call; accept it only
    // when it resolves to a directory (checked via stat, which follows).
    try {
      const real = await stat(root);
      if (!real.isDirectory()) {
        throw kitError(KIT_ERROR_KINDS.TARGET_NOT_DIRECTORY, "target root resolves to a non-directory");
      }
    } catch (cause) {
      if (cause instanceof Error && cause.details) throw cause;
      throw kitError(KIT_ERROR_KINDS.TARGET_NOT_DIRECTORY, "target root is a symbolic link that does not resolve");
    }
    return root;
  }
  if (!st.isDirectory()) {
    throw kitError(KIT_ERROR_KINDS.TARGET_NOT_DIRECTORY, "target root exists but is not a directory");
  }
  return root;
}

/**
 * Recursively lists entries under root (relative POSIX paths, sorted).
 * Read-only: uses readdir/lstat only, never follows directory symlinks, and
 * skips opaque tooling directories. Symlinked files are reported with
 * kind "symlink".
 */
export async function listTargetEntries(root) {
  const entries = [];
  async function walk(absDir, relBase) {
    const dirents = await readdir(absDir, { withFileTypes: true });
    for (const dirent of dirents) {
      const rel = relBase === "" ? dirent.name : `${relBase}/${dirent.name}`;
      if (dirent.isDirectory() && !dirent.isSymbolicLink()) {
        if (OPAQUE_DIRECTORIES.includes(dirent.name)) {
          // .git / node_modules are opaque at every depth: recorded as an
          // entry, never descended into (matches the foundation tooling).
          entries.push({ path: rel, kind: "directory-opaque" });
          continue;
        }
        entries.push({ path: rel, kind: "directory" });
        await walk(path.join(absDir, dirent.name), rel);
        continue;
      }
      if (dirent.isSymbolicLink()) {
        entries.push({ path: rel, kind: "symlink" });
        continue;
      }
      if (dirent.isFile()) {
        entries.push({ path: rel, kind: "file" });
      }
    }
  }
  await walk(root, "");
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}

/** Reads one contained file as utf8; missing files return null. */
export async function readOptionalFile(root, relPath) {
  try {
    return await readFile(path.join(root, relPath), "utf8");
  } catch (cause) {
    if (cause && cause.code === "ENOENT") return null;
    throw cause;
  }
}

/** Parses one contained JSON file; returns { ok, value } or { ok:false, reason }. */
export async function readOptionalJson(root, relPath) {
  const text = await readOptionalFile(root, relPath);
  if (text === null) return { ok: false, reason: "missing" };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, reason: "parse-failed" };
  }
}

/**
 * Minimal glob matcher for file-registry style patterns.
 * Supported per-segment forms: literal, `*` (any chars except separator),
 * and the multi-segment wildcard `**`. Matching is purely lexical.
 */
export function matchGlob(pattern, relPath) {
  if (typeof pattern !== "string" || typeof relPath !== "string") return false;
  const patternSegments = pattern.split("/").filter((segment) => segment !== "");
  const pathSegments = relPath.split("/").filter((segment) => segment !== "");
  return matchSegments(patternSegments, 0, pathSegments, 0);
}

function segmentToRegExp(segment) {
  let expression = "";
  for (const char of segment) {
    if (char === "*") expression += "[^/]*";
    else expression += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${expression}$`);
}

function matchSegments(patternSegments, pi, pathSegments, si) {
  if (pi === patternSegments.length) return si === pathSegments.length;
  const segment = patternSegments[pi];
  if (segment === "**") {
    for (let take = 0; si + take <= pathSegments.length; take += 1) {
      if (matchSegments(patternSegments, pi + 1, pathSegments, si + take)) return true;
    }
    return false;
  }
  if (si === pathSegments.length) return false;
  if (!segmentToRegExp(segment).test(pathSegments[si])) return false;
  return matchSegments(patternSegments, pi + 1, pathSegments, si + 1);
}

export function matchAnyGlob(patterns, relPath) {
  return Array.isArray(patterns) && patterns.some((pattern) => matchGlob(pattern, relPath));
}

/** Normalizes a relative path to forward slashes without touching the fs. */
export function normalizeRelPath(relPath) {
  return String(relPath).replaceAll("\\", "/").replace(/\/+/g, "/").replace(/^\.\//, "");
}

/**
 * Loads the target's own authorization and classification facts:
 * - `.foundation/file-registry.json` (managed list + handwritten patterns)
 * - `skill-family.project-manifest.json` (managedFiles declaration)
 * - `skill-family.managed-file-lock.json` (locked managed paths)
 * All reads are optional and read-only; malformed documents simply do not
 * contribute facts (the check command reports them separately).
 */
export async function loadTargetFacts(root) {
  const facts = {
    fileRegistry: null,
    projectManifest: null,
    managedLock: null,
    managedSet: new Set(),
    handwrittenPatterns: [...DEFAULT_HANDWRITTEN_PATTERNS],
    hasOwnRegistry: false,
  };

  const registry = await readOptionalJson(root, path.join(".foundation", "file-registry.json"));
  if (registry.ok && registry.value && typeof registry.value === "object") {
    facts.fileRegistry = registry.value;
    facts.hasOwnRegistry = true;
    const managed = registry.value?.classes?.managed;
    if (Array.isArray(managed)) {
      for (const entry of managed) {
        if (typeof entry === "string") facts.managedSet.add(normalizeRelPath(entry));
      }
    }
    const patterns = registry.value?.classes?.handwritten?.entries;
    if (Array.isArray(patterns) && patterns.length > 0) {
      facts.handwrittenPatterns = patterns.filter((entry) => typeof entry === "string");
    }
  }

  const manifest = await readOptionalJson(root, "skill-family.project-manifest.json");
  if (manifest.ok && manifest.value && typeof manifest.value === "object") {
    facts.projectManifest = manifest.value;
    const managedFiles = manifest.value.managedFiles;
    if (Array.isArray(managedFiles)) {
      for (const entry of managedFiles) {
        if (typeof entry === "string") facts.managedSet.add(normalizeRelPath(entry));
      }
    }
  }

  const lock = await readOptionalJson(root, "skill-family.managed-file-lock.json");
  if (lock.ok && lock.value && typeof lock.value === "object") {
    facts.managedLock = lock.value;
    const entries = lock.value.entries;
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        if (entry && typeof entry.path === "string") {
          facts.managedSet.add(normalizeRelPath(entry.path));
        }
      }
    }
  }

  return facts;
}
