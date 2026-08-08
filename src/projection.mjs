import { lstat, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { ContractsError } from "skill-family-contracts";
import {
  classifyPathInput,
  computeResourceClosure,
  digestBytes,
  resolveContained,
  writeFileAtomic,
} from "skill-family-harness-node";
import { KIT_ERROR_KINDS, kitError, refusalError } from "./errors.mjs";
import { KIT_TOOL_NAME, KIT_VERSION, PROJECTION_MANIFEST_PATH } from "./skeleton.mjs";
import {
  loadTargetFacts,
  matchAnyGlob,
  normalizeRelPath,
  readOptionalJson,
  resolveTargetRoot,
} from "./workspace.mjs";

/**
 * projection — write ONLY manifest-authorized managed artifacts.
 *
 * The projection manifest is the authorization document. Every entry is
 * checked before ANY write happens (two-phase execution):
 *
 *  1. path input classification (harness): traversal, absolute, UNC, and
 *     Windows-drive inputs are refused before resolution;
 *  2. containment (harness resolveContained): escaping and symlink-escape
 *     paths are refused;
 *  3. self-projection: the manifest may not list itself;
 *  4. authorization: the path must be declared managed by the target's own
 *     facts (file registry, project manifest managedFiles, or managed-file
 *     lock). A target without any managed declaration authorizes nothing;
 *  5. handwritten protection: a path matching handwritten patterns is never
 *     written, even if some declaration also claims it as managed;
 *  6. conflict guard: existing files are overwritten only when the entry
 *     declares the exact prior sha256; identical existing bytes are an
 *     idempotent no-op; anything else is a conflict.
 *
 * If any entry fails a check, the whole projection is refused and nothing
 * is written. A failure during or after the write phase rolls everything
 * back: overwritten files are restored from their in-memory prior bytes
 * and every file created by this run is removed, so a failed projection
 * never leaves the target half-updated (FC-17).
 */

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

function invalidManifest(message, extraDetails) {
  return kitError(KIT_ERROR_KINDS.INVALID_MANIFEST, message, extraDetails);
}

/** Loads and shape-validates the projection manifest (kit-level shape). */
export async function loadProjectionManifest(rootAbs, manifestRelPath) {
  const rawManifestPath = manifestRelPath ?? PROJECTION_MANIFEST_PATH;
  // Classification runs on the RAW input: ambiguous cross-platform inputs
  // must be refused before any normalization can mask them.
  const classification = classifyPathInput(rawManifestPath);
  if (!classification.ok) {
    throw kitError(
      classification.kind,
      `projection manifest path rejected (kind: ${classification.kind})`,
      { input: rawManifestPath },
    );
  }
  const manifestPath = normalizeRelPath(rawManifestPath);
  const loaded = await readOptionalJson(rootAbs, manifestPath);
  if (!loaded.ok) {
    throw invalidManifest(
      loaded.reason === "missing"
        ? `projection manifest not found: ${manifestPath}`
        : `projection manifest is not valid JSON: ${manifestPath}`,
      { manifest: manifestPath },
    );
  }
  const manifest = loaded.value;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw invalidManifest("projection manifest must be a JSON object");
  }
  if (manifest.schemaVersion !== 1) {
    throw invalidManifest("projection manifest schemaVersion must be 1");
  }
  if (manifest.kind !== "skill-family.projection-manifest") {
    throw invalidManifest("projection manifest kind must be skill-family.projection-manifest");
  }
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    throw invalidManifest("projection manifest entries must be a non-empty array");
  }
  const seen = new Set();
  for (const [index, entry] of manifest.entries.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw invalidManifest(`entries[${index}] must be an object`);
    }
    if (typeof entry.path !== "string" || entry.path.length === 0) {
      throw invalidManifest(`entries[${index}].path must be a non-empty string`);
    }
    const normalized = normalizeRelPath(entry.path);
    if (seen.has(normalized)) {
      throw invalidManifest(`duplicate entries[].path: ${normalized}`);
    }
    seen.add(normalized);
    const content = entry.content;
    const hasText = content && typeof content.text === "string";
    const hasBase64 = content && typeof content.base64 === "string";
    if (!content || typeof content !== "object" || hasText === hasBase64) {
      throw invalidManifest(
        `entries[${index}].content must carry exactly one of { text } or { base64 }`,
      );
    }
    if (hasBase64 && !/^[A-Za-z0-9+/]*={0,2}$/.test(content.base64)) {
      throw invalidManifest(`entries[${index}].content.base64 is not valid base64`);
    }
    if (entry.expect !== undefined) {
      const expect = entry.expect;
      const states = ["absent", "sha256"];
      if (!expect || typeof expect !== "object" || !states.includes(expect.state)) {
        throw invalidManifest(
          `entries[${index}].expect.state must be one of: ${states.join(", ")}`,
        );
      }
      if (expect.state === "sha256" && !SHA256_HEX_PATTERN.test(expect.value ?? "")) {
        throw invalidManifest(`entries[${index}].expect.value must be a lowercase sha256 hex digest`);
      }
    }
  }
  return { manifestPath, manifest };
}

function desiredBytes(entry) {
  return entry.content.text !== undefined
    ? Buffer.from(entry.content.text, "utf8")
    : Buffer.from(entry.content.base64, "base64");
}

/**
 * Full rollback of a failed write phase (FC-17): every overwrite is
 * restored from its in-memory prior bytes and every file created by this
 * run is removed. Best-effort per file; the original failure is what the
 * caller reports. Paths were already containment-checked during planning.
 */
async function rollbackWrites(rootAbs, actions, written) {
  const restored = [];
  const removed = [];
  for (const item of written) {
    const action = actions.find((entry) => entry.rel === item.path);
    try {
      if (action && action.type === "overwrite" && action.priorBytes !== undefined) {
        await writeFileAtomic(rootAbs, item.path, action.priorBytes);
        restored.push(item.path);
      } else {
        await unlink(path.join(rootAbs, item.path));
        removed.push(item.path);
      }
    } catch {
      // Rollback is best-effort; the original failure is reported.
    }
  }
  return { restored, removed };
}

/**
 * Runs one projection.
 * Options: { root, manifest } where manifest is a root-relative path
 * (default: skill-family.projection.json).
 * Returns a receipt document; throws KitError (stable kind) on any
 * refusal — in which case nothing was written.
 */
export async function runProjection({ root, manifest: manifestRelPath } = {}) {
  const rootAbs = await resolveTargetRoot(root ?? ".");
  const facts = await loadTargetFacts(rootAbs);
  const { manifestPath, manifest } = await loadProjectionManifest(rootAbs, manifestRelPath);

  // Phase 1 — validate every entry before any write.
  const plan = [];
  const refusals = [];
  for (const entry of manifest.entries) {
    const rejection = await validateEntry({ rawPath: entry.path, entry, facts, manifestPath, rootAbs });
    if (rejection) {
      refusals.push(rejection);
      continue;
    }
    plan.push({ rel: normalizeRelPath(entry.path), entry, desired: desiredBytes(entry) });
  }
  if (refusals.length > 0) {
    throw refusalError(
      refusals,
      `projection refused: ${refusals.length} entr${refusals.length === 1 ? "y" : "ies"} violated the write boundary; nothing was written`,
      { manifest: manifestPath },
    );
  }

  // Phase 2 — classify current state per entry (still no writes).
  const actions = [];
  for (const item of plan) {
    const action = await classifyEntry(rootAbs, item);
    if (action.refusal) {
      refusals.push({ path: item.rel, ...action.refusal });
      continue;
    }
    actions.push(action);
  }
  if (refusals.length > 0) {
    throw refusalError(
      refusals,
      `projection refused: ${refusals.length} conflict${refusals.length === 1 ? "" : "s"} detected; nothing was written`,
      { manifest: manifestPath },
    );
  }

  // Phase 3 — write. Overwrites keep prior bytes for restore-on-failure.
  const written = [];
  const unchanged = [];
  try {
    for (const action of actions) {
      if (action.type === "unchanged") {
        unchanged.push({ path: action.rel, sha256: action.sha256 });
        continue;
      }
      if (action.type === "overwrite") {
        action.priorBytes = await readFile(path.join(rootAbs, action.rel));
      }
      await writeFileAtomic(rootAbs, action.rel, action.desired);
      written.push({ path: action.rel, sha256: action.sha256, mode: action.type });
    }
  } catch (cause) {
    // FC-17: restore overwritten files AND remove every file created by
    // this run — a failed projection leaves no half-updated target.
    const { restored, removed } = await rollbackWrites(rootAbs, actions, written);
    // Coded errors (kit or harness) propagate unchanged so their stable
    // kinds survive; anything else becomes a coded projection failure.
    if (cause instanceof ContractsError) throw cause;
    throw kitError(
      KIT_ERROR_KINDS.PROJECTION_WRITE_FAILED,
      `projection write failed: ${cause && cause.message ? cause.message : "unknown"}`,
      { restored, removed },
    );
  }

  // Phase 4 — verification: re-read written files and compute the closure.
  for (const item of written) {
    const bytes = await readFile(path.join(rootAbs, item.path));
    if (digestBytes(bytes) !== item.sha256) {
      // A post-write verification failure is still a failed projection:
      // roll back everything this run touched.
      const { restored, removed } = await rollbackWrites(rootAbs, actions, written);
      throw kitError(
        KIT_ERROR_KINDS.PROJECTION_WRITE_FAILED,
        `post-write verification failed for ${item.path}`,
        { path: item.path, restored, removed },
      );
    }
  }
  const closure = await computeResourceClosure({
    root: rootAbs,
    resources: [
      { path: manifestPath, role: "input" },
      ...written.map((item) => ({ path: item.path, role: "output" })),
      ...unchanged.map((item) => ({ path: item.path, role: "output" })),
    ],
  });

  return {
    kind: "skill-family.projection-receipt",
    schemaVersion: 1,
    generatedBy: { tool: KIT_TOOL_NAME, version: KIT_VERSION },
    manifest: manifestPath,
    written,
    unchanged,
    closure: { digest: closure.digest, resourceCount: closure.resources.length },
    policy:
      "projection wrote only manifest-authorized managed artifacts; handwritten and unauthorized paths were never touched",
  };
}

async function validateEntry({ rawPath, entry, facts, manifestPath, rootAbs }) {
  void entry;
  const rel = normalizeRelPath(rawPath);
  // Classification runs on the RAW input so ambiguous cross-platform paths
  // (backslashes on POSIX, drive letters, UNC) are refused before any
  // normalization can mask them.
  const classification = classifyPathInput(rawPath);
  if (!classification.ok) {
    return {
      path: rel,
      kind: classification.kind,
      code: "SFC2004",
      detail: `path rejected before resolution (kind: ${classification.kind})`,
    };
  }
  // Full containment preflight (traversal, symlink escape, realpath escape)
  // before any authorization decision; escaping paths never reach a write.
  try {
    await resolveContained(rootAbs, rel);
  } catch (cause) {
    return {
      path: rel,
      kind: cause && cause.details && cause.details.kind ? cause.details.kind : KIT_ERROR_KINDS.UNAUTHORIZED_PATH,
      code: "SFC2004",
      detail: `containment preflight rejected the path: ${cause && cause.message ? cause.message : "unknown"}`,
    };
  }
  if (rel === normalizeRelPath(manifestPath)) {
    return {
      path: rel,
      kind: KIT_ERROR_KINDS.SELF_PROJECTION,
      code: "SFC2004",
      detail: "the projection manifest may not list itself",
    };
  }
  // Handwritten material wins over any managed declaration.
  if (matchAnyGlob(facts.handwrittenPatterns, rel)) {
    return {
      path: rel,
      kind: KIT_ERROR_KINDS.HANDWRITTEN_OVERWRITE,
      code: "SFC2004",
      detail: "path matches handwritten patterns; the kit never writes handwritten material",
    };
  }
  if (!facts.managedSet.has(rel)) {
    return {
      path: rel,
      kind: KIT_ERROR_KINDS.UNAUTHORIZED_PATH,
      code: "SFC2004",
      detail:
        "path is not declared managed by the target (file registry, project manifest managedFiles, or managed-file lock)",
    };
  }
  return null;
}

async function classifyEntry(rootAbs, item) {
  const { rel, desired } = item;
  const desiredSha256 = digestBytes(desired);
  const target = path.join(rootAbs, rel);
  let st = null;
  try {
    st = await lstat(target);
  } catch {
    st = null;
  }

  if (st === null) {
    if (item.entry.expect && item.entry.expect.state === "sha256") {
      return {
        refusal: {
          kind: KIT_ERROR_KINDS.CONFLICT_DRIFT,
          code: "SFC2004",
          detail: "expect.sha256 declared prior content, but the path does not exist",
        },
      };
    }
    return { type: "create", rel, desired, sha256: desiredSha256 };
  }

  if (st.isSymbolicLink()) {
    return {
      refusal: {
        kind: KIT_ERROR_KINDS.SYMLINK_ON_PLANNED_PATH,
        code: "SFC2004",
        detail: "a symbolic link occupies the planned path; the kit never writes through links",
      },
    };
  }
  if (st.isDirectory()) {
    return {
      refusal: {
        kind: KIT_ERROR_KINDS.TYPE_CONFLICT,
        code: "SFC2004",
        detail: "a directory occupies the planned file path",
      },
    };
  }

  const existing = await readFile(target);
  const existingSha256 = digestBytes(existing);
  if (existingSha256 === desiredSha256) {
    return { type: "unchanged", rel, sha256: desiredSha256 };
  }

  const expect = item.entry.expect;
  if (expect && expect.state === "sha256" && expect.value === existingSha256) {
    return { type: "overwrite", rel, desired, sha256: desiredSha256 };
  }
  return {
    refusal: {
      kind: KIT_ERROR_KINDS.CONFLICT_DRIFT,
      code: "SFC2004",
      detail:
        expect === undefined
          ? "existing content differs and no expect prior-state was declared; refusing to overwrite"
          : expect.state === "absent"
            ? "expect.absent declared, but the path exists with different content"
            : "existing content differs from the declared expect.sha256 prior state",
    },
  };
}
