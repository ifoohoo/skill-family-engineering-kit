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
import { ContractsError, compileSchema, findSchemaByObject, validateDocument } from "skill-family-contracts";
import {
  applyFileSet,
  classifyPathInput,
  createFilesystemRootBinding,
  createPrivateMaterialDirectory,
  inspectFileSetRecovery,
  observeFilesystemTree,
  prepareFileSetParents,
  readFileBound,
  removePreparedFileSetParents,
  computeResourceClosure,
  digestBytes,
  readFileStrict,
  resolveContained,
  writeFileAtomic,
} from "skill-family-harness-node";
import { KIT_ERROR_KINDS, kitError, refusalError } from "./errors.mjs";
import { KIT_TOOL_NAME, KIT_VERSION, MANAGED_LOCK_PATH, PROJECT_MANIFEST_PATH, PROJECTION_MANIFEST_PATH } from "./skeleton.mjs";
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

const WINDOWS_FILE_SET_SCHEMA = findSchemaByObject("file-set-apply-request").$id;
const windowsPermissionValidator = compileSchema({ schema: { $ref: `${WINDOWS_FILE_SET_SCHEMA}#/$defs/windowsPermissionObservation` } }, { dialect: "2020-12", policy: "strict" });
const windowsRootValidator = compileSchema({ schema: { $ref: `${WINDOWS_FILE_SET_SCHEMA}#/$defs/windowsRoot` } }, { dialect: "2020-12", policy: "strict" });

function projectionPlatform(platform) {
  if (platform !== undefined && platform !== "win32") projectionPlanInputError("platform must be win32 when supplied");
  return platform;
}

function exactFields(value, required, optional = []) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}

function windowsPermission(value, label) {
  if (!windowsPermissionValidator(value)) projectionPlanInputError(`${label} must be the closed Windows permission observation`);
  return { kind: value.kind, attributes: value.attributes, securityDigest: value.securityDigest };
}

function validatePlanPath(rawPath, label, platform) {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    projectionPlanInputError(`${label} must be a non-empty path`);
  }
  const classification = classifyPathInput(rawPath, platform ?? "posix");
  const normalized = normalizeRelPath(rawPath);
  const segments = normalized.split("/");
  if (!classification.ok || (platform === "win32" && (rawPath.includes("\\") || rawPath.normalize("NFC") !== rawPath ||
      /[<>"|?*]/u.test(rawPath) || segments.some(segment => segment.toLowerCase() === ".foundation-file-apply"))) ||
      segments.includes("..") || segments.includes(".") || normalized === "") {
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

function normalizeRootBinding(rootBinding, platform) {
  if (platform === "win32") {
    if (!windowsRootValidator(rootBinding) || !/^[A-Z]:\//u.test(rootBinding) || rootBinding.includes("\\") ||
        path.win32.normalize(rootBinding).replaceAll("\\", "/") !== rootBinding) projectionPlanInputError("rootBinding must be one canonical Windows drive path");
    for (const segment of rootBinding.slice(3).split("/")) if (!classifyPathInput(segment, "win32").ok || /[<>"|?*]/u.test(segment)) projectionPlanInputError("rootBinding contains an unsupported Windows segment");
    return rootBinding;
  }
  if (typeof rootBinding !== "string" || !path.posix.isAbsolute(rootBinding) || rootBinding.includes("\0")) {
    projectionPlanInputError("rootBinding must be a canonical absolute realpath");
  }
  const normalized = path.posix.normalize(rootBinding);
  if (normalized !== rootBinding) {
    projectionPlanInputError("rootBinding must already be normalized", { rootBinding, normalized });
  }
  return rootBinding;
}

/**
 * Single per-resource normalization fact for plan closures: validates path,
 * type, sha256, and mode exactly once and returns the canonical member shape
 * {path, type, sha256, mode}. Shared by the compiler's closure re-verification
 * (normalizePlanClosure), the public builder (buildProjectionClosure), and the
 * candidate-root re-derivation (canonicalCandidateClosure); no second
 * normalization algorithm exists. typeDefault lets the builder accept members
 * without an explicit type and normalize them to "file".
 */
function normalizePlanResource(resource, resourceLabel, { typeDefault, platform, byteIntent = false } = {}) {
  if (!resource || typeof resource !== "object" || Array.isArray(resource)) {
    projectionPlanInputError(`${resourceLabel} must be an object`);
  }
  const rel = validatePlanPath(resource.path, `${resourceLabel}.path`, platform);
  const type = resource.type === undefined ? typeDefault : resource.type;
  if (type === "symlink") {
    projectionPlanInputError(`${resourceLabel} may not represent a symlink`, { path: rel });
  }
  if (type !== "file") {
    projectionPlanInputError(`${resourceLabel}.type must be file`, { path: rel, type: resource.type ?? null });
  }
  if (!SHA256_HEX_PATTERN.test(resource.sha256 ?? "")) {
    projectionPlanInputError(`${resourceLabel}.sha256 must be a lowercase sha256 hex digest`, { path: rel });
  }
  if (platform === "win32") {
    if (!exactFields(resource, ["path", "type", "sha256", "mode", ...(byteIntent ? [] : ["permissionObservation"])]) || resource.mode !== null) {
      projectionPlanInputError(`${resourceLabel} must be a closed Windows ${byteIntent ? "byte intent" : "file observation"} with mode null`);
    }
    return { path: rel, type: "file", sha256: resource.sha256, mode: null,
      ...(byteIntent ? {} : { permissionObservation: windowsPermission(resource.permissionObservation, `${resourceLabel}.permissionObservation`) }) };
  }
  return { path: rel, type: "file", sha256: resource.sha256, mode: validatePlanMode(resource.mode, `${resourceLabel}.mode`) };
}

/**
 * Single canonicalization fact for plan closures: deterministic
 * path.localeCompare ordering, duplicate-path and portable-collision refusal,
 * and the sha256(JSON.stringify(normalizedResources)) digest byte contract.
 * Returns {digestAlgorithm, digest, resourceCount, resources}.
 */
function canonicalPlanClosure(normalizedResources, label) {
  const resources = [...normalizedResources].sort((a, b) => a.path.localeCompare(b.path));
  const paths = resources.map((resource) => resource.path);
  if (new Set(paths).size !== paths.length) projectionPlanInputError(`${label} contains a duplicate path`);
  assertNoPortableCollisions(paths, label);
  const digest = canonicalDigest(resources);
  return { digestAlgorithm: "sha256", digest, resourceCount: resources.length, resources };
}

function normalizePlanClosure(rawClosure, label, { platform, byteIntent = false } = {}) {
  if (!rawClosure || typeof rawClosure !== "object" || Array.isArray(rawClosure)) {
    projectionPlanInputError(`${label} must be an object`);
  }
  if (rawClosure.digestAlgorithm !== "sha256" || !SHA256_HEX_PATTERN.test(rawClosure.digest ?? "")) {
    projectionPlanInputError(`${label} must carry a lowercase sha256 closure digest`);
  }
  if (!Array.isArray(rawClosure.resources)) {
    projectionPlanInputError(`${label}.resources must be an array`);
  }
  const resources = rawClosure.resources.map((resource, index) => normalizePlanResource(resource, `${label}.resources[${index}]`, { platform, byteIntent }));
  const closure = canonicalPlanClosure(resources, label);
  if (closure.digest !== rawClosure.digest) {
    projectionPlanInputError(`${label} digest does not match its normalized resources`, { expected: rawClosure.digest, actual: closure.digest });
  }
  return closure;
}

/**
 * Public canonical projection (plan) closure builder (FG-4). Pure: no
 * filesystem access. Accepts an array of {path, sha256, mode} members (an
 * explicit type "file" is also accepted) and returns the canonical closure
 * {digestAlgorithm: "sha256", digest, resourceCount, resources} that
 * compileProjectionPlan accepts verbatim as previousOwnedClosure or
 * externalCandidateClosure. Members are normalized to {path, type: "file",
 * sha256, mode}, ordered by path.localeCompare, and digested with the
 * sha256(JSON.stringify(normalizedResources)) byte contract — the single
 * source of truth shared with the compiler's closure re-verification.
 *
 * This is a PLAN closure: it declares owned file identities for projection
 * planning. It differs in shape and purpose from the harness resource closure
 * (computeResourceClosure, {path, role, exists, sha256} members with an
 * envelope digest) — the two are not interchangeable.
 */
export function buildProjectionClosure(resources, options) {
  if (options !== undefined && !exactFields(options, ["platform"])) projectionPlanInputError("closure options must contain only platform");
  const platform = projectionPlatform(options?.platform);
  if (!Array.isArray(resources)) {
    projectionPlanInputError("projectionClosure resources must be an array");
  }
  const normalized = resources.map((resource, index) => normalizePlanResource(resource, `projectionClosure.resources[${index}]`, { typeDefault: "file", platform }));
  return canonicalPlanClosure(normalized, "projectionClosure");
}

function normalizeAuthoritySources(rawSources, candidatePaths, { platform, callerBytes = false } = {}) {
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
    const rel = validatePlanPath(source.path, `${label}.path`, platform);
    if (paths.has(rel)) projectionPlanInputError(`authoritySources contain a duplicate path`, { path: rel });
    if (!SHA256_HEX_PATTERN.test(source.sha256 ?? "")) projectionPlanInputError(`${label}.sha256 must be a lowercase sha256 hex digest`);
    const type = source.type ?? "file";
    if (type !== "file") projectionPlanInputError(`${label}.type must be file`);
    const permission = platform === "win32" ? normalizePlanResource(Object.fromEntries(Object.entries(source).filter(([key]) => key !== "id")), label, { platform, byteIntent: callerBytes }) : null;
    const mode = platform === "win32" ? null : validatePlanMode(source.mode ?? 0o644, `${label}.mode`);
    if (candidatePaths.has(rel)) {
      projectionPlanInputError("an authority source may not come from the same external candidate closure", { path: rel });
    }
    ids.add(source.id);
    paths.add(rel);
    return { id: source.id, path: rel, type, sha256: source.sha256, mode,
      ...(platform === "win32" && !callerBytes ? { permissionObservation: permission.permissionObservation } : {}) };
  }).sort((a, b) => a.id.localeCompare(b.id));
  assertNoPortableCollisions([...paths], "authoritySources");
  return { sources, ids, paths, digestAlgorithm: "sha256", digest: canonicalDigest(sources) };
}

/**
 * Authority binding kinds for projections whose authority does not live in
 * the target root (FG-3). "external-root" re-reads each authority source from
 * a separate frozen directory using the strict no-follow reader; "caller-bytes"
 * binds caller-provided base64 authority bytes to the declared sha256 digests
 * with no authority filesystem access at all. Both keep the target root free
 * of forged local authority facts.
 */
export const PROJECTION_AUTHORITY_BINDING_KINDS = Object.freeze(["external-root", "caller-bytes"]);

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

function normalizeAuthorityRoot(rawRoot, rootBinding, platform) {
  if (platform === "win32") {
    const normalized = normalizeRootBinding(rawRoot, platform);
    const first = path.win32.relative(normalized, rootBinding), second = path.win32.relative(rootBinding, normalized);
    if (first === "" || second === "" || (!first.startsWith("..") && !path.win32.isAbsolute(first)) || (!second.startsWith("..") && !path.win32.isAbsolute(second))) projectionPlanInputError("authorityBinding.authorityRoot must be external to rootBinding");
    return normalized;
  }
  if (typeof rawRoot !== "string" || !path.posix.isAbsolute(rawRoot) || rawRoot.includes("\0")) {
    projectionPlanInputError("authorityBinding.authorityRoot must be a canonical absolute path");
  }
  const normalized = path.posix.normalize(rawRoot);
  if (normalized !== rawRoot) {
    projectionPlanInputError("authorityBinding.authorityRoot must already be normalized", {
      authorityRoot: rawRoot,
      normalized,
    });
  }
  if (normalized === rootBinding) {
    projectionPlanInputError("authorityBinding.authorityRoot must be external to the target rootBinding");
  }
  const rootFromAuthority = path.posix.relative(normalized, rootBinding);
  const authorityFromRoot = path.posix.relative(rootBinding, normalized);
  if (
    rootFromAuthority === "" || authorityFromRoot === ""
    || !rootFromAuthority.startsWith("..") || !authorityFromRoot.startsWith("..")
  ) {
    projectionPlanInputError("authorityBinding.authorityRoot must be external to the target rootBinding", {
      authorityRoot: normalized,
      rootBinding,
    });
  }
  return normalized;
}

function normalizeCallerBytes(rawBytes, authority) {
  if (!rawBytes || typeof rawBytes !== "object" || Array.isArray(rawBytes)) {
    projectionPlanInputError("authorityBinding.bytes must map every authority source id to base64 bytes");
  }
  const provided = new Set(Object.keys(rawBytes));
  for (const source of authority.sources) {
    if (!provided.has(source.id)) {
      projectionPlanInputError("authorityBinding.bytes must provide bytes for every authority source", { id: source.id });
    }
  }
  for (const id of provided) {
    if (!authority.ids.has(id)) {
      projectionPlanInputError("authorityBinding.bytes names an unknown authority source id", { id });
    }
  }
  const normalized = {};
  for (const source of authority.sources) {
    const base64 = rawBytes[source.id];
    if (typeof base64 !== "string" || !BASE64_PATTERN.test(base64)) {
      projectionPlanInputError("authorityBinding.bytes entries must be base64 strings", { id: source.id });
    }
    const bytes = Buffer.from(base64, "base64");
    if (bytes.toString("base64") !== base64) {
      projectionPlanInputError("authorityBinding.bytes entries must be canonical base64", { id: source.id });
    }
    if (digestBytes(bytes) !== source.sha256) {
      projectionPlanInputError("authorityBinding.bytes digest differs from the declared authority source digest", {
        id: source.id,
        expected: source.sha256,
        actual: digestBytes(bytes),
      });
    }
    normalized[source.id] = base64;
  }
  return normalized;
}

/**
 * Validates and normalizes the optional authority binding (FG-3). Pure: no
 * filesystem access. Returns null when no binding is supplied (legacy
 * target-local authority). The normalized binding is embedded in the plan so
 * the prepared run can re-verify authority outside the target root.
 */
function normalizeAuthorityBinding(rawBinding, { rootBinding, authority, previous, platform }) {
  if (rawBinding === undefined) return null;
  if (!rawBinding || typeof rawBinding !== "object" || Array.isArray(rawBinding)) {
    projectionPlanInputError("authorityBinding must be an object");
  }
  const kind = rawBinding.kind;
  if (!PROJECTION_AUTHORITY_BINDING_KINDS.includes(kind)) {
    projectionPlanInputError(`authorityBinding.kind must be one of: ${PROJECTION_AUTHORITY_BINDING_KINDS.join(", ")}`);
  }
  const freshRoot = rawBinding.freshRoot === undefined ? false : rawBinding.freshRoot;
  if (typeof freshRoot !== "boolean") {
    projectionPlanInputError("authorityBinding.freshRoot must be a boolean");
  }
  if (freshRoot && previous.resourceCount !== 0) {
    projectionPlanInputError("authorityBinding.freshRoot requires an empty previousOwnedClosure");
  }
  if (kind === "external-root") {
    const extra = Object.keys(rawBinding).filter((key) => !["kind", "authorityRoot", "freshRoot"].includes(key));
    if (extra.length > 0) projectionPlanInputError("authorityBinding declares unknown fields", { fields: extra.sort() });
    const authorityRoot = normalizeAuthorityRoot(rawBinding.authorityRoot, rootBinding, platform);
    return Object.freeze({ kind, authorityRoot, freshRoot });
  }
  const extra = Object.keys(rawBinding).filter((key) => !["kind", "bytes", "freshRoot"].includes(key));
  if (extra.length > 0) projectionPlanInputError("authorityBinding declares unknown fields", { fields: extra.sort() });
  const bytes = normalizeCallerBytes(rawBinding.bytes, authority);
  return Object.freeze({ kind, bytes, freshRoot });
}

function assertExternalRoots(firstReal, secondReal, message) {
  const firstFromSecond = path.relative(secondReal, firstReal);
  const secondFromFirst = path.relative(firstReal, secondReal);
  if (
    firstFromSecond === "" || secondFromFirst === ""
    || (!firstFromSecond.startsWith("..") && !path.isAbsolute(firstFromSecond)) || (!secondFromFirst.startsWith("..") && !path.isAbsolute(secondFromFirst))
  ) {
    throw invalidManifest(message, { first: firstReal, second: secondReal });
  }
}

/**
 * Purely compiles frozen consumer authority into target-fact and projection
 * descriptions. It performs no filesystem access. runProjection reloads the
 * target-owned facts by default, or accepts this complete canonical result
 * after independently binding it to the live target and candidate closures.
 *
 * Authority binding (FG-3): by default authority sources must live inside the
 * target root (verified live at run time). The optional `authorityBinding`
 * input declares that authority is frozen OUTSIDE the target root:
 *   - { kind: "external-root", authorityRoot, freshRoot? } — authority is
 *     re-read from a separate frozen directory (strict, no-follow);
 *   - { kind: "caller-bytes", bytes, freshRoot? } — the caller supplies the
 *     authority bytes and the plan binds them to the declared digests.
 * freshRoot declares a completely fresh payload root and requires an empty
 * previousOwnedClosure. With either binding the projection never reads or
 * forges target-local authority facts. Legacy inputs without authorityBinding
 * compile to byte-identical plans.
 */
export function compileProjectionPlan({
  rootBinding,
  authoritySources,
  ownership,
  handwrittenPolicy,
  previousOwnedClosure,
  externalCandidateClosure,
  authorityBinding,
  platform,
} = {}) {
  projectionPlatform(platform);
  if (authorityBinding !== undefined && !PROJECTION_AUTHORITY_BINDING_KINDS.includes(authorityBinding?.kind)) projectionPlanInputError("authorityBinding.kind must be an existing binding kind");
  const canonicalRootBinding = normalizeRootBinding(rootBinding, platform);
  const previous = normalizePlanClosure(previousOwnedClosure, "previousOwnedClosure", { platform });
  const candidate = normalizePlanClosure(externalCandidateClosure, "externalCandidateClosure", { platform });
  const previousByPath = new Map(previous.resources.map((resource) => [resource.path, resource]));
  const candidateByPath = new Map(candidate.resources.map((resource) => [resource.path, resource]));
  const authority = normalizeAuthoritySources(authoritySources, new Set(candidateByPath.keys()), { platform, callerBytes: authorityBinding?.kind === "caller-bytes" });
  const binding = normalizeAuthorityBinding(authorityBinding, {
    rootBinding: canonicalRootBinding,
    authority,
    previous,
    platform,
  });

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
    const rel = validatePlanPath(entry.path, `${label}.path`, platform);
    if (targetPaths.has(rel)) projectionPlanInputError("ownership contains a duplicate target path", { path: rel });
    if (authority.paths.has(rel) && candidateByPath.has(rel)) {
      projectionPlanInputError("a same-batch authority target cannot authorize itself", { path: rel });
    }
    if (!authority.ids.has(entry.authoritySource)) projectionPlanInputError(`${label}.authoritySource is unknown`, { path: rel });
    try { validateOwner(entry.owner, label); } catch (cause) { projectionPlanInputError(cause.message, { path: rel }); }
    if (matchAnyGlob(handwrittenPatterns, rel)) projectionPlanInputError("ownership conflicts with handwritten policy", { path: rel });
    const source = entry.source === undefined ? rel : validatePlanPath(entry.source, `${label}.source`, platform);
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
        || (expected.mode !== undefined && expected.mode !== actual.mode)
        || (platform === "win32" && actual.state === "sha256" && !isDeepStrictEqual(expected.permissionObservation, previousResource.permissionObservation))) {
        projectionPlanInputError("ownership expect, type or mode differs from the previous owned closure", { path: rel, expected, actual });
      }
    }
    if (entry.candidate !== undefined) {
      const expected = entry.candidate;
      if (!candidateResource
        || !expected || typeof expected !== "object" || Array.isArray(expected)
        || (expected.sha256 !== undefined && expected.sha256 !== candidateResource.sha256)
        || (expected.type !== undefined && expected.type !== candidateResource.type)
        || (expected.mode !== undefined && expected.mode !== candidateResource.mode)
        || (platform === "win32" && expected.permissionObservation !== undefined && !isDeepStrictEqual(expected.permissionObservation, candidateResource.permissionObservation))) {
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
      ? { state: "sha256", value: entry.previousResource.sha256, mode: entry.previousResource.mode,
          ...(platform === "win32" ? { permissionObservation: entry.previousResource.permissionObservation } : {}) }
      : { state: "absent" };
    if (entry.candidateResource) {
      return {
        operation: "write",
        path: entry.path,
        source: entry.source,
        owner: entry.owner,
        expect,
        type: entry.candidateResource.type,
        ...(platform === "win32" ? {} : { mode: entry.candidateResource.mode }),
      };
    }
    return {
      operation: "delete",
      path: entry.path,
      owner: entry.owner,
      expect,
      type: entry.previousResource.type,
      ...(platform === "win32" ? {} : { mode: entry.previousResource.mode }),
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
  const manifest = (platform === "win32" ? validateV3Manifest : validateV2Manifest)({
    schemaVersion: platform === "win32" ? 3 : 2,
    ...(platform === "win32" ? { platform: "win32" } : {}),
    kind: V2_KIND,
    candidate: { members: platform === "win32" ? candidate.resources.map(resource => ({ ...resource })) : candidate.resources.map(({ path: resourcePath, sha256, mode }) => ({ path: resourcePath, sha256, mode })) },
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
    schemaVersion: platform === "win32" ? 2 : 1,
    ...(platform === "win32" ? { platform: "win32" } : {}),
    rootBinding: canonicalRootBinding,
    authority: {
      sources: authority.sources,
      digestAlgorithm: authority.digestAlgorithm,
      digest: authority.digest,
      handwrittenPolicySource: handwrittenPolicy.authoritySource,
      ...(binding === null ? {} : { binding }),
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
  if (prepared.kind !== "skill-family.projection-plan" || !((prepared.schemaVersion === 1 && prepared.platform === undefined) || (prepared.schemaVersion === 2 && prepared.platform === "win32"))) {
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
    ...(prepared.platform === "win32" ? { platform: "win32" } : {}),
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
        ...(operation?.operation === "write" ? { candidate: prepared.platform === "win32"
          ? prepared.externalCandidateClosure.resources.find(resource => resource.path === binding.source)
          : { type: operation.type, mode: operation.mode } } : {}),
      };
    }),
    previousOwnedClosure: prepared.previousOwnedClosure,
    externalCandidateClosure: prepared.externalCandidateClosure,
    authorityBinding: prepared.authority.binding,
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

async function verifyPreparedAuthority(rootAbs, prepared, candidateAbs = null, bindings) {
  const binding = prepared.authority.binding;
  if (binding === undefined) {
    for (const source of prepared.authority.sources) {
      const rel = normalizeRelPath(source.path);
      try {
        await resolveContained(rootAbs, rel);
      } catch (cause) {
        throw invalidManifest("preparedProjection authority source escapes the target root", { path: rel, cause: cause?.message ?? "unknown" });
      }
      const state = await readRegularState(rootAbs, rel, { rootBinding: bindings?.target });
      if (state.state !== source.type || state.sha256 !== source.sha256 || state.mode !== source.mode || (prepared.platform === "win32" && !isDeepStrictEqual(state.permissionObservation, source.permissionObservation))) {
        throw invalidManifest("preparedProjection authority source differs from the live target", {
          path: rel,
          expectedSha256: source.sha256,
          expectedType: source.type,
          expectedMode: source.mode,
          actual: publicState(state),
        });
      }
    }
    return;
  }
  if (binding.kind === "caller-bytes") {
    for (const source of prepared.authority.sources) {
      const bytes = Buffer.from(binding.bytes[source.id], "base64");
      if (digestBytes(bytes) !== source.sha256) {
        throw invalidManifest("preparedProjection caller-provided authority bytes differ from the frozen digest binding", {
          id: source.id,
          expectedSha256: source.sha256,
          actualSha256: digestBytes(bytes),
        });
      }
    }
    return;
  }
  // external-root binding: authority is frozen outside the target root and is
  // re-read strictly (no-follow, regular-file identity, digest) from there.
  let authorityReal;
  try {
    if (prepared.platform === "win32" && !bindings.authority) bindings.authority = await createFilesystemRootBinding(binding.authorityRoot);
    authorityReal = await realpath(binding.authorityRoot);
  } catch {
    throw invalidManifest("preparedProjection authority root does not resolve to an existing path", {
      authorityRoot: binding.authorityRoot,
    });
  }
  const authorityStats = await stat(authorityReal);
  if (!authorityStats.isDirectory()) {
    throw invalidManifest("preparedProjection authority root must be a directory", { authorityRoot: authorityReal });
  }
  const targetReal = await realpath(rootAbs);
  assertExternalRoots(authorityReal, targetReal, "preparedProjection authority root must be external to the target root");
  if (candidateAbs !== null) {
    assertExternalRoots(authorityReal, candidateAbs, "preparedProjection authority root must be external to the candidate root");
  }
  for (const source of prepared.authority.sources) {
    const rel = normalizeRelPath(source.path);
    let receipt;
    try {
      receipt = prepared.platform === "win32"
        ? await readFileBound(authorityReal.replaceAll("\\", "/"), rel, { rootBinding: bindings.authority })
        : await readFileStrict(authorityReal, rel);
    } catch (cause) {
      throw invalidManifest("preparedProjection authority source differs from the frozen external authority root", {
        path: rel,
        cause: cause?.details?.kind ?? cause?.message ?? "unknown",
      });
    }
    if (receipt.sha256 !== source.sha256 || (prepared.platform === "win32" ? !isDeepStrictEqual(receipt.permissionObservation, source.permissionObservation) : receipt.mode !== source.mode)) {
      throw invalidManifest("preparedProjection authority source differs from the frozen external authority root", {
        path: rel,
        expectedSha256: source.sha256,
        expectedMode: source.mode,
        actualSha256: receipt.sha256,
        actualMode: receipt.mode,
      });
    }
  }
}

async function verifyPreparedPreviousClosure(rootAbs, prepared, bindings) {
  const resources = [];
  for (const expected of prepared.previousOwnedClosure.resources) {
    const rel = normalizeRelPath(expected.path);
    const state = await readRegularState(rootAbs, rel, { rootBinding: bindings?.target });
    if (state.state !== "file") {
      throw invalidManifest("preparedProjection previous-owned path is not a live regular file", { path: rel, actual: publicState(state) });
    }
    resources.push({ path: rel, type: "file", sha256: state.sha256, mode: state.mode, ...(prepared.platform === "win32" ? { permissionObservation: state.permissionObservation } : {}) });
  }
  const live = normalizePlanClosure({
    digestAlgorithm: "sha256",
    digest: canonicalDigest(resources.sort((a, b) => a.path.localeCompare(b.path))),
    resources,
  }, "livePreviousOwnedClosure", { platform: prepared.platform });
  if (!isDeepStrictEqual(live, prepared.previousOwnedClosure)) {
    throw invalidManifest("preparedProjection previous-owned closure differs from the live target");
  }
}

function canonicalCandidateClosure(candidate, platform) {
  const resources = [...candidate.byPath.values()].map((record, index) => normalizePlanResource(
    platform === "win32" ? { path: record.path, type: "file", sha256: record.sha256, mode: null, permissionObservation: record.permissionObservation } : record,
    `externalCandidateClosure.resources[${index}]`,
    { typeDefault: "file", platform },
  ));
  return canonicalPlanClosure(resources, "externalCandidateClosure");
}

async function validatePreparedProjection({ prepared, rootAbs, loaded, candidateRoot, bindings }) {
  if (loaded.manifest.schemaVersion !== (process.platform === "win32" ? 3 : 2)) {
    throw invalidManifest("preparedProjection is supported only for schemaVersion 2");
  }
  const canonical = assertCanonicalPreparedProjection(prepared);
  const targetPath = await realpath(rootAbs);
  const targetReal = process.platform === "win32" ? targetPath.replaceAll("\\", "/") : targetPath;
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
  const binding = canonical.authority.binding;
  if (binding && binding.freshRoot) {
    const existing = (await readdir(rootAbs)).filter(name => canonical.platform !== "win32" || name !== ".foundation-file-apply");
    if (existing.length > 0) {
      throw invalidManifest("preparedProjection freshRoot requires a completely empty target root", {
        found: existing.sort(),
      });
    }
  }
  const candidate = await verifyCandidateRoot(candidateRoot, rootAbs, loaded.manifest, bindings);
  await verifyPreparedAuthority(rootAbs, canonical, candidate.rootAbs, bindings);
  await verifyPreparedPreviousClosure(rootAbs, canonical, bindings);
  if (!isDeepStrictEqual(canonicalCandidateClosure(candidate, canonical.platform), canonical.externalCandidateClosure)) {
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

function validateWindowsExpect(expect, label, { deletion = false } = {}) {
  if (expect?.state === "absent" && !deletion) {
    if (!exactFields(expect, ["state"])) throw invalidManifest(`${label} absent expectation must carry only state`);
    return;
  }
  if (!exactFields(expect, ["state", "value", "mode", "permissionObservation"]) || expect.state !== "sha256" ||
      !SHA256_HEX_PATTERN.test(expect.value) || expect.mode !== null) throw invalidManifest(`${label} must bind exact bytes and Windows permissions`);
  windowsPermission(expect.permissionObservation, `${label}.permissionObservation`);
}

function validateV3Manifest(manifest) {
  if (manifest.platform !== "win32" || manifest.schemaVersion !== 3 || manifest.kind !== V2_KIND) throw invalidManifest("Windows projection requires platform win32 and manifest schemaVersion 3");
  if (Object.hasOwn(manifest, "entries")) {
    if (!exactFields(manifest, ["schemaVersion", "platform", "kind", "entries"]) || !Array.isArray(manifest.entries) || manifest.entries.length === 0 || manifest.entries.length > 1024) throw invalidManifest("Windows inline manifest requires only the closed entries input");
    const seen = new Set();
    for (const [index, entry] of manifest.entries.entries()) {
      if (!exactFields(entry, ["path", "content"], ["expect"])) throw invalidManifest(`entries[${index}] has unknown or missing fields`);
      const rel = validatePlanPath(entry.path, `entries[${index}].path`, "win32");
      if (seen.has(rel)) throw invalidManifest("duplicate Windows inline path");
      seen.add(rel);
      const text = exactFields(entry.content, ["text"]) && typeof entry.content.text === "string";
      const base64 = exactFields(entry.content, ["base64"]) && typeof entry.content.base64 === "string" && BASE64_PATTERN.test(entry.content.base64) && Buffer.from(entry.content.base64, "base64").toString("base64") === entry.content.base64;
      if (!text && !base64) throw invalidManifest(`entries[${index}].content must be exact text or canonical base64`);
      if (entry.expect !== undefined) validateWindowsExpect(entry.expect, `entries[${index}].expect`);
    }
    assertNoPortableCollisions([...seen], "entries");
    return manifest;
  }
  if (!exactFields(manifest, ["schemaVersion", "platform", "kind", "candidate", "operations"], ["rootOutputs"]) ||
      !exactFields(manifest.candidate, ["members"]) || !Array.isArray(manifest.candidate.members) ||
      !Array.isArray(manifest.operations) || manifest.operations.length === 0 || manifest.operations.length > 1024) throw invalidManifest("Windows external manifest must be the closed candidate/operations input");
  const members = manifest.candidate.members.map((member, index) => normalizePlanResource(member, `candidate.members[${index}]`, { platform: "win32" }));
  for (const [index, operation] of manifest.operations.entries()) {
    if (!exactFields(operation, ["operation", "path", "owner", "expect", "type"], ["source"]) || operation.type !== "file") throw invalidManifest(`operations[${index}] must be a closed ordinary-file operation`);
    validatePlanPath(operation.path, `operations[${index}].path`, "win32");
    if (operation.source !== undefined) validatePlanPath(operation.source, `operations[${index}].source`, "win32");
    validateWindowsExpect(operation.expect, `operations[${index}].expect`, { deletion: operation.operation === "delete" });
  }
  validateV2Manifest({ schemaVersion: 2, kind: V2_KIND,
    candidate: { members: members.map(member => ({ path: member.path, sha256: member.sha256 })) },
    operations: manifest.operations.map(operation => ({ ...operation, expect: operation.expect.state === "absent"
      ? { state: "absent" } : { state: "sha256", value: operation.expect.value } })), rootOutputs: manifest.rootOutputs });
  return manifest;
}

function validateManifestObject(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw invalidManifest("projection manifest must be a JSON object");
  }
  if (manifest.schemaVersion === 3) return validateV3Manifest(manifest);
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

async function loadExternalManifest(rootAbs, absPath, bindings) {
  if (process.platform === "win32") {
    const parent = path.dirname(absPath);
    const rootBinding = await createFilesystemRootBinding(parent);
    const canonicalParent = (await realpath(parent)).replaceAll("\\", "/");
    const rel = path.basename(absPath);
    assertExternalRoots(`${canonicalParent}/${rel}`, rootAbs, "external projection manifest must resolve outside the target");
    const receipt = await readFileBound(canonicalParent, rel, { rootBinding, encoding: "utf8" });
    let document;
    try { document = JSON.parse(receipt.content); } catch { throw invalidManifest("external projection manifest is not valid JSON"); }
    if (bindings) bindings.manifest = { root: canonicalParent, rootBinding, rel, sha256: receipt.sha256, permissionObservation: receipt.permissionObservation };
    return { manifestPath: `${canonicalParent}/${rel}`, manifest: validateManifestObject(document), external: true };
  }
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
export async function loadProjectionManifest(rootAbs, manifestInput, bindings) {
  if (manifestInput && typeof manifestInput === "object" && !Array.isArray(manifestInput)) {
    return { manifestPath: "<in-memory>", manifest: validateManifestObject(process.platform === "win32" ? structuredClone(manifestInput) : manifestInput), external: true };
  }
  if (typeof manifestInput === "string" && path.isAbsolute(manifestInput)) {
    return loadExternalManifest(rootAbs, manifestInput, bindings);
  }
  const rawManifestPath = manifestInput ?? PROJECTION_MANIFEST_PATH;
  const classification = classifyPathInput(rawManifestPath);
  if (!classification.ok) {
    throw kitError(classification.kind, `projection manifest path rejected (kind: ${classification.kind})`, {
      input: rawManifestPath,
    });
  }
  const manifestPath = normalizeRelPath(rawManifestPath);
  let loaded;
  if (process.platform === "win32") {
    const rootBinding = bindings?.target ?? await createFilesystemRootBinding(rootAbs);
    let receipt;
    try { receipt = await readFileBound(rootAbs, manifestPath, { rootBinding, encoding: "utf8" }); }
    catch (cause) {
      if (cause?.details?.kind === "missing-resource") throw invalidManifest(`projection manifest not found: ${manifestPath}`, { manifest: manifestPath });
      throw cause;
    }
    try { loaded = { ok: true, value: JSON.parse(receipt.content) }; } catch { loaded = { ok: false, reason: "parse-failed" }; }
    if (bindings) bindings.manifest = { root: rootAbs, rootBinding, rel: manifestPath, sha256: receipt.sha256, permissionObservation: receipt.permissionObservation };
  } else loaded = await readOptionalJson(rootAbs, manifestPath);
  if (!loaded.ok) {
    throw invalidManifest(
      loaded.reason === "missing"
        ? `projection manifest not found: ${manifestPath}`
        : `projection manifest is not valid JSON: ${manifestPath}`,
      { manifest: manifestPath },
    );
  }
  return { manifestPath, manifest: process.platform === "win32" ? validateV3Manifest(loaded.value) : validateLocalV1Manifest(loaded.value) };
}

function desiredBytes(entry) {
  return entry.content.text !== undefined
    ? Buffer.from(entry.content.text, "utf8")
    : Buffer.from(entry.content.base64, "base64");
}

async function readRegularState(rootAbs, rel, { rootBinding } = {}) {
  if (process.platform === "win32") {
    if (!rootBinding) throw new TypeError("Windows projection reads require the original rootBinding");
    try {
      const receipt = await readFileBound(rootAbs, rel, { rootBinding });
      return { state: "file", sha256: receipt.sha256, mode: null, permissionObservation: receipt.permissionObservation,
        bytes: Buffer.from(receipt.content) };
    } catch (cause) {
      if (cause?.details?.boundReadDisposition === "member-policy-violation") {
        if (cause.details.kind === "missing-resource") return { state: "absent" };
        if (cause.details.failureReason === "reparse") return { state: "symlink", mode: null };
        if (cause.details.actual === "directory") return { state: "directory", mode: null };
        if (cause.details.failureReason === "not-regular") return { state: "special", mode: null };
      }
      throw cause;
    }
  }
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
    ? { state: "sha256", value: state.sha256, mode: state.mode,
        ...(state.permissionObservation ? { permissionObservation: state.permissionObservation } : {}) }
    : { state: state.state, value: null, mode: state.mode ?? null };
}

function stateMatchesExpect(state, expect) {
  if (expect.state === "absent") return state.state === "absent";
  return state.state === "file"
    && state.sha256 === expect.value
    && (expect.mode === undefined || state.mode === expect.mode)
    && (expect.permissionObservation === undefined || isDeepStrictEqual(expect.permissionObservation, state.permissionObservation));
}

function stateEquals(left, right) {
  return left.state === right.state
    && (left.state !== "file" || (left.sha256 === right.sha256 && left.mode === right.mode &&
      isDeepStrictEqual(left.permissionObservation, right.permissionObservation)));
}

function closureForStates(states) {
  const resources = [...states.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([rel, state]) => ({
    path: rel,
    ...publicState(state),
  }));
  return { digestAlgorithm: "sha256", digest: canonicalDigest(resources), resourceCount: resources.length, resources };
}

async function enumerateCandidate(rootAbs, { rootBinding } = {}) {
  if (process.platform === "win32") {
    const tree = await observeFilesystemTree({ root: rootAbs, rootBinding });
    const records = [];
    for (const member of tree.members) {
      if (member.type === "directory") continue;
      const receipt = await readFileBound(rootAbs, member.path, { rootBinding, expectedSha256: member.sha256 });
      if (!isDeepStrictEqual(receipt.permissionObservation, member.permissionObservation)) throw invalidManifest("candidate permissions changed during bound enumeration", { path: member.path });
      records.push({ path: member.path, type: "file", mode: null, sha256: receipt.sha256,
        permissionObservation: receipt.permissionObservation, bytes: Buffer.from(receipt.content) });
    }
    if (!isDeepStrictEqual(tree, await observeFilesystemTree({ root: rootAbs, rootBinding }))) throw invalidManifest("candidate tree changed during bound enumeration");
    assertNoPortableCollisions(records.map(record => record.path), "candidate tree");
    return records;
  }
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

async function verifyCandidateRoot(candidateRoot, targetRoot, manifest, bindings) {
  if (typeof candidateRoot !== "string" || candidateRoot.length === 0) {
    throw invalidManifest("schemaVersion 2 projection requires candidateRoot");
  }
  if (process.platform === "win32" && bindings && !bindings.candidate) bindings.candidate = await createFilesystemRootBinding(path.resolve(candidateRoot));
  const candidateReal = await realpath(path.resolve(candidateRoot)).catch(() => null);
  const candidateAbs = candidateReal && process.platform === "win32" ? candidateReal.replaceAll("\\", "/") : candidateReal;
  if (!candidateAbs) throw invalidManifest("candidateRoot does not exist", { candidateRoot });
  const st = await stat(candidateAbs);
  if (!st.isDirectory()) throw invalidManifest("candidateRoot must be a directory", { candidateRoot });
  const targetReal = await realpath(targetRoot);
  const candidateFromTarget = path.relative(targetReal, candidateAbs);
  const targetFromCandidate = path.relative(candidateAbs, targetReal);
  if (candidateFromTarget === "" || (!candidateFromTarget.startsWith("..") && !path.isAbsolute(candidateFromTarget)) || (!targetFromCandidate.startsWith("..") && !path.isAbsolute(targetFromCandidate))) {
    throw invalidManifest("candidateRoot must be external to the target", { candidateRoot: candidateAbs });
  }

  const actual = await enumerateCandidate(candidateAbs, { rootBinding: bindings?.candidate });
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
    if ((member.mode !== undefined && member.mode !== record.mode) ||
        (manifest.platform === "win32" && !isDeepStrictEqual(member.permissionObservation, record.permissionObservation))) {
      throw invalidManifest("candidate member mode mismatch", { path: record.path, expected: member.mode, actual: record.mode });
    }
  }
  for (const rel of declared.keys()) {
    if (!actual.some((record) => record.path === rel)) {
      throw invalidManifest("candidate tree is missing a declared member", { path: rel });
    }
  }
  const byPath = new Map(actual.map((record) => [record.path, record]));
  const resources = actual.map(({ path: rel, sha256, mode, permissionObservation }) => ({ path: rel,
    ...(manifest.platform === "win32" ? { type: "file" } : {}), sha256, mode,
    ...(manifest.platform === "win32" ? { permissionObservation } : {}) }));
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

async function runProjectionV2({ rootAbs, facts, manifestPath, manifest, externalManifest, candidateRoot, faultInjector, verifiedCandidate, preparedProjection, lockedStates }) {
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
  const attempted = lockedStates ? new Set() : null;
  let operationCause = null;

  try {
    for (const [executionIndex, action] of actions.entries()) {
      if (preparedProjection) await verifyPreparedAuthority(rootAbs, preparedProjection, candidate.rootAbs);
      await invokeFault(faultInjector, "beforeMutation", { index: executionIndex, operation: action.publicOperation });
      if (preparedProjection) await verifyPreparedAuthority(rootAbs, preparedProjection, candidate.rootAbs);
      if (lockedStates) await verifyEngineeringStates(rootAbs, lockedStates);
      const current = await readRegularState(rootAbs, action.rel);
      if (!stateEquals(current, action.before)) {
        throw kitError(KIT_ERROR_KINDS.CONFLICT_DRIFT, `optimistic concurrency drift before ${action.rel}`, { path: action.rel, executionIndex });
      }
      if (action.operation.operation === "write") {
        const desiredState = { state: "file", sha256: action.candidateRecord.sha256, mode: action.candidateRecord.mode };
        if (stateEquals(current, desiredState)) {
          unchanged.push({ path: action.rel, sha256: current.sha256, mode: current.mode });
        } else {
          if (attempted) attempted.add(action.rel);
          await writeFileAtomic(rootAbs, action.rel, action.candidateRecord.bytes, { mode: action.candidateRecord.mode });
          await chmod(path.join(rootAbs, action.rel), action.candidateRecord.mode);
          written.push({ path: action.rel, sha256: action.candidateRecord.sha256, mode: action.candidateRecord.mode, source: action.source });
        }
      } else {
        if (attempted) attempted.add(action.rel);
        await unlink(path.join(rootAbs, action.rel));
        deleted.push({ path: action.rel, priorSha256: action.before.sha256, priorMode: action.before.mode });
      }
      completed.push(action.rel);
      if (lockedStates) lockedStates.set(action.rel, {
        state: "file", sha256: action.candidateRecord.sha256, mode: action.candidateRecord.mode,
      });
      await invokeFault(faultInjector, "afterMutation", { index: executionIndex, operation: action.publicOperation });
    }
  } catch (cause) {
    operationCause = cause;
  }

  if (!operationCause) {
    if (lockedStates) {
      try { await verifyEngineeringStates(rootAbs, lockedStates); } catch (cause) { operationCause = cause; }
    }
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
    const rollbackActions = attempted ? actions.filter(action => attempted.has(action.rel)) : actions;
    const rollback = await rollbackV2({ rootAbs, actions: rollbackActions, beforeStates, existingDirectories, completed, faultInjector, cause: operationCause });
    throw kitError(
      KIT_ERROR_KINDS.PROJECTION_WRITE_FAILED,
      rollback.status === "RESTORED"
        ? lockedStates
          ? `engineering projection failed; attempted output writes were restored: ${operationCause.message ?? "unknown"}`
          : `projection failed and the complete target closure was restored: ${operationCause.message ?? "unknown"}`
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

async function verifyWindowsProjectionInputs({ rootAbs, manifest, candidateRoot, preparedProjection, bindings, candidate }) {
  if (bindings.manifest) {
    const input = bindings.manifest;
    const current = await readFileBound(input.root, input.rel, { rootBinding: input.rootBinding, expectedSha256: input.sha256 });
    if (!isDeepStrictEqual(current.permissionObservation, input.permissionObservation)) throw invalidManifest("projection manifest permissions changed");
  }
  if (candidate?.rootAbs) await verifyCandidateRoot(candidateRoot ?? candidate.rootAbs, rootAbs, manifest, bindings);
  if (preparedProjection) await verifyPreparedAuthority(rootAbs, preparedProjection, candidate?.rootAbs ?? null, bindings);
}

async function runProjectionV3({ rootAbs, facts, manifestPath, manifest, externalManifest, candidateRoot, faultInjector,
  verifiedCandidate, preparedProjection, lockedStates, bindings, runtime, rootOutputs, byteCandidate }) {
  const candidate = byteCandidate ?? verifiedCandidate ?? (manifest.candidate
    ? await verifyCandidateRoot(candidateRoot, rootAbs, manifest, bindings) : null);
  const rawOperations = manifest.operations ?? manifest.entries.map(entry => ({ operation: "write", path: entry.path,
    owner: { kind: OWNER_KIND, id: KIT_TOOL_NAME }, expect: entry.expect, content: entry.content }));
  const actions = [];
  const refusals = [];
  for (const [index, operation] of rawOperations.entries()) {
    const rel = validatePlanPath(operation.path, "projection operation path", "win32");
    const rejection = await validateTargetPath({ rawPath: rel, facts, manifestPath, rootAbs, externalManifest, owner: manifest.operations ? operation.owner : undefined });
    if (rejection) { refusals.push(rejection); continue; }
    const before = await readRegularState(rootAbs, rel, { rootBinding: bindings.target });
    if (!["file", "absent"].includes(before.state)) {
      refusals.push({ path: rel, kind: before.state === "symlink" ? KIT_ERROR_KINDS.SYMLINK_ON_PLANNED_PATH : KIT_ERROR_KINDS.TYPE_CONFLICT, code: "SFC2004", detail: `a ${before.state} occupies the planned path` });
      continue;
    }
    const source = operation.operation === "write" ? normalizeRelPath(operation.source ?? rel) : null;
    const record = source === null ? null : candidate?.byPath.get(source);
    const bytes = operation.operation === "write" ? (record?.bytes ?? desiredBytes(operation)) : null;
    const sha256 = bytes === null ? null : digestBytes(bytes);
    if (operation.expect ? !stateMatchesExpect(before, operation.expect) : before.state === "file" && before.sha256 !== sha256) {
      refusals.push({ path: rel, kind: KIT_ERROR_KINDS.CONFLICT_DRIFT, code: "SFC2004", detail: "target differs from the declared prior state" });
      continue;
    }
    actions.push({ index, rel, operation, before, source, bytes, sha256,
      changed: operation.operation === "delete" || before.state !== "file" || before.sha256 !== sha256,
      publicOperation: { operation: operation.operation, path: rel, source, owner: operation.owner,
        expect: operation.expect ?? (before.state === "file" ? publicState(before) : { state: "absent" }) } });
  }
  if (refusals.length) throw refusalError(refusals, "projection refused before directory preparation", { manifest: manifestPath });
  const rootSet = new Set(rootOutputs ?? manifest.rootOutputs ?? []);
  actions.sort((a, b) => Number(rootSet.has(a.rel)) - Number(rootSet.has(b.rel)) || a.index - b.index);
  actions.forEach((action, executionIndex) => { action.executionIndex = executionIndex; });
  const beforeStates = new Map(actions.map(action => [action.rel, action.before]));
  const expectedStates = new Map(beforeStates);
  const originalLocked = lockedStates ? new Map(lockedStates) : null;
  const liveLocked = lockedStates ? new Map(lockedStates) : null;
  const inputContext = { rootAbs, manifest, candidateRoot, preparedProjection, bindings, candidate };
  const verifyInputs = async () => {
    await verifyWindowsProjectionInputs(inputContext);
    if (liveLocked) await verifyEngineeringStates(rootAbs, liveLocked, bindings);
  };
  const verifyStates = async (expected) => {
    for (const [rel, state] of expected) {
      if (!stateEquals(await readRegularState(rootAbs, rel, { rootBinding: bindings.target }), state)) {
        throw kitError(KIT_ERROR_KINDS.CONFLICT_DRIFT, `projection closure drifted at ${rel}`, { path: rel });
      }
    }
  };
  await verifyInputs();
  await verifyStates(beforeStates);
  const recoveryRequest = { root: rootAbs, rootBinding: bindings.target, recoveryRelPath: ".foundation-file-apply",
    environment: { filesystem: "ntfs", cooperativeWriters: true } };
  const admission = await inspectFileSetRecovery(recoveryRequest);
  if (admission.status === "refused") throw kitError(KIT_ERROR_KINDS.PROJECTION_WRITE_FAILED,
    admission.error.message, { cause: admission.error, completed: [], rollback: { status: "NOT_NEEDED", attempted: false },
      zeroWriteSuccess: true, fileSet: null, directoryPreparation: { materialRoot: null, businessParents: null }, directoryCleanup: null });
  const changed = actions.filter(action => action.changed);
  let fileSet = null;
  const directoryPreparation = { materialRoot: null, businessParents: null };
  let directoryCleanup = null;
  const completed = [];
  let domainCause = null;
  let operationCause = null;
  if (changed.length) {
    try {
      directoryPreparation.materialRoot = await createPrivateMaterialDirectory(rootAbs, ".foundation-file-apply", { rootBinding: bindings.target });
      if (directoryPreparation.materialRoot.status !== "succeeded") throw new Error(directoryPreparation.materialRoot.error?.message ?? "material root preparation failed");
      directoryPreparation.businessParents = await prepareFileSetParents({ root: rootAbs, rootBinding: bindings.target, paths: changed.map(action => action.rel) });
      if (directoryPreparation.businessParents.status !== "succeeded") throw new Error(directoryPreparation.businessParents.error?.message ?? "business parent preparation failed");
      await verifyInputs();
      await verifyStates(beforeStates);
      const operations = changed.map(action => {
        const present = action.before.state === "file";
        const kind = action.operation.operation === "delete" ? "delete" : present ? "replace" : "create";
        return { path: action.rel, action: kind, expected: present ? {
          exists: true, sha256: action.before.sha256, size: action.before.bytes.length, permissions: action.before.permissionObservation,
        } : { exists: false }, next: kind === "delete" ? null : {
          sha256: action.sha256, size: action.bytes.length, permissions: { kind: present ? "windows-preserve" : "windows-inherited" }, bytes: action.bytes,
        } };
      });
      const guarded = async callback => {
        try { return await callback(); } catch (cause) { domainCause ??= cause; throw cause; }
      };
      fileSet = await applyFileSet({ schemaVersion: 2, kind: "skill-family.file-set-apply-request", operationId: runtime.operationId,
        ...recoveryRequest, allowAdjacentStaging: true, validationTimeoutMs: runtime.validationTimeoutMs, operations }, {
        beforeMutation: context => guarded(async () => {
          const action = changed[context.index];
          await verifyInputs();
          await invokeFault(faultInjector, "beforeMutation", { index: action.executionIndex, operation: action.publicOperation });
          await verifyInputs();
          await verifyStates(expectedStates);
        }),
        afterMutation: context => guarded(async () => {
          const action = changed[context.index];
          const state = await readRegularState(rootAbs, action.rel, { rootBinding: bindings.target });
          if (action.operation.operation === "delete" ? state.state !== "absent" : state.state !== "file" || state.sha256 !== action.sha256 ||
              (action.before.state === "file" && !isDeepStrictEqual(state.permissionObservation, action.before.permissionObservation))) {
            throw kitError(KIT_ERROR_KINDS.PROJECTION_WRITE_FAILED, `post-mutation verification failed for ${action.rel}`);
          }
          expectedStates.set(action.rel, state);
          if (liveLocked) liveLocked.set(action.rel, state);
          completed.push(action.rel);
          await invokeFault(faultInjector, "afterMutation", { index: action.executionIndex, operation: action.publicOperation });
          await verifyInputs();
        }),
        validate: () => guarded(async () => {
          await verifyInputs();
          await verifyStates(expectedStates);
          return { passed: true };
        }),
      });
      if (fileSet.outcome !== "committed" || fileSet.errors.length) {
        const first = fileSet.errors[0];
        const useDomain = domainCause && first && ["apply-failed", "validation-failed", "validation-incomplete"].includes(first.details.kind);
        operationCause = useDomain ? domainCause : first ?? kitError(KIT_ERROR_KINDS.PROJECTION_WRITE_FAILED,
          `file-set outcome ${fileSet.outcome}`);
      }
    } catch (cause) { operationCause = cause; }
  }
  // No-op still verifies all original inputs and states after read-only admission.
  if (!operationCause) {
    try { await verifyInputs(); await verifyStates(expectedStates); } catch (cause) { operationCause = cause; }
  }
  if (operationCause) {
    const committed = fileSet?.outcome === "committed";
    const confirmedRestore = fileSet?.outcome === "rolled-back" && fileSet.recovery.status === "complete";
    const safeWithoutApply = fileSet === null || (fileSet.outcome === "rejected" && fileSet.businessWrite === "none");
    const differences = [];
    const failures = [];
    if (!committed) {
      for (const [rel, state] of beforeStates) {
        try { if (!stateEquals(await readRegularState(rootAbs, rel, { rootBinding: bindings.target }), state)) differences.push(rel); }
        catch (cause) { failures.push({ path: rel, message: cause.message }); }
      }
      try {
        await verifyWindowsProjectionInputs(inputContext);
        if (originalLocked) await verifyEngineeringStates(rootAbs, originalLocked, bindings);
      } catch (cause) { failures.push({ path: null, message: cause.message }); }
      if ((safeWithoutApply || confirmedRestore) && directoryPreparation.businessParents?.created.length) {
        directoryCleanup = await removePreparedFileSetParents({ root: rootAbs, rootBinding: bindings.target,
          directories: directoryPreparation.businessParents.created });
      }
    }
    const noMutation = fileSet === null && [directoryPreparation.materialRoot, directoryPreparation.businessParents].every(result =>
      result === null || (result.created.length === 0 && result.unconfirmed.length === 0));
    const restored = !committed && (safeWithoutApply || confirmedRestore) && differences.length === 0 && failures.length === 0 &&
      (!directoryCleanup || directoryCleanup.status === "succeeded") &&
      [directoryPreparation.materialRoot, directoryPreparation.businessParents].every(result => result === null || result.unconfirmed.length === 0);
    throw kitError(KIT_ERROR_KINDS.PROJECTION_WRITE_FAILED, `projection failed: ${operationCause.message}`, {
      cause: { code: operationCause.code ?? null, kind: operationCause.details?.kind ?? null, message: operationCause.message },
      completed, rollback: { status: committed ? "NOT_NEEDED" : restored ? "RESTORED" : "FAILED", attempted: Boolean(fileSet?.recovery.attempted),
        restored: fileSet?.paths.filter(item => item.restore === "restored").map(item => item.path) ?? [], differences, failures, zeroWriteSuccess: noMutation && restored },
      zeroWriteSuccess: noMutation && restored, fileSet, directoryPreparation, directoryCleanup,
    });
  }
  const afterStates = new Map(expectedStates);
  const orderedOperations = actions.map(action => ({ executionIndex: action.executionIndex, declaredIndex: action.index,
    ...action.publicOperation, before: publicState(action.before), after: publicState(afterStates.get(action.rel)) }));
  const candidateClosure = candidate?.closure ?? canonicalPlanClosure(actions.map(action => ({ path: action.rel, type: "file", sha256: action.sha256, mode: null })), "inline byte candidate");
  return { kind: "skill-family.projection-receipt", schemaVersion: 3, platform: "win32", generatedBy: { tool: KIT_TOOL_NAME, version: KIT_VERSION },
    manifest: { location: manifestPath, sha256: canonicalDigest(manifest), external: externalManifest },
    candidate: { root: candidate?.rootAbs ?? null, closure: candidateClosure }, operations: orderedOperations,
    written: actions.filter(action => action.changed && action.operation.operation === "write").map(action => ({ path: action.rel,
      sha256: action.sha256, mode: null, permissionObservation: afterStates.get(action.rel).permissionObservation, source: action.source })),
    deleted: actions.filter(action => action.operation.operation === "delete").map(action => ({ path: action.rel,
      priorSha256: action.before.sha256, priorMode: null, priorPermissionObservation: action.before.permissionObservation })),
    unchanged: actions.filter(action => !action.changed).map(action => ({ path: action.rel, sha256: action.sha256,
      mode: null, permissionObservation: action.before.permissionObservation })),
    rootOutputs: [...rootSet].map(rel => ({ path: rel, after: publicState(afterStates.get(rel)) })),
    closures: { before: closureForStates(beforeStates), candidate: candidateClosure,
      operations: { digestAlgorithm: "sha256", digest: canonicalDigest(orderedOperations), operationCount: orderedOperations.length }, after: closureForStates(afterStates) },
    rollback: { status: "NOT_NEEDED", attempted: false, zeroWriteSuccess: null }, fileSet,
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

async function readEngineeringState(rootAbs, rel, bindings) {
  validatePlanPath(rel, "engineering target path", process.platform === "win32" ? "win32" : undefined);
  if (process.platform === "win32") {
    const state = await readRegularState(rootAbs, rel, { rootBinding: bindings.target });
    if (state.state !== "file") throw invalidManifest("engineering input must be a regular file", { path: rel });
    return state;
  }
  await resolveContained(rootAbs, rel);
  const receipt = await readFileStrict(rootAbs, rel);
  const state = await readRegularState(rootAbs, rel);
  if (state.state !== "file" || state.sha256 !== digestBytes(receipt.content)) {
    throw kitError(KIT_ERROR_KINDS.CONFLICT_DRIFT, `engineering input changed while reading ${rel}`, { path: rel });
  }
  return state;
}

async function verifyEngineeringStates(rootAbs, states, bindings) {
  for (const [rel, expected] of states) {
    if (!stateEquals(await readEngineeringState(rootAbs, rel, bindings), expected)) {
      throw kitError(KIT_ERROR_KINDS.CONFLICT_DRIFT, `engineering update refuses drifted input ${rel}`, { path: rel });
    }
  }
}

function validateEngineeringDocument(document, objectName) {
  const registration = findSchemaByObject(objectName);
  const validation = validateDocument(document, { schemaId: registration.$id, dialect: registration.dialect, policy: "strict" });
  if (!validation.valid) {
    throw new ContractsError(validation.errorCode, `engineering update requires a valid ${objectName}`, { errors: validation.errors });
  }
}

async function projectEngineering(rootAbs, engineering, faultInjector, bindings, runtime) {
  if ((await lstat(rootAbs)).isSymbolicLink()) throw invalidManifest("engineering update requires an ordinary target root");
  const lockedStates = new Map();
  for (const rel of [".foundation/file-registry.json", PROJECT_MANIFEST_PATH, MANAGED_LOCK_PATH]) {
    lockedStates.set(rel, await readEngineeringState(rootAbs, rel, bindings));
  }
  const currentManifest = JSON.parse(lockedStates.get(PROJECT_MANIFEST_PATH).bytes.toString("utf8"));
  const currentLock = JSON.parse(lockedStates.get(MANAGED_LOCK_PATH).bytes.toString("utf8"));
  validateEngineeringDocument(currentManifest, "project-manifest");
  validateEngineeringDocument(currentLock, "managed-file-lock");
  const baseManifest = { ...currentManifest, engineering };
  validateEngineeringDocument(baseManifest, "project-manifest");
  const facts = await loadTargetFacts(rootAbs, bindings ? { rootBinding: bindings.target } : undefined);
  const classes = facts.fileRegistry?.classes;
  const declared = new Set([
    ...(Array.isArray(classes?.managed) ? classes.managed : []),
    ...(classes?.projenManaged?.files ?? []), ...(classes?.kitManaged?.files ?? []),
  ]);
  const managedFiles = Array.isArray(currentManifest.managedFiles) ? [...currentManifest.managedFiles] : [];
  const repairLockMembership = declared.has(MANAGED_LOCK_PATH)
    && managedFiles.includes(PROJECT_MANIFEST_PATH)
    && !managedFiles.includes(MANAGED_LOCK_PATH);
  const desiredManifest = repairLockMembership
    ? { ...baseManifest, managedFiles: [...managedFiles, MANAGED_LOCK_PATH] }
    : baseManifest;
  if (repairLockMembership) validateEngineeringDocument(desiredManifest, "project-manifest");
  for (const rel of [PROJECT_MANIFEST_PATH, MANAGED_LOCK_PATH]) {
    if (!declared.has(rel) || !desiredManifest.managedFiles?.includes(rel)) {
      throw invalidManifest(`engineering update requires a currently managed ${rel}`);
    }
  }
  const lockedPaths = new Set();
  for (const entry of currentLock.entries) {
    if (entry.path === MANAGED_LOCK_PATH || lockedPaths.has(entry.path) || !declared.has(entry.path)) {
      throw invalidManifest("engineering update refuses an unowned or duplicate lock entry", { path: entry.path });
    }
    const state = await readEngineeringState(rootAbs, entry.path, bindings);
    if (state.sha256 !== entry.hash.value) {
      throw kitError(KIT_ERROR_KINDS.CONFLICT_DRIFT, `engineering update refuses drifted managed bytes ${entry.path}`, { path: entry.path });
    }
    lockedPaths.add(entry.path);
    lockedStates.set(entry.path, state);
  }
  for (const rel of new Set([...declared, ...(currentManifest.managedFiles ?? [])])) {
    validatePlanPath(rel, "managed declaration", bindings ? "win32" : undefined);
    if (rel !== MANAGED_LOCK_PATH && !lockedPaths.has(rel)) throw invalidManifest("engineering update refuses an unlocked managed declaration", { path: rel });
  }
  const manifestEntry = currentLock.entries.find(entry => entry.path === PROJECT_MANIFEST_PATH);
  if (manifestEntry?.generator.tool !== KIT_TOOL_NAME) throw invalidManifest("engineering manifest is not owned by the Engineering Kit");
  const references = [
    ...(engineering.entries ?? []).map(entry => entry.physicalRef),
    ...(engineering.releaseUnits ?? []).flatMap(unit => [unit.versionSource.path, ...(unit.versionMirrors ?? []).map(mirror => mirror.path)]),
  ];
  for (const rel of references) {
    const state = await readEngineeringState(rootAbs, rel, bindings);
    const original = lockedStates.get(rel);
    if (original && !stateEquals(state, original)) {
      throw kitError(KIT_ERROR_KINDS.CONFLICT_DRIFT, `engineering reference drifted from its original snapshot ${rel}`, { path: rel });
    }
    if (!original) lockedStates.set(rel, state);
  }
  const manifestBytes = Buffer.from(`${JSON.stringify(desiredManifest, null, 2)}\n`);
  const desiredLock = { ...currentLock, entries: currentLock.entries.map(entry => entry.path === PROJECT_MANIFEST_PATH
    ? { ...entry, hash: { ...entry.hash, value: digestBytes(manifestBytes) } } : entry) };
  const byPath = new Map([
    [PROJECT_MANIFEST_PATH, manifestBytes],
    [MANAGED_LOCK_PATH, Buffer.from(`${JSON.stringify(desiredLock, null, 2)}\n`)],
  ].map(([rel, bytes]) => [rel, { path: rel, bytes, sha256: digestBytes(bytes), mode: lockedStates.get(rel).mode }]));
  if (bindings) {
    const members = [...byPath.values()].map(({ path: rel, sha256 }) => ({ path: rel, type: "file", sha256, mode: null }));
    const manifest = { kind: V2_KIND, schemaVersion: 3, platform: "win32",
      entries: [...byPath.values()].map(record => ({ path: record.path, content: { base64: record.bytes.toString("base64") }, expect: publicState(lockedStates.get(record.path)) })) };
    await verifyEngineeringStates(rootAbs, lockedStates, bindings);
    return runProjectionV3({ rootAbs, facts, manifestPath: null, manifest, externalManifest: false, faultInjector,
      lockedStates, bindings, runtime, rootOutputs: [MANAGED_LOCK_PATH], byteCandidate: {
        rootAbs: null, byPath, closure: canonicalPlanClosure(members, "engineering byte candidate") } });
  }
  const manifest = {
    kind: V2_KIND, schemaVersion: 2,
    candidate: { members: [...byPath.values()].map(({ path: rel, sha256, mode }) => ({ path: rel, sha256, mode })) },
    operations: [...byPath.keys()].map(rel => ({ operation: "write", path: rel, source: rel, owner: { kind: OWNER_KIND, id: KIT_TOOL_NAME }, expect: publicState(lockedStates.get(rel)) })),
    rootOutputs: [MANAGED_LOCK_PATH],
  };
  validateV2Manifest(manifest);
  await verifyEngineeringStates(rootAbs, lockedStates);
  return runProjectionV2({ rootAbs, facts, manifestPath: null, manifest, externalManifest: false, faultInjector, lockedStates,
    verifiedCandidate: { rootAbs: null, byPath, closure: buildProjectionClosure([...byPath.values()].map(({ path: rel, sha256, mode }) => ({ path: rel, sha256, mode }))) } });
}

/** Runs one backward-compatible projection transaction. */
export async function runProjection(options = {}) {
  const { root, manifest: manifestInput, candidateRoot, faultInjector, preparedProjection, engineering,
    operationId, validationTimeoutMs, cooperativeWriters } = options;
  const runtimeKeys = ["operationId", "validationTimeoutMs", "cooperativeWriters"];
  if (process.platform === "win32") {
    if (!runtimeKeys.every(key => Object.hasOwn(options, key)) || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(operationId ?? "") ||
        !Number.isSafeInteger(validationTimeoutMs) || validationTimeoutMs < 1 || validationTimeoutMs > 2147483647 || cooperativeWriters !== true) {
      throw invalidManifest("Windows projection requires explicit operationId, validationTimeoutMs and cooperativeWriters=true");
    }
  } else if (runtimeKeys.some(key => Object.hasOwn(options, key))) throw invalidManifest("Windows projection runtime parameters are not accepted on POSIX");
  if (engineering !== undefined && (manifestInput !== undefined || candidateRoot !== undefined || preparedProjection !== undefined)) {
    throw invalidManifest("engineering cannot be combined with manifest, candidateRoot or preparedProjection");
  }
  const requestedRoot = await resolveTargetRoot(root ?? ".");
  const bindings = process.platform === "win32" ? { target: await createFilesystemRootBinding(requestedRoot) } : undefined;
  const rootAbs = bindings ? (await realpath(requestedRoot)).replaceAll("\\", "/") : requestedRoot;
  const runtime = { operationId, validationTimeoutMs, cooperativeWriters };
  if (engineering !== undefined) return projectEngineering(rootAbs, engineering, faultInjector, bindings, runtime);
  let facts;
  let loaded;
  let verifiedCandidate;
  let canonicalPrepared;
  if (preparedProjection === undefined) {
    facts = await loadTargetFacts(rootAbs, bindings ? { rootBinding: bindings.target } : undefined);
    loaded = await loadProjectionManifest(rootAbs, manifestInput, bindings);
  } else {
    loaded = await loadProjectionManifest(rootAbs, manifestInput, bindings);
    ({ facts, candidate: verifiedCandidate, prepared: canonicalPrepared } = await validatePreparedProjection({
      prepared: preparedProjection,
      rootAbs,
      loaded,
      candidateRoot,
      bindings,
    }));
  }
  if (bindings) {
    if (loaded.manifest.schemaVersion !== 3 || loaded.manifest.platform !== "win32") throw invalidManifest("Windows projection requires manifest v3/platform win32");
    return runProjectionV3({ rootAbs, facts, manifestPath: loaded.manifestPath, manifest: loaded.manifest,
      externalManifest: loaded.external, candidateRoot, faultInjector, verifiedCandidate, preparedProjection: canonicalPrepared, bindings, runtime });
  }
  if (loaded.manifest.schemaVersion === 3) throw invalidManifest("Windows manifest v3 is not accepted on POSIX");
  if (loaded.manifest.schemaVersion === 1) {
    if (candidateRoot !== undefined || faultInjector !== undefined || preparedProjection !== undefined || loaded.external) {
      if (loaded.external) throw invalidManifest("schemaVersion 1 manifest must remain target-local");
    }
    return runProjectionV1({ rootAbs, facts, manifestPath: loaded.manifestPath, manifest: loaded.manifest });
  }
  return runProjectionV2({ rootAbs, facts, manifestPath: loaded.manifestPath, manifest: loaded.manifest, externalManifest: loaded.external, candidateRoot, faultInjector, verifiedCandidate, preparedProjection: canonicalPrepared });
}
