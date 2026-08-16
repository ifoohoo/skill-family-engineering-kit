import {
  chmod,
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
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
 * projection — apply one explicitly owned set of managed writes and deletes.
 *
 * Version 1 remains the target-local, write-only contract. Version 2 accepts
 * an in-memory manifest or an external manifest plus a complete external
 * candidate tree. Version 2 validates the entire candidate and every target
 * expectation before mutation, rechecks each expectation immediately before
 * its mutation, and restores the complete authorized target closure on any
 * failure. A rollback failure is reported as a fatal projection failure and
 * never as a zero-write result.
 */

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const V2_KIND = "skill-family.projection-manifest";
const OWNER_KIND = "managed";
const TARGET_FACTS_CONTROL_PATHS = new Set([
  ".foundation/file-registry.json",
  "skill-family.project-manifest.json",
  "skill-family.managed-file-lock.json",
]);

function invalidManifest(message, extraDetails) {
  return kitError(KIT_ERROR_KINDS.INVALID_MANIFEST, message, extraDetails);
}

function canonicalDigest(value) {
  return digestBytes(Buffer.from(JSON.stringify(value), "utf8"));
}

function modeOf(st) {
  return st.mode & 0o7777;
}

function portableKey(rel) {
  return rel
    .split("/")
    .map((part) => part.normalize("NFKC").replace(/[ .]+$/u, "").toLocaleLowerCase("en-US"))
    .join("/");
}

function assertNoPortableCollisions(paths, label) {
  const seen = new Map();
  for (const rel of paths) {
    const key = portableKey(rel);
    if (seen.has(key) && seen.get(key) !== rel) {
      throw invalidManifest(`${label} contains a portable path collision`, {
        first: seen.get(key),
        second: rel,
      });
    }
    seen.set(key, rel);
  }
}

function validateV2Expect(expect, label, { deleteOperation = false } = {}) {
  if (!expect || typeof expect !== "object" || Array.isArray(expect)) {
    throw invalidManifest(`${label}.expect must be an object`);
  }
  if (!new Set(["absent", "sha256"]).has(expect.state)) {
    throw invalidManifest(`${label}.expect.state must be one of: absent, sha256`);
  }
  if (expect.state === "sha256" && !SHA256_HEX_PATTERN.test(expect.value ?? "")) {
    throw invalidManifest(`${label}.expect.value must be a lowercase sha256 hex digest`);
  }
  if (expect.mode !== undefined
    && (expect.state !== "sha256" || !Number.isInteger(expect.mode) || expect.mode < 0 || expect.mode > 0o7777)) {
    throw invalidManifest(`${label}.expect.mode must be an integer permission mode for sha256 state`);
  }
  if (expect.state === "absent" && expect.value !== undefined) {
    throw invalidManifest(`${label}.expect.value is forbidden for absent state`);
  }
  if (deleteOperation && expect.state !== "sha256") {
    throw invalidManifest(`${label} delete requires an exact expect.sha256`);
  }
}

function validateOwner(owner, label) {
  if (!owner || typeof owner !== "object" || Array.isArray(owner)) {
    throw invalidManifest(`${label}.owner must explicitly declare managed ownership`);
  }
  if (owner.kind !== OWNER_KIND || typeof owner.id !== "string" || owner.id.trim() === "") {
    throw invalidManifest(`${label}.owner must contain kind=managed and a non-empty id`);
  }
  const keys = Object.keys(owner).sort();
  if (keys.join(",") !== "id,kind") {
    throw invalidManifest(`${label}.owner fields must be exactly id and kind`);
  }
}

function projectionPlanInputError(message, details) {
  throw invalidManifest(`projection plan input invalid: ${message}`, details);
}

function validatePlanPath(rawPath, label) {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    projectionPlanInputError(`${label} must be a non-empty path`);
  }
  const classification = classifyPathInput(rawPath);
  const normalized = normalizeRelPath(rawPath);
  const segments = normalized.split("/");
  if (!classification.ok || segments.includes("..") || segments.includes(".") || normalized === "") {
    projectionPlanInputError(`${label} must be a contained portable path`, { path: rawPath, kind: classification.kind });
  }
  return normalized;
}

function validatePlanMode(mode, label) {
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) {
    projectionPlanInputError(`${label} must be an integer permission mode`);
  }
  return mode;
}

function normalizeRootBinding(rootBinding) {
  if (typeof rootBinding !== "string" || !path.isAbsolute(rootBinding) || rootBinding.includes("\0")) {
    projectionPlanInputError("rootBinding must be a canonical absolute realpath");
  }
  const normalized = path.normalize(rootBinding);
  if (normalized !== rootBinding) {
    projectionPlanInputError("rootBinding must already be normalized", { rootBinding, normalized });
  }
  return rootBinding;
}

function normalizePlanClosure(rawClosure, label) {
  if (!rawClosure || typeof rawClosure !== "object" || Array.isArray(rawClosure)) {
    projectionPlanInputError(`${label} must be an object`);
  }
  if (rawClosure.digestAlgorithm !== "sha256" || !SHA256_HEX_PATTERN.test(rawClosure.digest ?? "")) {
    projectionPlanInputError(`${label} must carry a lowercase sha256 closure digest`);
  }
  if (!Array.isArray(rawClosure.resources)) {
    projectionPlanInputError(`${label}.resources must be an array`);
  }
  const resources = rawClosure.resources.map((resource, index) => {
    const resourceLabel = `${label}.resources[${index}]`;
    if (!resource || typeof resource !== "object" || Array.isArray(resource)) {
      projectionPlanInputError(`${resourceLabel} must be an object`);
    }
    const rel = validatePlanPath(resource.path, `${resourceLabel}.path`);
    if (resource.type === "symlink") {
      projectionPlanInputError(`${resourceLabel} may not represent a symlink`, { path: rel });
    }
    if (resource.type !== "file") {
      projectionPlanInputError(`${resourceLabel}.type must be file`, { path: rel, type: resource.type ?? null });
    }
    if (!SHA256_HEX_PATTERN.test(resource.sha256 ?? "")) {
      projectionPlanInputError(`${resourceLabel}.sha256 must be a lowercase sha256 hex digest`, { path: rel });
    }
    return { path: rel, type: "file", sha256: resource.sha256, mode: validatePlanMode(resource.mode, `${resourceLabel}.mode`) };
  }).sort((a, b) => a.path.localeCompare(b.path));
  const paths = resources.map((resource) => resource.path);
  if (new Set(paths).size !== paths.length) projectionPlanInputError(`${label} contains a duplicate path`);
  assertNoPortableCollisions(paths, label);
  const digest = canonicalDigest(resources);
  if (digest !== rawClosure.digest) {
    projectionPlanInputError(`${label} digest does not match its normalized resources`, { expected: rawClosure.digest, actual: digest });
  }
  return { digestAlgorithm: "sha256", digest, resourceCount: resources.length, resources };
}

function normalizeAuthoritySources(rawSources, candidatePaths) {
  if (!Array.isArray(rawSources) || rawSources.length === 0) {
    projectionPlanInputError("authoritySources must be a non-empty array");
  }
  const ids = new Set();
  const paths = new Set();
  const sources = rawSources.map((source, index) => {
    const label = `authoritySources[${index}]`;
    if (!source || typeof source !== "object" || Array.isArray(source)) projectionPlanInputError(`${label} must be an object`);
    if (typeof source.id !== "string" || source.id.trim() === "" || ids.has(source.id)) {
      projectionPlanInputError(`${label}.id must be unique and non-empty`);
    }
    const rel = validatePlanPath(source.path, `${label}.path`);
    if (paths.has(rel)) projectionPlanInputError(`authoritySources contain a duplicate path`, { path: rel });
    if (!SHA256_HEX_PATTERN.test(source.sha256 ?? "")) projectionPlanInputError(`${label}.sha256 must be a lowercase sha256 hex digest`);
    const type = source.type ?? "file";
    if (type !== "file") projectionPlanInputError(`${label}.type must be file`);
    const mode = validatePlanMode(source.mode ?? 0o644, `${label}.mode`);
    if (candidatePaths.has(rel)) {
      projectionPlanInputError("an authority source may not come from the same external candidate closure", { path: rel });
    }
    ids.add(source.id);
    paths.add(rel);
    return { id: source.id, path: rel, type, sha256: source.sha256, mode };
  }).sort((a, b) => a.id.localeCompare(b.id));
  assertNoPortableCollisions([...paths], "authoritySources");
  return { sources, ids, paths, digestAlgorithm: "sha256", digest: canonicalDigest(sources) };
}

/**
 * Purely compiles frozen consumer authority into target-fact and projection
 * descriptions. It performs no filesystem access. runProjection reloads the
 * target-owned facts by default, or accepts this complete canonical result
 * after independently binding it to the live target and candidate closures.
 */
export function compileProjectionPlan({
  rootBinding,
  authoritySources,
  ownership,
  handwrittenPolicy,
  previousOwnedClosure,
  externalCandidateClosure,
} = {}) {
  const canonicalRootBinding = normalizeRootBinding(rootBinding);
  const previous = normalizePlanClosure(previousOwnedClosure, "previousOwnedClosure");
  const candidate = normalizePlanClosure(externalCandidateClosure, "externalCandidateClosure");
  const previousByPath = new Map(previous.resources.map((resource) => [resource.path, resource]));
  const candidateByPath = new Map(candidate.resources.map((resource) => [resource.path, resource]));
  const authority = normalizeAuthoritySources(authoritySources, new Set(candidateByPath.keys()));

  if (!handwrittenPolicy || typeof handwrittenPolicy !== "object" || Array.isArray(handwrittenPolicy)) {
    projectionPlanInputError("handwrittenPolicy must be an object");
  }
  if (!authority.ids.has(handwrittenPolicy.authoritySource)) {
    projectionPlanInputError("handwrittenPolicy must bind an existing authority source");
  }
  if (!Array.isArray(handwrittenPolicy.patterns)) projectionPlanInputError("handwrittenPolicy.patterns must be an array");
  const handwrittenPatterns = [...new Set(handwrittenPolicy.patterns.map((pattern, index) => {
    if (typeof pattern !== "string" || pattern.trim() === "") {
      projectionPlanInputError(`handwrittenPolicy.patterns[${index}] must be a non-empty string`);
    }
    return pattern;
  }))].sort();

  const rawEntries = Array.isArray(ownership) ? ownership : ownership?.entries;
  if (!Array.isArray(rawEntries) || rawEntries.length === 0) projectionPlanInputError("ownership entries must be a non-empty array");
  const targetPaths = new Set();
  const usedSources = new Set();
  const entries = rawEntries.map((entry, index) => {
    const label = `ownership[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) projectionPlanInputError(`${label} must be an object`);
    const rel = validatePlanPath(entry.path, `${label}.path`);
    if (targetPaths.has(rel)) projectionPlanInputError("ownership contains a duplicate target path", { path: rel });
    if (authority.paths.has(rel) && candidateByPath.has(rel)) {
      projectionPlanInputError("a same-batch authority target cannot authorize itself", { path: rel });
    }
    if (!authority.ids.has(entry.authoritySource)) projectionPlanInputError(`${label}.authoritySource is unknown`, { path: rel });
    try { validateOwner(entry.owner, label); } catch (cause) { projectionPlanInputError(cause.message, { path: rel }); }
    if (matchAnyGlob(handwrittenPatterns, rel)) projectionPlanInputError("ownership conflicts with handwritten policy", { path: rel });
    const source = entry.source === undefined ? rel : validatePlanPath(entry.source, `${label}.source`);
    const candidateResource = candidateByPath.get(source);
    const previousResource = previousByPath.get(rel);
    if (!candidateResource && !previousResource) projectionPlanInputError("ownership names an unknown path", { path: rel, source });
    if (candidateResource) {
      if (usedSources.has(source)) projectionPlanInputError("an external candidate source has conflicting ownership", { source });
      usedSources.add(source);
    } else if (entry.source !== undefined) {
      projectionPlanInputError("a delete-only ownership entry may not declare a candidate source", { path: rel });
    }
    if (entry.expect !== undefined) {
      const expected = entry.expect;
      if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
        projectionPlanInputError(`${label}.expect must be an object`, { path: rel });
      }
      const actual = previousResource
        ? { state: "sha256", value: previousResource.sha256, type: previousResource.type, mode: previousResource.mode }
        : { state: "absent" };
      if (expected.state !== actual.state
        || (actual.state === "sha256" && expected.value !== actual.value)
        || (expected.type !== undefined && expected.type !== actual.type)
        || (expected.mode !== undefined && expected.mode !== actual.mode)) {
        projectionPlanInputError("ownership expect, type or mode differs from the previous owned closure", { path: rel, expected, actual });
      }
    }
    if (entry.candidate !== undefined) {
      const expected = entry.candidate;
      if (!candidateResource
        || !expected || typeof expected !== "object" || Array.isArray(expected)
        || (expected.sha256 !== undefined && expected.sha256 !== candidateResource.sha256)
        || (expected.type !== undefined && expected.type !== candidateResource.type)
        || (expected.mode !== undefined && expected.mode !== candidateResource.mode)) {
        projectionPlanInputError("ownership candidate digest, type or mode differs from the external candidate closure", {
          path: rel,
          expected,
          actual: candidateResource ?? null,
        });
      }
    }
    targetPaths.add(rel);
    return {
      path: rel,
      source,
      authoritySource: entry.authoritySource,
      owner: { kind: OWNER_KIND, id: entry.owner.id },
      rootOutput: entry.rootOutput === true,
      previousResource,
      candidateResource,
    };
  }).sort((a, b) => a.path.localeCompare(b.path));
  assertNoPortableCollisions([...targetPaths], "ownership targets");
  for (const candidatePath of candidateByPath.keys()) {
    if (!usedSources.has(candidatePath)) projectionPlanInputError("external candidate contains an unowned path", { path: candidatePath });
  }
  for (const previousPath of previousByPath.keys()) {
    if (!targetPaths.has(previousPath)) projectionPlanInputError("previous owned closure contains an unknown path", { path: previousPath });
  }

  const operations = entries.map((entry) => {
    const expect = entry.previousResource
      ? { state: "sha256", value: entry.previousResource.sha256, mode: entry.previousResource.mode }
      : { state: "absent" };
    if (entry.candidateResource) {
      return {
        operation: "write",
        path: entry.path,
        source: entry.source,
        owner: entry.owner,
        expect,
        type: entry.candidateResource.type,
        mode: entry.candidateResource.mode,
      };
    }
    return {
      operation: "delete",
      path: entry.path,
      owner: entry.owner,
      expect,
      type: entry.previousResource.type,
      mode: entry.previousResource.mode,
    };
  });
  const managedPaths = entries.map((entry) => entry.path);
  const managedLock = {
    entries: entries.map((entry) => ({
      path: entry.path,
      generator: { tool: entry.owner.id },
      authoritySource: entry.authoritySource,
    })),
  };
  const registryProjection = {
    classes: {
      managed: managedPaths,
      handwritten: { entries: handwrittenPatterns },
    },
    authority: { digestAlgorithm: authority.digestAlgorithm, digest: authority.digest },
  };
  const targetFacts = {
    fileRegistry: registryProjection,
    projectManifest: null,
    managedLock,
    managedSet: managedPaths,
    handwrittenPatterns,
    artifactPatterns: [],
    trackedToolLocks: [],
    hasOwnRegistry: true,
  };
  const manifest = validateV2Manifest({
    schemaVersion: 2,
    kind: V2_KIND,
    candidate: { members: candidate.resources.map(({ path: resourcePath, sha256, mode }) => ({ path: resourcePath, sha256, mode })) },
    operations,
    rootOutputs: entries.filter((entry) => entry.rootOutput && entry.candidateResource).map((entry) => entry.path),
  });
  const ownershipBindings = entries.map((entry) => ({
    path: entry.path,
    source: entry.source,
    authoritySource: entry.authoritySource,
    owner: entry.owner,
    rootOutput: entry.rootOutput,
  }));
  const plan = {
    kind: "skill-family.projection-plan",
    schemaVersion: 1,
    rootBinding: canonicalRootBinding,
    authority: {
      sources: authority.sources,
      digestAlgorithm: authority.digestAlgorithm,
      digest: authority.digest,
      handwrittenPolicySource: handwrittenPolicy.authoritySource,
    },
    handwrittenPolicy: {
      authoritySource: handwrittenPolicy.authoritySource,
      patterns: handwrittenPatterns,
    },
    ownership: ownershipBindings,
    targetFacts,
    registryProjection,
    previousOwnedClosure: previous,
    externalCandidateClosure: candidate,
    operations,
    manifest,
    authorizationBoundary: {
      compilerOutputAuthorizesProjection: false,
      runProjectionReloadsTargetFacts: true,
      runProjectionAcceptsCanonicalPreparedProjection: true,
      registryPersistenceAllowed: false,
      sameBatchSelfAuthorizationAllowed: false,
    },
    digestAlgorithm: "sha256",
  };
  return { ...plan, digest: canonicalDigest(plan) };
}

function preparedPlanInput(prepared) {
  if (!prepared || typeof prepared !== "object" || Array.isArray(prepared)) {
    throw invalidManifest("preparedProjection must be a complete compileProjectionPlan result");
  }
  if (prepared.kind !== "skill-family.projection-plan" || prepared.schemaVersion !== 1) {
    throw invalidManifest("preparedProjection kind and schemaVersion must identify a canonical projection plan");
  }
  if (!prepared.authority || !prepared.targetFacts || !prepared.manifest || !Array.isArray(prepared.operations)
    || !Array.isArray(prepared.ownership) || !prepared.handwrittenPolicy) {
    throw invalidManifest("preparedProjection is incomplete");
  }
  const lockEntries = prepared.targetFacts.managedLock?.entries;
  if (!Array.isArray(lockEntries)) throw invalidManifest("preparedProjection targetFacts.managedLock is incomplete");
  return {
    rootBinding: prepared.rootBinding,
    authoritySources: prepared.authority.sources,
    handwrittenPolicy: prepared.handwrittenPolicy,
    ownership: prepared.ownership.map((binding) => {
      const operation = prepared.operations.find((item) => normalizeRelPath(item.path) === normalizeRelPath(binding.path));
      return {
        path: binding.path,
        ...(operation?.operation === "write" ? { source: binding.source } : {}),
        authoritySource: binding.authoritySource,
        owner: binding.owner,
        rootOutput: binding.rootOutput,
        expect: operation?.expect,
        ...(operation?.operation === "write" ? { candidate: { type: operation.type, mode: operation.mode } } : {}),
      };
    }),
    previousOwnedClosure: prepared.previousOwnedClosure,
    externalCandidateClosure: prepared.externalCandidateClosure,
  };
}

function assertCanonicalPreparedProjection(prepared) {
  let canonical;
  try {
    canonical = compileProjectionPlan(preparedPlanInput(prepared));
  } catch (cause) {
    if (cause instanceof ContractsError) throw cause;
    throw invalidManifest(`preparedProjection cannot be canonically reconstructed: ${cause?.message ?? "unknown"}`);
  }
  if (!isDeepStrictEqual(prepared, canonical)) {
    throw invalidManifest("preparedProjection differs from the canonical compileProjectionPlan result");
  }
  return canonical;
}

function protectedPreparedPaths(prepared) {
  return new Set([
    ...TARGET_FACTS_CONTROL_PATHS,
    ...prepared.authority.sources.map((source) => normalizeRelPath(source.path)),
  ].map(portableKey));
}

async function verifyPreparedAuthority(rootAbs, prepared) {
  for (const source of prepared.authority.sources) {
    const rel = normalizeRelPath(source.path);
    try {
      await resolveContained(rootAbs, rel);
    } catch (cause) {
      throw invalidManifest("preparedProjection authority source escapes the target root", { path: rel, cause: cause?.message ?? "unknown" });
    }
    const state = await readRegularState(rootAbs, rel);
    if (state.state !== source.type || state.sha256 !== source.sha256 || state.mode !== source.mode) {
      throw invalidManifest("preparedProjection authority source differs from the live target", {
        path: rel,
        expectedSha256: source.sha256,
        expectedType: source.type,
        expectedMode: source.mode,
        actual: publicState(state),
      });
    }
  }
}

async function verifyPreparedPreviousClosure(rootAbs, prepared) {
  const resources = [];
  for (const expected of prepared.previousOwnedClosure.resources) {
    const rel = normalizeRelPath(expected.path);
    const state = await readRegularState(rootAbs, rel);
    if (state.state !== "file") {
      throw invalidManifest("preparedProjection previous-owned path is not a live regular file", { path: rel, actual: publicState(state) });
    }
    resources.push({ path: rel, type: "file", sha256: state.sha256, mode: state.mode });
  }
  const live = normalizePlanClosure({
    digestAlgorithm: "sha256",
    digest: canonicalDigest(resources.sort((a, b) => a.path.localeCompare(b.path))),
    resources,
  }, "livePreviousOwnedClosure");
  if (!isDeepStrictEqual(live, prepared.previousOwnedClosure)) {
    throw invalidManifest("preparedProjection previous-owned closure differs from the live target");
  }
}

function canonicalCandidateClosure(candidate) {
  const resources = [...candidate.byPath.values()]
    .map(({ path: rel, sha256, mode }) => ({ path: rel, type: "file", sha256, mode }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return {
    digestAlgorithm: "sha256",
    digest: canonicalDigest(resources),
    resourceCount: resources.length,
    resources,
  };
}

async function validatePreparedProjection({ prepared, rootAbs, loaded, candidateRoot }) {
  if (loaded.manifest.schemaVersion !== 2) {
    throw invalidManifest("preparedProjection is supported only for schemaVersion 2");
  }
  const canonical = assertCanonicalPreparedProjection(prepared);
  const targetReal = await realpath(rootAbs);
  if (canonical.rootBinding !== targetReal) {
    throw invalidManifest("preparedProjection rootBinding differs from the canonical target realpath", {
      expected: canonical.rootBinding,
      actual: targetReal,
    });
  }
  if (!isDeepStrictEqual(loaded.manifest, canonical.manifest)) {
    throw invalidManifest("runProjection manifest differs from preparedProjection.manifest");
  }
  const protectedPaths = protectedPreparedPaths(canonical);
  for (const operation of canonical.operations) {
    if (protectedPaths.has(portableKey(normalizeRelPath(operation.path)))) {
      throw invalidManifest("preparedProjection may not mutate an authority or target-facts path", { path: operation.path });
    }
    if (operation.operation === "write" && protectedPaths.has(portableKey(normalizeRelPath(operation.source)))) {
      throw invalidManifest("preparedProjection candidate may not supply an authority or target-facts path", { path: operation.source });
    }
  }
  await verifyPreparedAuthority(rootAbs, canonical);
  await verifyPreparedPreviousClosure(rootAbs, canonical);
  const candidate = await verifyCandidateRoot(candidateRoot, rootAbs, loaded.manifest);
  if (!isDeepStrictEqual(canonicalCandidateClosure(candidate), canonical.externalCandidateClosure)) {
    throw invalidManifest("preparedProjection external candidate closure differs from candidateRoot");
  }
  return {
    facts: { ...canonical.targetFacts, managedSet: new Set(canonical.targetFacts.managedSet) },
    candidate,
    prepared: canonical,
  };
}

function validateV1Manifest(manifest) {
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
    if (seen.has(normalized)) throw invalidManifest(`duplicate entries[].path: ${normalized}`);
    seen.add(normalized);
    const content = entry.content;
    const hasText = content && typeof content.text === "string";
    const hasBase64 = content && typeof content.base64 === "string";
    if (!content || typeof content !== "object" || hasText === hasBase64) {
      throw invalidManifest(`entries[${index}].content must carry exactly one of { text } or { base64 }`);
    }
    if (hasBase64 && !/^[A-Za-z0-9+/]*={0,2}$/.test(content.base64)) {
      throw invalidManifest(`entries[${index}].content.base64 is not valid base64`);
    }
    if (entry.expect !== undefined) {
      const expect = entry.expect;
      const states = ["absent", "sha256"];
      if (!expect || typeof expect !== "object" || !states.includes(expect.state)) {
        throw invalidManifest(`entries[${index}].expect.state must be one of: ${states.join(", ")}`);
      }
      if (expect.state === "sha256" && !SHA256_HEX_PATTERN.test(expect.value ?? "")) {
        throw invalidManifest(`entries[${index}].expect.value must be a lowercase sha256 hex digest`);
      }
    }
  }
  return manifest;
}

function validateV2Manifest(manifest) {
  if (!manifest.candidate || typeof manifest.candidate !== "object" || Array.isArray(manifest.candidate)) {
    throw invalidManifest("projection manifest candidate must be an object");
  }
  if (!Array.isArray(manifest.candidate.members)) {
    throw invalidManifest("projection manifest candidate.members must be an array");
  }
  if (!Array.isArray(manifest.operations) || manifest.operations.length === 0) {
    throw invalidManifest("projection manifest operations must be a non-empty array");
  }
  if (manifest.rootOutputs !== undefined && !Array.isArray(manifest.rootOutputs)) {
    throw invalidManifest("projection manifest rootOutputs must be an array");
  }

  const members = new Set();
  for (const [index, member] of manifest.candidate.members.entries()) {
    if (!member || typeof member !== "object" || Array.isArray(member)) {
      throw invalidManifest(`candidate.members[${index}] must be an object`);
    }
    const classification = classifyPathInput(member.path);
    if (typeof member.path !== "string" || !classification.ok) {
      throw invalidManifest(`candidate.members[${index}].path must be a contained portable path`);
    }
    const rel = normalizeRelPath(member.path);
    if (members.has(rel)) throw invalidManifest(`duplicate candidate member: ${rel}`);
    if (!SHA256_HEX_PATTERN.test(member.sha256 ?? "")) {
      throw invalidManifest(`candidate.members[${index}].sha256 must be a lowercase sha256 hex digest`);
    }
    if (member.mode !== undefined && (!Number.isInteger(member.mode) || member.mode < 0 || member.mode > 0o7777)) {
      throw invalidManifest(`candidate.members[${index}].mode must be an integer permission mode`);
    }
    members.add(rel);
  }
  assertNoPortableCollisions([...members], "candidate.members");

  const targets = new Set();
  const sources = new Set();
  for (const [index, operation] of manifest.operations.entries()) {
    const label = `operations[${index}]`;
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
      throw invalidManifest(`${label} must be an object`);
    }
    if (!new Set(["write", "delete"]).has(operation.operation)) {
      throw invalidManifest(`${label}.operation must be one of: write, delete`);
    }
    const classification = classifyPathInput(operation.path);
    if (typeof operation.path !== "string" || !classification.ok) {
      throw invalidManifest(`${label}.path must be a contained portable path`);
    }
    const rel = normalizeRelPath(operation.path);
    if (targets.has(rel)) throw invalidManifest(`duplicate operation target: ${rel}`);
    targets.add(rel);
    validateOwner(operation.owner, label);
    validateV2Expect(operation.expect, label, { deleteOperation: operation.operation === "delete" });
    if (operation.operation === "write") {
      const source = normalizeRelPath(operation.source ?? operation.path);
      if (!members.has(source)) throw invalidManifest(`${label}.source is not a declared candidate member`);
      sources.add(source);
    } else if (operation.source !== undefined) {
      throw invalidManifest(`${label}.source is forbidden for delete`);
    }
  }
  assertNoPortableCollisions([...targets], "operations");
  if (sources.size !== members.size || [...members].some((member) => !sources.has(member))) {
    throw invalidManifest("candidate.members must exactly equal the write-operation source set", {
      members: [...members].sort(),
      sources: [...sources].sort(),
    });
  }

  const rootOutputs = manifest.rootOutputs ?? [];
  const rootSeen = new Set();
  for (const [index, rawPath] of rootOutputs.entries()) {
    const rel = normalizeRelPath(rawPath);
    if (typeof rawPath !== "string" || rootSeen.has(rel)) {
      throw invalidManifest(`rootOutputs[${index}] must be a unique path`);
    }
    const operation = manifest.operations.find((item) => normalizeRelPath(item.path) === rel);
    if (!operation || operation.operation !== "write") {
      throw invalidManifest(`root output must name a write operation: ${rel}`);
    }
    rootSeen.add(rel);
  }
  return manifest;
}

function validateManifestObject(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw invalidManifest("projection manifest must be a JSON object");
  }
  if (![1, 2].includes(manifest.schemaVersion)) {
    throw invalidManifest("projection manifest schemaVersion must be 1 or 2");
  }
  if (manifest.kind !== V2_KIND) {
    throw invalidManifest(`projection manifest kind must be ${V2_KIND}`);
  }
  return manifest.schemaVersion === 1 ? validateV1Manifest(manifest) : validateV2Manifest(manifest);
}

function validateLocalV1Manifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw invalidManifest("projection manifest must be a JSON object");
  }
  if (manifest.schemaVersion !== 1) {
    throw invalidManifest("projection manifest schemaVersion must be 1");
  }
  if (manifest.kind !== V2_KIND) {
    throw invalidManifest(`projection manifest kind must be ${V2_KIND}`);
  }
  return validateV1Manifest(manifest);
}

async function loadExternalManifest(rootAbs, absPath) {
  const st = await lstat(absPath).catch(() => null);
  if (!st || !st.isFile() || st.isSymbolicLink()) {
    throw invalidManifest("external projection manifest must be a regular non-symlink file", { manifest: absPath });
  }
  const [targetReal, manifestReal] = await Promise.all([
    realpath(rootAbs),
    realpath(absPath).catch(() => null),
  ]);
  if (!manifestReal) {
    throw invalidManifest("external projection manifest cannot be resolved", { manifest: absPath });
  }
  const relativeToTarget = path.relative(targetReal, manifestReal);
  if (relativeToTarget === "" || (!relativeToTarget.startsWith("..") && !path.isAbsolute(relativeToTarget))) {
    throw invalidManifest("external projection manifest must resolve outside the target", { manifest: absPath });
  }
  let manifest;
  try {
    manifest = JSON.parse(await readFile(absPath, "utf8"));
  } catch {
    throw invalidManifest("external projection manifest is not valid JSON", { manifest: absPath });
  }
  return { manifestPath: manifestReal, manifest: validateManifestObject(manifest), external: true };
}

/** Loads and shape-validates a target-local v1 or external v2 manifest. */
export async function loadProjectionManifest(rootAbs, manifestInput) {
  if (manifestInput && typeof manifestInput === "object" && !Array.isArray(manifestInput)) {
    return { manifestPath: "<in-memory>", manifest: validateManifestObject(manifestInput), external: true };
  }
  if (typeof manifestInput === "string" && path.isAbsolute(manifestInput)) {
    return loadExternalManifest(rootAbs, manifestInput);
  }
  const rawManifestPath = manifestInput ?? PROJECTION_MANIFEST_PATH;
  const classification = classifyPathInput(rawManifestPath);
  if (!classification.ok) {
    throw kitError(classification.kind, `projection manifest path rejected (kind: ${classification.kind})`, {
      input: rawManifestPath,
    });
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
  return { manifestPath, manifest: validateLocalV1Manifest(loaded.value) };
}

function desiredBytes(entry) {
  return entry.content.text !== undefined
    ? Buffer.from(entry.content.text, "utf8")
    : Buffer.from(entry.content.base64, "base64");
}

async function readRegularState(rootAbs, rel) {
  const target = path.join(rootAbs, rel);
  let st;
  try {
    st = await lstat(target);
  } catch (cause) {
    if (cause && cause.code === "ENOENT") return { state: "absent" };
    if (cause && cause.code === "ENOTDIR") {
      return { state: "blocked-parent", mode: null };
    }
    throw cause;
  }
  if (st.isSymbolicLink()) return { state: "symlink", mode: modeOf(st) };
  if (!st.isFile()) return { state: st.isDirectory() ? "directory" : "special", mode: modeOf(st) };
  const bytes = await readFile(target);
  return { state: "file", sha256: digestBytes(bytes), mode: modeOf(st), bytes };
}

function publicState(state) {
  return state.state === "file"
    ? { state: "sha256", value: state.sha256, mode: state.mode }
    : { state: state.state, value: null, mode: state.mode ?? null };
}

function stateMatchesExpect(state, expect) {
  if (expect.state === "absent") return state.state === "absent";
  return state.state === "file"
    && state.sha256 === expect.value
    && (expect.mode === undefined || state.mode === expect.mode);
}

function stateEquals(left, right) {
  return left.state === right.state
    && (left.state !== "file" || (left.sha256 === right.sha256 && left.mode === right.mode));
}

function closureForStates(states) {
  const resources = [...states.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([rel, state]) => ({
    path: rel,
    ...publicState(state),
  }));
  return { digestAlgorithm: "sha256", digest: canonicalDigest(resources), resourceCount: resources.length, resources };
}

async function enumerateCandidate(rootAbs) {
  const records = [];
  async function walk(absDir, relBase) {
    const entries = await readdir(absDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const rel = relBase === "" ? entry.name : `${relBase}/${entry.name}`;
      const abs = path.join(absDir, entry.name);
      const st = await lstat(abs);
      if (st.isSymbolicLink()) {
        throw invalidManifest("candidate tree contains a symbolic link", { path: rel });
      }
      if (st.isDirectory()) {
        await walk(abs, rel);
      } else if (st.isFile()) {
        const bytes = await readFile(abs);
        records.push({ path: rel, sha256: digestBytes(bytes), mode: modeOf(st), bytes });
      } else {
        throw invalidManifest("candidate tree contains a special file", { path: rel });
      }
    }
  }
  await walk(rootAbs, "");
  assertNoPortableCollisions(records.map((record) => record.path), "candidate tree");
  return records;
}

async function verifyCandidateRoot(candidateRoot, targetRoot, manifest) {
  if (typeof candidateRoot !== "string" || candidateRoot.length === 0) {
    throw invalidManifest("schemaVersion 2 projection requires candidateRoot");
  }
  const candidateAbs = await realpath(path.resolve(candidateRoot)).catch(() => null);
  if (!candidateAbs) throw invalidManifest("candidateRoot does not exist", { candidateRoot });
  const st = await stat(candidateAbs);
  if (!st.isDirectory()) throw invalidManifest("candidateRoot must be a directory", { candidateRoot });
  const targetReal = await realpath(targetRoot);
  const candidateFromTarget = path.relative(targetReal, candidateAbs);
  const targetFromCandidate = path.relative(candidateAbs, targetReal);
  if (candidateFromTarget === "" || !candidateFromTarget.startsWith("..") || !targetFromCandidate.startsWith("..")) {
    throw invalidManifest("candidateRoot must be external to the target", { candidateRoot: candidateAbs });
  }

  const actual = await enumerateCandidate(candidateAbs);
  const declared = new Map(manifest.candidate.members.map((member) => [normalizeRelPath(member.path), member]));
  if (actual.length !== declared.size) {
    throw invalidManifest("candidate tree member count differs from candidate.members", {
      actual: actual.map((item) => item.path), declared: [...declared.keys()].sort(),
    });
  }
  for (const record of actual) {
    const member = declared.get(record.path);
    if (!member) throw invalidManifest("candidate tree contains an undeclared extra member", { path: record.path });
    if (member.sha256 !== record.sha256) {
      throw invalidManifest("candidate member digest mismatch", { path: record.path, expected: member.sha256, actual: record.sha256 });
    }
    if (member.mode !== undefined && member.mode !== record.mode) {
      throw invalidManifest("candidate member mode mismatch", { path: record.path, expected: member.mode, actual: record.mode });
    }
  }
  for (const rel of declared.keys()) {
    if (!actual.some((record) => record.path === rel)) {
      throw invalidManifest("candidate tree is missing a declared member", { path: rel });
    }
  }
  const byPath = new Map(actual.map((record) => [record.path, record]));
  const resources = actual.map(({ path: rel, sha256, mode }) => ({ path: rel, sha256, mode }));
  return {
    rootAbs: candidateAbs,
    byPath,
    closure: { digestAlgorithm: "sha256", digest: canonicalDigest(resources), resourceCount: resources.length, resources },
  };
}

async function validateTargetPath({ rawPath, facts, manifestPath, rootAbs, externalManifest, owner }) {
  const rel = normalizeRelPath(rawPath);
  const classification = classifyPathInput(rawPath);
  if (!classification.ok) {
    return { path: rel, kind: classification.kind, code: "SFC2004", detail: `path rejected before resolution (kind: ${classification.kind})` };
  }
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
  if (!externalManifest && rel === normalizeRelPath(manifestPath)) {
    return { path: rel, kind: KIT_ERROR_KINDS.SELF_PROJECTION, code: "SFC2004", detail: "the projection manifest may not list itself" };
  }
  if (rel === ".git" || rel.startsWith(".git/")) {
    return { path: rel, kind: KIT_ERROR_KINDS.HANDWRITTEN_OVERWRITE, code: "SFC2004", detail: "path is protected handwritten material" };
  }
  if (matchAnyGlob(facts.handwrittenPatterns, rel)) {
    return { path: rel, kind: KIT_ERROR_KINDS.HANDWRITTEN_OVERWRITE, code: "SFC2004", detail: "path matches handwritten patterns" };
  }
  if (!facts.managedSet.has(rel)) {
    return { path: rel, kind: KIT_ERROR_KINDS.UNAUTHORIZED_PATH, code: "SFC2004", detail: "path is not declared managed by the target" };
  }
  const lockedEntry = Array.isArray(facts.managedLock?.entries)
    ? facts.managedLock.entries.find((entry) => entry && normalizeRelPath(entry.path) === rel)
    : null;
  const lockedOwner = lockedEntry?.generator?.tool;
  if (owner !== undefined && typeof lockedOwner === "string" && lockedOwner.length > 0 && owner.id !== lockedOwner) {
    return { path: rel, kind: KIT_ERROR_KINDS.UNAUTHORIZED_PATH, code: "SFC2004", detail: "manifest owner does not match the target managed-file lock" };
  }
  return null;
}

async function invokeFault(faultInjector, phase, context) {
  if (typeof faultInjector === "function") await faultInjector({ phase, ...context });
}

async function removeCreatedDirectories(rootAbs, rel, existingDirectories) {
  let current = path.posix.dirname(rel);
  while (current !== "." && current !== "") {
    if (existingDirectories.has(current)) break;
    try {
      await rmdir(path.join(rootAbs, current));
    } catch (cause) {
      if (cause && new Set(["ENOENT", "ENOTEMPTY"]).has(cause.code)) break;
      throw cause;
    }
    current = path.posix.dirname(current);
  }
}

async function restoreState(rootAbs, rel, before, existingDirectories) {
  const target = path.join(rootAbs, rel);
  if (before.state === "absent") {
    try { await unlink(target); } catch (cause) { if (!cause || cause.code !== "ENOENT") throw cause; }
    await removeCreatedDirectories(rootAbs, rel, existingDirectories);
    return;
  }
  if (before.state !== "file") throw new Error(`cannot restore prior ${before.state} state`);
  const current = await readRegularState(rootAbs, rel);
  if (current.state !== "absent" && current.state !== "file") {
    throw new Error(`cannot restore over current ${current.state} state`);
  }
  await writeFileAtomic(rootAbs, rel, before.bytes, { mode: before.mode });
  await chmod(target, before.mode);
}

async function rollbackV2({ rootAbs, actions, beforeStates, existingDirectories, completed, faultInjector, cause }) {
  const failures = [];
  const restored = [];
  const completedSet = new Set(completed);
  for (const action of [...actions].reverse()) {
    try {
      await invokeFault(faultInjector, "beforeRollback", { index: action.index, operation: action.publicOperation, cause });
      const current = await readRegularState(rootAbs, action.rel);
      if (completedSet.has(action.rel) || !stateEquals(current, beforeStates.get(action.rel))) {
        await restoreState(rootAbs, action.rel, beforeStates.get(action.rel), existingDirectories);
        restored.push(action.rel);
      }
      await invokeFault(faultInjector, "afterRollback", { index: action.index, operation: action.publicOperation, cause });
    } catch (rollbackCause) {
      failures.push({ path: action.rel, message: rollbackCause && rollbackCause.message ? rollbackCause.message : "unknown" });
    }
  }
  const after = new Map();
  for (const action of actions) after.set(action.rel, await readRegularState(rootAbs, action.rel));
  const differences = actions.filter((action) => !stateEquals(beforeStates.get(action.rel), after.get(action.rel))).map((action) => action.rel);
  return {
    status: failures.length === 0 && differences.length === 0 ? "RESTORED" : "FAILED",
    restored,
    failures,
    differences,
    zeroWriteSuccess: failures.length === 0 && differences.length === 0,
    closure: closureForStates(after),
  };
}

async function listExistingDirectories(rootAbs, actions) {
  const existing = new Set();
  for (const action of actions) {
    let current = path.posix.dirname(action.rel);
    while (current !== "." && current !== "") {
      try {
        if ((await lstat(path.join(rootAbs, current))).isDirectory()) existing.add(current);
      } catch { /* absent before the transaction */ }
      current = path.posix.dirname(current);
    }
  }
  return existing;
}

async function runProjectionV2({ rootAbs, facts, manifestPath, manifest, externalManifest, candidateRoot, faultInjector, verifiedCandidate, preparedProjection }) {
  const candidate = verifiedCandidate ?? await verifyCandidateRoot(candidateRoot, rootAbs, manifest);
  const refusals = [];
  const initial = [];
  for (const [index, operation] of manifest.operations.entries()) {
    const rel = normalizeRelPath(operation.path);
    const rejection = await validateTargetPath({ rawPath: operation.path, facts, manifestPath, rootAbs, externalManifest, owner: operation.owner });
    if (rejection) { refusals.push(rejection); continue; }
    const before = await readRegularState(rootAbs, rel);
    if (new Set(["directory", "symlink", "special"]).has(before.state)) {
      refusals.push({ path: rel, kind: before.state === "symlink" ? KIT_ERROR_KINDS.SYMLINK_ON_PLANNED_PATH : KIT_ERROR_KINDS.TYPE_CONFLICT, code: "SFC2004", detail: `a ${before.state} occupies the planned path` });
      continue;
    }
    if (!stateMatchesExpect(before, operation.expect)) {
      refusals.push({ path: rel, kind: KIT_ERROR_KINDS.CONFLICT_DRIFT, code: "SFC2004", detail: "target differs from the exact declared expect state" });
      continue;
    }
    const source = operation.operation === "write" ? normalizeRelPath(operation.source ?? operation.path) : null;
    const candidateRecord = source === null ? null : candidate.byPath.get(source);
    initial.push({ index, rel, operation, before, source, candidateRecord });
  }
  if (refusals.length > 0) {
    throw refusalError(refusals, `projection refused: ${refusals.length} version 2 operation conflict(s); nothing was written`, { manifest: manifestPath });
  }

  const rootSet = new Set((manifest.rootOutputs ?? []).map(normalizeRelPath));
  const actions = initial
    .map((item) => ({ ...item, publicOperation: { operation: item.operation.operation, path: item.rel, source: item.source, owner: item.operation.owner, expect: item.operation.expect } }))
    .sort((a, b) => Number(rootSet.has(a.rel)) - Number(rootSet.has(b.rel)) || a.index - b.index);
  const beforeStates = new Map(actions.map((action) => [action.rel, action.before]));
  const beforeClosure = closureForStates(beforeStates);
  const existingDirectories = await listExistingDirectories(rootAbs, actions);
  const written = [];
  const deleted = [];
  const unchanged = [];
  const completed = [];
  let operationCause = null;

  try {
    for (const [executionIndex, action] of actions.entries()) {
      if (preparedProjection) await verifyPreparedAuthority(rootAbs, preparedProjection);
      await invokeFault(faultInjector, "beforeMutation", { index: executionIndex, operation: action.publicOperation });
      if (preparedProjection) await verifyPreparedAuthority(rootAbs, preparedProjection);
      const current = await readRegularState(rootAbs, action.rel);
      if (!stateEquals(current, action.before)) {
        throw kitError(KIT_ERROR_KINDS.CONFLICT_DRIFT, `optimistic concurrency drift before ${action.rel}`, { path: action.rel, executionIndex });
      }
      if (action.operation.operation === "write") {
        const desiredState = { state: "file", sha256: action.candidateRecord.sha256, mode: action.candidateRecord.mode };
        if (stateEquals(current, desiredState)) {
          unchanged.push({ path: action.rel, sha256: current.sha256, mode: current.mode });
        } else {
          await writeFileAtomic(rootAbs, action.rel, action.candidateRecord.bytes, { mode: action.candidateRecord.mode });
          await chmod(path.join(rootAbs, action.rel), action.candidateRecord.mode);
          written.push({ path: action.rel, sha256: action.candidateRecord.sha256, mode: action.candidateRecord.mode, source: action.source });
        }
      } else {
        await unlink(path.join(rootAbs, action.rel));
        deleted.push({ path: action.rel, priorSha256: action.before.sha256, priorMode: action.before.mode });
      }
      completed.push(action.rel);
      await invokeFault(faultInjector, "afterMutation", { index: executionIndex, operation: action.publicOperation });
    }
  } catch (cause) {
    operationCause = cause;
  }

  if (!operationCause) {
    for (const action of actions) {
      const final = await readRegularState(rootAbs, action.rel);
      const expected = action.operation.operation === "delete"
        ? { state: "absent" }
        : { state: "file", sha256: action.candidateRecord.sha256, mode: action.candidateRecord.mode };
      if (!stateEquals(final, expected)) {
        operationCause = kitError(KIT_ERROR_KINDS.PROJECTION_WRITE_FAILED, `post-mutation verification failed for ${action.rel}`, { path: action.rel });
        break;
      }
    }
  }

  if (operationCause) {
    const rollback = await rollbackV2({ rootAbs, actions, beforeStates, existingDirectories, completed, faultInjector, cause: operationCause });
    throw kitError(
      KIT_ERROR_KINDS.PROJECTION_WRITE_FAILED,
      rollback.status === "RESTORED"
        ? `projection failed and the complete target closure was restored: ${operationCause.message ?? "unknown"}`
        : `fatal projection failure: rollback did not restore the complete target closure`,
      {
        cause: { code: operationCause.code ?? null, kind: operationCause.details?.kind ?? null, message: operationCause.message ?? "unknown" },
        completed,
        rollback,
        zeroWriteSuccess: rollback.zeroWriteSuccess,
      },
    );
  }

  const afterStates = new Map();
  for (const action of actions) afterStates.set(action.rel, await readRegularState(rootAbs, action.rel));
  const afterClosure = closureForStates(afterStates);
  const orderedOperations = actions.map((action, executionIndex) => ({
    executionIndex,
    declaredIndex: action.index,
    ...action.publicOperation,
    before: publicState(action.before),
    after: publicState(afterStates.get(action.rel)),
  }));
  const operationsClosure = {
    digestAlgorithm: "sha256",
    digest: canonicalDigest(orderedOperations),
    operationCount: orderedOperations.length,
  };
  const rootOutputs = [...rootSet].map((rel) => ({ path: rel, after: publicState(afterStates.get(rel)) }));
  return {
    kind: "skill-family.projection-receipt",
    schemaVersion: 2,
    generatedBy: { tool: KIT_TOOL_NAME, version: KIT_VERSION },
    manifest: {
      location: manifestPath,
      sha256: canonicalDigest(manifest),
      external: externalManifest,
    },
    candidate: { root: candidate.rootAbs, closure: candidate.closure },
    operations: orderedOperations,
    written,
    deleted,
    unchanged,
    rootOutputs,
    closures: { before: beforeClosure, candidate: candidate.closure, operations: operationsClosure, after: afterClosure },
    rollback: { status: "NOT_NEEDED", attempted: false, zeroWriteSuccess: null },
    policy: "projection mutated only explicitly owned managed paths and committed declared root outputs last",
  };
}

async function validateV1Entry({ rawPath, facts, manifestPath, rootAbs }) {
  const rejection = await validateTargetPath({ rawPath, facts, manifestPath, rootAbs, externalManifest: false });
  if (rejection) return rejection;
  const rel = normalizeRelPath(rawPath);
  if (matchAnyGlob(facts.handwrittenPatterns, rel)) {
    return { path: rel, kind: KIT_ERROR_KINDS.HANDWRITTEN_OVERWRITE, code: "SFC2004", detail: "path matches handwritten patterns" };
  }
  if (!facts.managedSet.has(rel)) {
    return { path: rel, kind: KIT_ERROR_KINDS.UNAUTHORIZED_PATH, code: "SFC2004", detail: "path is not declared managed by the target" };
  }
  return null;
}

async function classifyV1Entry(rootAbs, item) {
  const state = await readRegularState(rootAbs, item.rel);
  const desiredSha256 = digestBytes(item.desired);
  if (state.state === "absent" || state.state === "blocked-parent") {
    if (item.entry.expect?.state === "sha256") return { refusal: { kind: KIT_ERROR_KINDS.CONFLICT_DRIFT, code: "SFC2004", detail: "expect.sha256 declared prior content, but the path does not exist" } };
    return { type: "create", rel: item.rel, desired: item.desired, sha256: desiredSha256 };
  }
  if (state.state === "symlink") return { refusal: { kind: KIT_ERROR_KINDS.SYMLINK_ON_PLANNED_PATH, code: "SFC2004", detail: "a symbolic link occupies the planned path" } };
  // Preserve the v1 behavior for a regular file occupying an intermediate
  // component: the atomic writer reports its registered mechanism error.
  if (state.state !== "file" && state.state !== "blocked-parent") return { refusal: { kind: KIT_ERROR_KINDS.TYPE_CONFLICT, code: "SFC2004", detail: `a ${state.state} occupies the planned file path` } };
  if (state.sha256 === desiredSha256) return { type: "unchanged", rel: item.rel, sha256: desiredSha256 };
  const expect = item.entry.expect;
  if (expect?.state === "sha256" && expect.value === state.sha256) return { type: "overwrite", rel: item.rel, desired: item.desired, sha256: desiredSha256 };
  return { refusal: { kind: KIT_ERROR_KINDS.CONFLICT_DRIFT, code: "SFC2004", detail: "existing content differs from the declared prior state" } };
}

async function rollbackV1(rootAbs, actions, written) {
  const restored = [];
  const removed = [];
  const failures = [];
  for (const item of [...written].reverse()) {
    const action = actions.find((entry) => entry.rel === item.path);
    try {
      if (action?.type === "overwrite" && action.priorBytes !== undefined) {
        await writeFileAtomic(rootAbs, item.path, action.priorBytes, { mode: action.priorMode });
        await chmod(path.join(rootAbs, item.path), action.priorMode);
        restored.push(item.path);
      } else {
        await unlink(path.join(rootAbs, item.path));
        removed.push(item.path);
      }
    } catch (cause) {
      failures.push({ path: item.path, message: cause?.message ?? "unknown" });
    }
  }
  return { restored, removed, failures, status: failures.length === 0 ? "RESTORED" : "FAILED" };
}

async function runProjectionV1({ rootAbs, facts, manifestPath, manifest }) {
  const plan = [];
  const refusals = [];
  for (const entry of manifest.entries) {
    const rejection = await validateV1Entry({ rawPath: entry.path, facts, manifestPath, rootAbs });
    if (rejection) refusals.push(rejection);
    else plan.push({ rel: normalizeRelPath(entry.path), entry, desired: desiredBytes(entry) });
  }
  if (refusals.length > 0) throw refusalError(refusals, `projection refused: ${refusals.length} entries violated the write boundary; nothing was written`, { manifest: manifestPath });
  const actions = [];
  for (const item of plan) {
    const action = await classifyV1Entry(rootAbs, item);
    if (action.refusal) refusals.push({ path: item.rel, ...action.refusal });
    else actions.push(action);
  }
  if (refusals.length > 0) throw refusalError(refusals, `projection refused: ${refusals.length} conflicts detected; nothing was written`, { manifest: manifestPath });
  const written = [];
  const unchanged = [];
  try {
    for (const action of actions) {
      if (action.type === "unchanged") { unchanged.push({ path: action.rel, sha256: action.sha256 }); continue; }
      if (action.type === "overwrite") {
        const prior = await readRegularState(rootAbs, action.rel);
        action.priorBytes = prior.bytes;
        action.priorMode = prior.mode;
      }
      await writeFileAtomic(rootAbs, action.rel, action.desired);
      written.push({ path: action.rel, sha256: action.sha256, mode: action.type });
    }
  } catch (cause) {
    const rollback = await rollbackV1(rootAbs, actions, written);
    if (rollback.status === "FAILED") throw kitError(KIT_ERROR_KINDS.PROJECTION_WRITE_FAILED, "fatal projection failure: rollback failed", { rollback, zeroWriteSuccess: false });
    if (cause instanceof ContractsError) throw cause;
    throw kitError(KIT_ERROR_KINDS.PROJECTION_WRITE_FAILED, `projection write failed: ${cause?.message ?? "unknown"}`, rollback);
  }
  for (const item of written) {
    if (digestBytes(await readFile(path.join(rootAbs, item.path))) !== item.sha256) {
      const rollback = await rollbackV1(rootAbs, actions, written);
      throw kitError(KIT_ERROR_KINDS.PROJECTION_WRITE_FAILED, `post-write verification failed for ${item.path}`, { path: item.path, rollback, zeroWriteSuccess: rollback.status === "RESTORED" });
    }
  }
  const closure = await computeResourceClosure({ root: rootAbs, resources: [
    { path: manifestPath, role: "input" },
    ...written.map((item) => ({ path: item.path, role: "output" })),
    ...unchanged.map((item) => ({ path: item.path, role: "output" })),
  ] });
  return {
    kind: "skill-family.projection-receipt",
    schemaVersion: 1,
    generatedBy: { tool: KIT_TOOL_NAME, version: KIT_VERSION },
    manifest: manifestPath,
    written,
    unchanged,
    closure: { digest: closure.digest, resourceCount: closure.resources.length },
    policy: "projection wrote only manifest-authorized managed artifacts; handwritten and unauthorized paths were never touched",
  };
}

/** Runs one backward-compatible projection transaction. */
export async function runProjection({ root, manifest: manifestInput, candidateRoot, faultInjector, preparedProjection } = {}) {
  const rootAbs = await resolveTargetRoot(root ?? ".");
  let facts;
  let loaded;
  let verifiedCandidate;
  let canonicalPrepared;
  if (preparedProjection === undefined) {
    facts = await loadTargetFacts(rootAbs);
    loaded = await loadProjectionManifest(rootAbs, manifestInput);
  } else {
    loaded = await loadProjectionManifest(rootAbs, manifestInput);
    ({ facts, candidate: verifiedCandidate, prepared: canonicalPrepared } = await validatePreparedProjection({
      prepared: preparedProjection,
      rootAbs,
      loaded,
      candidateRoot,
    }));
  }
  if (loaded.manifest.schemaVersion === 1) {
    if (candidateRoot !== undefined || faultInjector !== undefined || preparedProjection !== undefined || loaded.external) {
      if (loaded.external) throw invalidManifest("schemaVersion 1 manifest must remain target-local");
    }
    return runProjectionV1({ rootAbs, facts, manifestPath: loaded.manifestPath, manifest: loaded.manifest });
  }
  return runProjectionV2({ rootAbs, facts, manifestPath: loaded.manifestPath, manifest: loaded.manifest, externalManifest: loaded.external, candidateRoot, faultInjector, verifiedCandidate, preparedProjection: canonicalPrepared });
}
