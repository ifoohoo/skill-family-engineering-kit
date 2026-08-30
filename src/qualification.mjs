import { lstat, mkdir, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { validateDocument } from "skill-family-contracts";
import { FOUNDATION_PACKAGE_VERSION as CONTRACTS_PACKAGE_VERSION } from "skill-family-contracts";
import {
  FOUNDATION_PACKAGE_VERSION as HARNESS_PACKAGE_VERSION,
  HARNESS_ERROR_KINDS,
  createTemporaryWorkspace,
  mechanismError,
  readFileContained,
} from "skill-family-harness-node";
import { loadCapabilityCatalog as defaultLoadCapabilityCatalog } from "./capability-assessment.mjs";
import { invalidParamsError, kitError, KIT_ERROR_KINDS } from "./errors.mjs";
import { bundledHostProfilesRoot, observeHostDescriptor } from "./host-profiles.mjs";
import { getBuiltInHostVerificationDriver } from "./host-verification-drivers.mjs";
import {
  PLUGIN_VERIFICATION_REQUEST_SCHEMA,
  PLUGIN_VERIFICATION_RESULT_SCHEMA,
  validateMembers,
  runPluginVerification as defaultRunPluginVerification,
} from "./plugin-verification.mjs";
import { runSkillFamilyDirectoryVerification, SKILL_FAMILY_DIRECTORY_REQUEST_SCHEMA, SKILL_FAMILY_DIRECTORY_RESULT_SCHEMA } from "./skill-family-directory-verification.mjs";
import { KIT_VERSION } from "./version.mjs";

const CAPABILITY_ID = "foundation.kit.plugin-verification";
const DIRECTORY_CAPABILITY_ID = "foundation.kit.skill-family-directory-verification";
const API_ENTRYPOINT = "skill-family-engineering-kit: runPluginVerification";
const DIRECTORY_API_ENTRYPOINT = "skill-family-engineering-kit: runSkillFamilyDirectoryVerification";
const BINDING_KIND = "plugin-verification-bindings-v1";
const RETAINED_STATUSES = new Set(["observed", "failed", "indeterminate"]);
const QUALIFICATION_NOTICE = Symbol("skill-family.qualification-retention-notice");
const INPUT_ROOT_FIELDS = new Set([
  "sourceRoot",
  "executableRoot",
  "interpreterRoot",
  "existingUserStateRoot",
  "fixtureRoot",
  "workspaceRoot",
  "repositoryRoot",
  "outputRoot",
]);
const REQUIRED_BINDING_FIELDS = ["sourceRoot", "sourceManifestRelPath", "sourceMembers"];
const GENERATED_BINDING_FIELDS = new Set(["installContainerRoot", "temporaryRoot", "privateEvidenceRoot"]);

function reject(message, details = {}) {
  throw invalidParamsError(message, { reason: "qualification-preflight", ...details });
}

function catalogReject(message, details = {}) {
  throw kitError(KIT_ERROR_KINDS.CAPABILITY_CATALOG_INVALID, message, details);
}

function contractReject(message, details = {}) {
  throw kitError(KIT_ERROR_KINDS.HOST_CONTRACT_INVALID, message, details);
}

function normalizedAbsolute(value, name) {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.normalize(value) !== value || value.includes("\0")) {
    reject(`${name} must be a normalized absolute path`, { field: name });
  }
  return value;
}

function relativePath(value, name) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value) ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    reject(`${name} must be a relative POSIX path`, { field: name });
  }
  return value;
}

async function canonicalDirectory(value, name) {
  const absolute = normalizedAbsolute(value, name);
  try {
    const entry = await lstat(absolute);
    if (entry.isSymbolicLink()) throw new Error("symlink");
    const actual = await realpath(absolute);
    if (actual !== absolute || !(await stat(actual)).isDirectory()) throw new Error("not-directory");
    return actual;
  } catch {
    reject(`${name} must already be a canonical non-symlink directory`, { field: name, reason: "binding-directory-invalid" });
  }
}

async function readJson(root, relPath, label) {
  if (typeof relPath !== "string" || relPath.length === 0) reject(`${label} is required`, { field: label });
  let bytes;
  try {
    bytes = await readFileContained(root, relPath);
  } catch (cause) {
    if (cause?.code?.startsWith?.("SFC")) throw cause;
    reject(`${label} must name valid JSON contained in --root`, { field: label, cause: cause?.code });
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    reject(`${label} must name valid JSON contained in --root`, { field: label, reason: "invalid-json" });
  }
}

function validateContract(value, schemaId, label) {
  let result;
  try {
    result = validateDocument(value, { schemaId, dialect: "2020-12", policy: "strict" });
  } catch (cause) {
    contractReject(`${label} contract cannot be evaluated`, { cause: cause?.message ?? String(cause) });
  }
  if (!result.valid) contractReject(`${label} fails its registered contract`, { errors: result.errors });
  return result.data;
}

function requiredBindingFields(request) {
  const required = [...REQUIRED_BINDING_FIELDS];
  if (request.source.type === "public-channel" || request.goal === "install-and-invoke" || request.goal === "native-lifecycle") {
    required.push("executableRoot", "executableRelPath", "existingUserStateRoot");
  }
  if (request.source.type === "public-channel") required.push("channelLocator");
  if (request.goal === "install-and-invoke") {
    required.push("effectivePrompt", "fixtureRoot", "workspaceRoot", "repositoryRoot", "outputRoot");
  }
  if (request.goal === "native-lifecycle") required.push("effectivePrompt", "fixtureRoot", "workspaceRoot", "repositoryRoot", "outputRoot", "interpreterRoot");
  return required;
}

async function validateBindings(request, bindings) {
  if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) {
    reject("--bindings must contain a private binding object", { field: "bindings" });
  }
  const isDirectory = request.operation === "skill-family-directory-verification";
  const required = isDirectory
    ? ["effectivePrompt", "executableRoot", "executableRelPath", "existingUserStateRoot", "fixtureRoot", "workspaceRoot", "repositoryRoot", "outputRoot", "interpreterRoot"]
    : requiredBindingFields(request);
  const allowed = new Set(required);
  for (const field of GENERATED_BINDING_FIELDS) {
    if (Object.hasOwn(bindings, field)) reject(`bindings.${field} is owned by qualification and must not be supplied`, { field, reason: "generated-root-supplied" });
  }
  const missing = required.filter((field) => bindings[field] === undefined);
  const unknown = Object.keys(bindings).filter((field) => !allowed.has(field));
  if (missing.length > 0 || unknown.length > 0) {
    reject("plugin verification bindings have missing, prohibited or unknown fields", { missing, unknown });
  }
  const normalized = { ...bindings };
  for (const field of INPUT_ROOT_FIELDS) {
    if (allowed.has(field)) normalized[field] = await canonicalDirectory(bindings[field], `bindings.${field}`);
  }
  if (!isDirectory) relativePath(bindings.sourceManifestRelPath, "bindings.sourceManifestRelPath");
  if (allowed.has("executableRelPath")) relativePath(bindings.executableRelPath, "bindings.executableRelPath");
  if (!isDirectory) {
    if (!Array.isArray(bindings.sourceMembers) || bindings.sourceMembers.length === 0) reject("bindings.sourceMembers must be a nonempty member table", { field: "bindings.sourceMembers" });
    try {
      validateMembers(bindings.sourceMembers);
    } catch (cause) {
      throw cause?.code?.startsWith?.("SFC") ? cause : reject("bindings.sourceMembers must be a valid canonical member table", { field: "bindings.sourceMembers" });
    }
  }
  if (allowed.has("effectivePrompt")) {
    const prompt = bindings.effectivePrompt;
    if (typeof prompt !== "string") reject("bindings.effectivePrompt must be a string", { field: "bindings.effectivePrompt" });
    const encodedPrompt = Buffer.from(prompt, "utf8");
    if (encodedPrompt.toString("utf8") !== prompt) reject("bindings.effectivePrompt must be valid UTF-8 text", { field: "bindings.effectivePrompt" });
    if (prompt.includes("\0") || encodedPrompt.includes(0)) reject("bindings.effectivePrompt must not contain NUL", { field: "bindings.effectivePrompt" });
    if (encodedPrompt.byteLength > 64 * 1024) reject("bindings.effectivePrompt exceeds the 65536-byte limit", { field: "bindings.effectivePrompt" });
    normalized.effectivePrompt = encodedPrompt;
  }
  return normalized;
}

async function loadQualificationCapability(loadCatalog, requestedCapability = CAPABILITY_ID) {
  const loaded = await loadCatalog({ locale: "en" });
  const capabilities = Array.isArray(loaded) ? loaded : loaded?.capabilities;
  if (!Array.isArray(capabilities)) catalogReject("capability catalog has no capabilities array");
  const capability = capabilities.find((candidate) => candidate?.id === requestedCapability);
  if (!capability) catalogReject(`qualification capability is not declared: ${requestedCapability}`, { capability: requestedCapability });
  if (!(capability.stability === "candidate" || capability.stability === "stable") || capability.available !== true) {
    catalogReject(`qualification capability is not a supported available candidate or stable capability: ${requestedCapability}`, { capability: requestedCapability, stability: capability.stability, available: capability.available });
  }
  const qualification = capability.consumerTesting?.manualQualification;
  if (!qualification || qualification.supported !== true) catalogReject(`qualification capability has no supported manualQualification: ${requestedCapability}`, { capability: requestedCapability });
  const isDirectory = requestedCapability === DIRECTORY_CAPABILITY_ID;
  const expected = isDirectory
    ? { apiEntrypoint: DIRECTORY_API_ENTRYPOINT, requestSchemaId: SKILL_FAMILY_DIRECTORY_REQUEST_SCHEMA, resultSchemaId: SKILL_FAMILY_DIRECTORY_RESULT_SCHEMA, bindingKind: "skill-family-directory-verification-bindings-v1" }
    : { apiEntrypoint: API_ENTRYPOINT, requestSchemaId: PLUGIN_VERIFICATION_REQUEST_SCHEMA, resultSchemaId: PLUGIN_VERIFICATION_RESULT_SCHEMA, bindingKind: BINDING_KIND };
  if (
    qualification.default !== "off" ||
    qualification.apiEntrypoint !== expected.apiEntrypoint ||
    qualification.requestSchemaId !== expected.requestSchemaId ||
    qualification.resultSchemaId !== expected.resultSchemaId ||
    qualification.bindingKind !== expected.bindingKind
  ) {
    catalogReject("qualification capability metadata does not bind the fixed qualification API and contracts", { capability: requestedCapability });
  }
  return capability;
}

async function admitCapabilityTuple({ capabilityId, request, hostsRoot }) {
  const rows = capabilityId === CAPABILITY_ID
    ? [
      { hostId: "qoder", driverId: "qodercli-print-v1", mode: "native-lifecycle" },
      { hostId: "workbuddy", driverId: "workbuddy-codebuddy-print-v1", mode: "native-lifecycle" },
    ]
    : [{ hostId: "kimi-code", driverId: "kimi-code-print-v1", mode: "skill-family-directory" }];
  const mode = capabilityId === CAPABILITY_ID ? request.goal === "native-lifecycle" ? "native-lifecycle" : "other" : request.operation === "skill-family-directory-verification" ? "skill-family-directory" : "other";
  const candidate = rows.find((row) => row.hostId === request.host?.hostId && row.mode === mode);
  if (!candidate) contractReject("qualification six-tuple is not an admitted capability/host/mode combination", { capabilityId, hostId: request.host?.hostId, mode });
  const observation = await observeHostDescriptor({ hostId: candidate.hostId, hostsRoot });
  const driver = getBuiltInHostVerificationDriver(request.host.driverId);
  const version = driver?.driverVersion;
  if (
    request.host.hostId !== candidate.hostId ||
    request.host.descriptorSha256 !== observation.descriptorSha256 ||
    request.host.driverId !== candidate.driverId ||
    request.host.driverVersion !== version ||
    !driver || driver.hostId !== candidate.hostId || driver.driverId !== candidate.driverId || driver.driverVersion !== version ||
    (candidate.hostId === "kimi-code" && request.host.cliVersion !== driver.cliVersion)
  ) {
    contractReject("qualification six-tuple does not match the observed descriptor and built-in driver", { capabilityId, hostId: candidate.hostId, driverId: candidate.driverId, driverVersion: version });
  }
  return { observation, driver };
}

async function validateHostAndDriver(request) {
  const hostsRoot = bundledHostProfilesRoot();
  let observation;
  try {
    observation = await observeHostDescriptor({ hostId: request.host.hostId, hostsRoot });
  } catch (cause) {
    if (cause?.code?.startsWith?.("SFC")) throw cause;
    contractReject("request host cannot be resolved from the bundled host profiles");
  }
  if (observation.descriptor.maturity !== "stable") contractReject("qualification requires a stable bundled host profile", { hostId: request.host.hostId });
  if (observation.descriptorSha256 !== request.host.descriptorSha256) contractReject("request host descriptor digest does not match the bundled profile", { hostId: request.host.hostId });
  if (observation.descriptor.verification?.driverId !== request.host.driverId) contractReject("request driver does not match the bundled host profile", { hostId: request.host.hostId });
  const driver = getBuiltInHostVerificationDriver(request.host.driverId);
  if (!driver || driver.hostId !== request.host.hostId || driver.driverId !== request.host.driverId || driver.driverVersion !== request.host.driverVersion) {
    contractReject("request driver identity or version is not a built-in verified driver", { hostId: request.host.hostId, driverId: request.host.driverId, driverVersion: request.host.driverVersion });
  }
  return { hostsRoot, driver };
}

async function createQualificationRoots() {
  let workspace;
  let parentRoot;
  try {
    workspace = await createTemporaryWorkspace({ prefix: "sf-kit-qualification-" });
    const parent = workspace.root;
    const parentEntry = await lstat(parent);
    const parentStat = await stat(parent);
    const parentReal = await realpath(parent);
    parentRoot = parentReal;
    if (parentEntry.isSymbolicLink() || !parentStat.isDirectory() || (parentStat.mode & 0o777) !== 0o700 || (await readdir(parent)).length !== 0) throw new Error("temporary workspace parent is not a fresh 0700 directory");
    const paths = {};
    for (const [name, field] of [["install", "installContainerRoot"], ["temporary", "temporaryRoot"], ["evidence", "privateEvidenceRoot"]]) {
      const child = await workspace.resolve(name);
      await mkdir(child, { mode: 0o700 });
      const childEntry = await lstat(child);
      const childStat = await stat(child);
      const childReal = await realpath(child);
      if (childEntry.isSymbolicLink() || !childStat.isDirectory() || (childStat.mode & 0o777) !== 0o700 || (await readdir(child)).length !== 0 || path.dirname(childReal) !== parentReal) throw new Error(`temporary workspace child is not a fresh 0700 directory: ${name}`);
      paths[field] = childReal;
    }
    const values = Object.values(paths);
    if (new Set(values).size !== values.length || values.some((candidate) => path.dirname(candidate) !== parentReal)) throw new Error("temporary workspace children overlap");
    return { workspace, parentRoot: parentReal, paths };
  } catch (cause) {
    if (workspace) await disposeWithPrecedence(workspace, cause, { parentRoot: parentRoot ?? workspace.root });
    throw kitError(KIT_ERROR_KINDS.HOST_CONTRACT_INVALID, "qualification temporary workspace failed closed", { cause: cause?.message ?? String(cause) });
  }
}

function attachRetentionNotice(result, parentRoot, paths) {
  Object.defineProperty(result, QUALIFICATION_NOTICE, { configurable: false, enumerable: false, value: { parentRoot, privateEvidenceRoot: paths.privateEvidenceRoot } });
  return result;
}

function attachCause(error, cause) {
  Object.defineProperty(error, "cause", { configurable: true, enumerable: false, value: cause });
  return error;
}

function attachNotice(error, notice) {
  Object.defineProperty(error, QUALIFICATION_NOTICE, { configurable: false, enumerable: false, value: notice });
  return error;
}

async function disposeWithPrecedence(workspace, original, notice) {
  try {
    await workspace.dispose();
  } catch (cause) {
    const failure = cause?.details?.kind === HARNESS_ERROR_KINDS.WORKSPACE_DISPOSE_FAILED
      ? cause
      : mechanismError(HARNESS_ERROR_KINDS.WORKSPACE_DISPOSE_FAILED, "qualification workspace cleanup failed");
    attachCause(failure, original);
    if (notice) attachNotice(failure, notice);
    throw failure;
  }
}

/** Package-internal qualification implementation with isolated test seams. */
export async function runQualificationWithTestSeams({
  root = ".",
  capability,
  requestPath,
  bindingsPath,
  native = false,
  loadCapabilityCatalog = defaultLoadCapabilityCatalog,
  runPluginVerification = defaultRunPluginVerification,
  } = {}) {
  if (capability !== CAPABILITY_ID && capability !== DIRECTORY_CAPABILITY_ID) reject(`--capability must be ${CAPABILITY_ID} or ${DIRECTORY_CAPABILITY_ID}`, { field: "capability" });
  if (native !== true) reject("qualification requires --native", { field: "native" });
  if (typeof requestPath !== "string" || requestPath.length === 0) reject("--request is required", { field: "requestPath" });
  if (typeof bindingsPath !== "string" || bindingsPath.length === 0) reject("--bindings is required", { field: "bindingsPath" });
  const versions = { contracts: CONTRACTS_PACKAGE_VERSION, harness: HARNESS_PACKAGE_VERSION, kit: KIT_VERSION };
  if (versions.contracts !== KIT_VERSION || versions.harness !== KIT_VERSION) contractReject("Foundation Contracts and Harness versions must exactly match KIT_VERSION", { versions });
  const rootReal = await realpath(root).catch(() => reject("--root must be an existing directory", { field: "root" }));
  if (!(await stat(rootReal)).isDirectory()) reject("--root must be an existing directory", { field: "root" });
  const capabilityKind = capability === DIRECTORY_CAPABILITY_ID ? "directory" : capability === CAPABILITY_ID ? "plugin" : "unknown";
  if (capabilityKind === "unknown") reject("--capability is not a supported qualification capability", { field: "capability" });
  await loadQualificationCapability(loadCapabilityCatalog, capability);
  const parsedRequest = await readJson(rootReal, requestPath, "--request");
  const parsedBindings = await readJson(rootReal, bindingsPath, "--bindings");
  if (capabilityKind === "directory") {
    const request = validateContract(parsedRequest, SKILL_FAMILY_DIRECTORY_REQUEST_SCHEMA, "skill-family directory verification request");
    const bindings = await validateBindings(request, parsedBindings);
    const profile = await admitCapabilityTuple({ capabilityId: capability, request, hostsRoot: bundledHostProfilesRoot() });
    const { workspace, parentRoot, paths } = await createQualificationRoots();
    const notice = { parentRoot, privateEvidenceRoot: paths.privateEvidenceRoot };
    let normalizedResult;
    try {
      const output = await runSkillFamilyDirectoryVerification({ request, bindings: { ...bindings, ...paths } });
      normalizedResult = validateContract(output, SKILL_FAMILY_DIRECTORY_RESULT_SCHEMA, "skill-family directory verification result");
    } catch (cause) {
      await disposeWithPrecedence(workspace, cause, notice);
      throw cause;
    }
    if (RETAINED_STATUSES.has(normalizedResult.status)) return attachRetentionNotice(normalizedResult, parentRoot, paths);
    await disposeWithPrecedence(workspace, normalizedResult, notice);
    return normalizedResult;
  }
  const request = validateContract(parsedRequest, PLUGIN_VERIFICATION_REQUEST_SCHEMA, "plugin-verification request");
  if (request.goal === "native-lifecycle") {
    const bindings = await validateBindings(request, parsedBindings);
    const profile = await admitCapabilityTuple({ capabilityId: capability, request, hostsRoot: bundledHostProfilesRoot() });
    const { workspace, parentRoot, paths } = await createQualificationRoots();
    const notice = { parentRoot, privateEvidenceRoot: paths.privateEvidenceRoot };
    let normalizedResult;
    try {
      const output = await runPluginVerification({ request, bindings: { ...bindings, ...paths }, hostsRoot: bundledHostProfilesRoot() });
      normalizedResult = validateContract(output, PLUGIN_VERIFICATION_RESULT_SCHEMA, "plugin-verification result");
    } catch (cause) {
      await disposeWithPrecedence(workspace, cause, notice);
      throw cause;
    }
    if (RETAINED_STATUSES.has(normalizedResult.status)) return attachRetentionNotice(normalizedResult, parentRoot, paths);
    await disposeWithPrecedence(workspace, normalizedResult, notice);
    return normalizedResult;
  }
  const bindings = await validateBindings(request, parsedBindings);
  const profile = await validateHostAndDriver(request);
  const { workspace, parentRoot, paths } = await createQualificationRoots();
  const notice = { parentRoot, privateEvidenceRoot: paths.privateEvidenceRoot };
  let normalizedResult;
  try {
    const result = await runPluginVerification({ request, bindings: { ...bindings, ...paths }, hostsRoot: profile.hostsRoot });
    normalizedResult = validateContract(result, PLUGIN_VERIFICATION_RESULT_SCHEMA, "plugin-verification result");
  } catch (cause) {
    await disposeWithPrecedence(workspace, cause, notice);
    throw cause;
  }
  if (RETAINED_STATUSES.has(normalizedResult.status)) return attachRetentionNotice(normalizedResult, parentRoot, paths);
  await disposeWithPrecedence(workspace, normalizedResult, notice);
  return normalizedResult;
}

/** Public qualification entry. Runner and catalog injection are prohibited. */
export async function runQualification(options = {}) {
  const allowed = new Set(["root", "capability", "requestPath", "bindingsPath", "native"]);
  if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some((key) => !allowed.has(key))) {
    throw invalidParamsError("qualification public options contain prohibited or unknown fields", { reason: "qualification-public-options-invalid" });
  }
  return runQualificationWithTestSeams(options);
}

export {
  API_ENTRYPOINT as QUALIFICATION_API_ENTRYPOINT,
  DIRECTORY_API_ENTRYPOINT as DIRECTORY_QUALIFICATION_API_ENTRYPOINT,
  BINDING_KIND as QUALIFICATION_BINDING_KIND,
  CAPABILITY_ID as QUALIFICATION_CAPABILITY_ID,
  DIRECTORY_CAPABILITY_ID as DIRECTORY_QUALIFICATION_CAPABILITY_ID,
  admitCapabilityTuple,
  QUALIFICATION_NOTICE,
};
