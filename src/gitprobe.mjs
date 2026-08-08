import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Read-only Git pre-state diagnosis.
 *
 * The kit never performs Git writes. Diagnosis uses two layers:
 *
 * 1. Filesystem facts (no process is spawned at all): does `.git` exist,
 *    and does HEAD resolve to a commit? This layer works without the git
 *    binary and can never have a side effect.
 *
 * 2. One optional read-only `git status` query, strictly confined to the
 *    frozen argument vector GIT_STATUS_ARGS. GIT_OPTIONAL_LOCKS=0 and
 *    --no-optional-locks keep git from refreshing the index, and
 *    core.fsmonitor is disabled so no fsmonitor state is written. The
 *    spawn is best-effort: any failure (no binary, timeout, unreadable
 *    repository) degrades to filesystem facts with cleanState "unknown".
 *
 * The result is data for plans and check reports; it is never used to
 * decide whether a write happens (writes are bounded by manifests and
 * containment alone).
 */

/** The single frozen read-only argument vector the kit may spawn. */
export const GIT_STATUS_ARGS = Object.freeze([
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "status",
  "--porcelain=2",
]);

/** Frozen read-only vector listing the index (tracked) paths. */
export const GIT_LS_FILES_ARGS = Object.freeze([
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "ls-files",
  "-z",
]);

/**
 * Frozen read-only vector asking git's own ignore machinery which of the
 * NUL-separated stdin paths are ignored. Real ignore semantics:
 * globs, directory rules, negations and nested .gitignore files are all
 * decided by git itself, never by a lexical reimplementation.
 *
 * --no-index evaluates the ignore rules purely: without it git skips
 * index-tracked paths entirely, which would hide the tracked-but-ignored
 * hazard. Rule files (.gitignore at every level, $GIT_DIR/info/exclude,
 * core.excludesFile) stay authoritative; only the index filter is removed.
 */
export const GIT_CHECK_IGNORE_ARGS = Object.freeze([
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "check-ignore",
  "-z",
  "--no-index",
  "--stdin",
]);

/** Every git invocation the kit is allowed to make (read-only verbs only). */
export const GIT_READ_ONLY_ALLOWLIST = Object.freeze([
  GIT_STATUS_ARGS,
  GIT_LS_FILES_ARGS,
  GIT_CHECK_IGNORE_ARGS,
]);

const PROBE_TIMEOUT_MS = 10_000;

function gitSpawnEnv() {
  return {
    ...process.env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

async function readGitFile(root, relPath) {
  try {
    return await readFile(path.join(root, ".git", relPath), "utf8");
  } catch {
    return null;
  }
}

/**
 * Resolves whether HEAD points at an existing commit, using only files
 * under `.git`. Returns true/false/null (undecidable).
 */
async function headHasCommitFs(root) {
  const head = await readGitFile(root, "HEAD");
  if (head === null) return null;
  const trimmed = head.trim();
  if (/^[0-9a-f]{40}$/.test(trimmed)) return true; // detached HEAD at a commit
  const match = /^ref:\s*(.+)$/.exec(trimmed);
  if (!match) return null;
  const ref = match[1].trim();
  const loose = await readGitFile(root, ref);
  if (loose !== null && loose.trim().length > 0) return true;
  const packed = await readGitFile(root, "packed-refs");
  if (packed !== null) {
    for (const line of packed.split("\n")) {
      if (line.startsWith("#") || line.startsWith("^")) continue;
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2 && parts[1] === ref) return true;
    }
  }
  return false;
}

/**
 * Probes the Git pre-state of root. Never writes anywhere; the only
 * possible process spawn is the frozen read-only status query.
 *
 * Returns:
 * {
 *   repository: boolean,            // `.git` is present
 *   headCommit: true|false|null,    // does HEAD resolve to a commit
 *   cleanState: true|false|null,    // null when undecidable (no spawn/fs only)
 *   probe: "git-status"|"fs-only",  // which layer produced cleanState
 *   spawn: "ok"|"skipped"|"failed", // whether the read-only spawn happened
 * }
 */
export async function probeGitState(root, { allowSpawn = true } = {}) {
  const result = {
    repository: false,
    headCommit: null,
    cleanState: null,
    probe: "fs-only",
    spawn: "skipped",
  };

  const head = await readGitFile(root, "HEAD");
  if (head === null) return result; // no .git/HEAD => not a usable repository
  result.repository = true;
  result.headCommit = await headHasCommitFs(root);

  if (!allowSpawn) return result;

  const child = spawnSync("git", [...GIT_STATUS_ARGS], {
    cwd: root,
    encoding: "utf8",
    timeout: PROBE_TIMEOUT_MS,
    env: gitSpawnEnv(),
  });
  if (child.error || child.status !== 0) {
    result.spawn = "failed";
    return result;
  }
  result.spawn = "ok";
  result.probe = "git-status";
  result.cleanState = child.stdout.trim().length === 0;
  return result;
}

function splitNulList(buffer) {
  return buffer
    .toString("utf8")
    .split("\0")
    .filter((entry) => entry.length > 0);
}

/**
 * Proves or refuses the tracked/ignore facts for candidate paths.
 *
 * "tracked" comes exclusively from the read-only git index (ls-files) and
 * "ignored" exclusively from git's own ignore machinery (check-ignore):
 * declarations from project manifests or managed locks are passed in as
 * candidate paths only and can never impersonate tracked state.
 *
 * Never fabricates true/false: when spawning is not allowed, the target is
 * not a repository, the git binary is unusable, or any frozen vector fails,
 * the outcome is { status: "not-proven", reason } — callers must report
 * unknown, not guess.
 *
 * Returns either:
 *   { status: "not-proven", reason: "spawn-not-allowed"|"no-repository"|
 *                                  "no-candidates"|"git-unavailable" }
 *   { status: "proven", tracked, ignored, trackedButIgnored, ignoredNotTracked }
 * trackedButIgnored / ignoredNotTracked are sorted arrays of candidate paths.
 */
export async function probeGitFacts(root, candidatePaths, { allowSpawn = true } = {}) {
  const notProven = (reason) => ({ status: "not-proven", reason });
  const candidates = [
    ...new Set(
      (candidatePaths ?? [])
        .filter((entry) => typeof entry === "string")
        .map((entry) => entry.replaceAll("\\", "/").replace(/\/+/g, "/").replace(/^\.\//, ""))
        .filter((entry) => entry.length > 0 && !entry.startsWith(".git/")),
    ),
  ].sort();
  if (!allowSpawn) return notProven("spawn-not-allowed");
  const head = await readGitFile(root, "HEAD");
  if (head === null) return notProven("no-repository");
  if (candidates.length === 0) return notProven("no-candidates");

  const ls = spawnSync("git", [...GIT_LS_FILES_ARGS], {
    cwd: root,
    encoding: "buffer",
    timeout: PROBE_TIMEOUT_MS,
    env: gitSpawnEnv(),
  });
  if (ls.error || ls.status !== 0) return notProven("git-unavailable");
  const tracked = new Set(splitNulList(ls.stdout));

  const check = spawnSync("git", [...GIT_CHECK_IGNORE_ARGS], {
    cwd: root,
    input: Buffer.from(candidates.join("\0") + "\0", "utf8"),
    encoding: "buffer",
    timeout: PROBE_TIMEOUT_MS,
    env: gitSpawnEnv(),
  });
  // check-ignore exits 0 when at least one path is ignored, 1 when none is;
  // anything else (128 = not a repository, binary failure) is never a fact.
  if (check.error || check.status === null || check.status > 1) return notProven("git-unavailable");
  const ignored = new Set(splitNulList(check.stdout));

  return {
    status: "proven",
    tracked,
    ignored,
    trackedButIgnored: candidates.filter((entry) => tracked.has(entry) && ignored.has(entry)),
    ignoredNotTracked: candidates.filter((entry) => !tracked.has(entry) && ignored.has(entry)),
  };
}
