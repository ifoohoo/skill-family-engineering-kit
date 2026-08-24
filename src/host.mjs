import path from "node:path";
import { canonicalJson, digestDocument, validateDocument } from "skill-family-contracts";
import {
  buildAdapterClosure,
  createFilesystemRootBinding,
  materializeAdapterBuild,
  publishFileExclusive,
  replaceFileAtomic,
  readFileBound,
  verifyPeerAdapterDirectories,
  verifyAdapterBuildManifest,
} from "skill-family-harness-node";
import { invalidParamsError, kitError, KIT_ERROR_KINDS } from "./errors.mjs";
import { HOST_CAPABILITIES, probeTrustedVersionDriver } from "./host-drivers.mjs";
import { describeHost } from "./host-profiles.mjs";

const FACT_SCHEMA_ID = "https://contracts.skill-family.example/v1/host-capability-fact.json";
const PROBE_RESULT_SCHEMA_ID = "https://contracts.skill-family.example/v1/host-probe-result.json";
const PLAN_SCHEMA_ID = "https://contracts.skill-family.example/v1/host-operation-plan.json";
const PEER_REQUEST_SCHEMA_ID = "https://contracts.skill-family.example/v1/adapter-peer-verification-request.json";

function manualFacts(hostId) {
  return HOST_CAPABILITIES.map((capability) => ({
    schemaVersion: 1,
    kind: "skill-family.host-capability-fact",
    hostId,
    capability,
    state: "unknown",
    evidence: ["No frozen non-interactive driver is registered for this host capability."],
    unknownReason: "driver-limited",
    manualSteps: ["Use the host's documented read-only interface and record this capability independently."],
  }));
}

function validateContract(document, schemaId, message) {
  const result = validateDocument(document, { schemaId, dialect: "2020-12", policy: "strict" });
  if (!result.valid) throw kitError(KIT_ERROR_KINDS.HOST_CONTRACT_INVALID, message, { errors: result.errors });
  return result.data;
}

function selectCategory(descriptor, pathCategoryId) {
  const category = descriptor.pathCategories.find((candidate) => candidate.id === pathCategoryId);
  if (!category) throw invalidParamsError(`host ${descriptor.hostId} does not declare path category ${String(pathCategoryId)}`);
  return { id: category.id, scope: category.scope, anchor: category.anchor, relPath: category.relPath };
}

export async function probeHost({ hostId, hostsRoot, registry, executable, allowSpawn = false, timeoutMs = 5000, runner } = {}) {
  const descriptor = await describeHost({ hostId, hostsRoot, registry });
  if (descriptor.support === "unsupported") {
    return validateContract({ schemaVersion: 1, kind: "skill-family.host-probe-result", hostId: descriptor.hostId, support: "unsupported", reason: descriptor.unsupportedReason, facts: [] }, PROBE_RESULT_SCHEMA_ID, "unsupported probe result fails its contract");
  }
  if (descriptor.support === "manual") {
    const facts = manualFacts(descriptor.hostId).map((fact) => validateContract(fact, FACT_SCHEMA_ID, "manual host fact fails its contract"));
    return validateContract({ schemaVersion: 1, kind: "skill-family.host-probe-result", hostId: descriptor.hostId, support: "manual", reason: "No frozen non-interactive driver is registered; facts require independent manual observation.", facts }, PROBE_RESULT_SCHEMA_ID, "manual host probe result fails its contract");
  }
  const facts = await probeTrustedVersionDriver({
    hostId: descriptor.hostId,
    driverId: descriptor.driverId,
    capabilities: descriptor.probeCapabilities,
    executable,
    allowSpawn,
    timeoutMs,
    runner,
  });
  for (const fact of facts) validateContract(fact, FACT_SCHEMA_ID, "host driver emitted an invalid capability fact");
  const names = facts.map((fact) => fact.capability);
  if (new Set(names).size !== HOST_CAPABILITIES.length || !HOST_CAPABILITIES.every((name) => names.includes(name))) {
    throw kitError(KIT_ERROR_KINDS.HOST_PROBE_FAILED, "host driver did not emit the exact capability fact set");
  }
  return validateContract({ schemaVersion: 1, kind: "skill-family.host-probe-result", hostId: descriptor.hostId, support: "supported", facts }, PROBE_RESULT_SCHEMA_ID, "host probe result fails its contract");
}

export async function buildHostAdapter({ hostId, pathCategoryId, input, hostsRoot, registry } = {}) {
  const descriptor = await describeHost({ hostId, hostsRoot, registry });
  if (descriptor.support !== "supported") return { status: descriptor.support, reason: descriptor.unsupportedReason ?? "No automated local adapter build is registered for this host." };
  return buildAdapterClosure({ hostId: descriptor.hostId, pathCategory: selectCategory(descriptor, pathCategoryId), input });
}

/**
 * Thin public entry: Kit proves the registered host/category binding, then
 * Harness owns peer directory reading and verification. `peerRoots` are the
 * repository adapter-projection roots for the selected declared categories.
 */
export async function verifyHostPeers({ request, peerRoots, hostsRoot, registry } = {}) {
  const verifiedRequest = validateContract(request, PEER_REQUEST_SCHEMA_ID, "peer adapter verification request fails its registered contract");
  if (!hostsRoot) throw invalidParamsError("verifyHostPeers requires an explicit hostsRoot for Profile identity proof");
  const normalized = structuredClone(verifiedRequest);
  for (const peer of normalized.peers) {
    const descriptor = await describeHost({ hostId: peer.hostId, hostsRoot, registry });
    if (descriptor.pathCategories.length === 0) {
      throw invalidParamsError(`host ${descriptor.hostId} has no registered adapter-projection path category`, { hostId: descriptor.hostId });
    }
    const category = selectCategory(descriptor, peer.pathCategory.id);
    if (canonicalJson(category) !== canonicalJson(peer.pathCategory)) {
      throw invalidParamsError(`host ${descriptor.hostId} path category binding does not match its Profile`, { hostId: descriptor.hostId, categoryId: peer.pathCategory.id, scope: peer.pathCategory.scope, anchor: peer.pathCategory.anchor });
    }
    peer.hostId = descriptor.hostId;
    peer.pathCategory = category;
  }
  return verifyPeerAdapterDirectories({ request: normalized, peerRoots });
}

export async function materializeHostBuild(options) {
  return materializeAdapterBuild(options);
}

function validateFactSet(hostId, facts) {
  if (!Array.isArray(facts) || facts.length !== HOST_CAPABILITIES.length) throw invalidParamsError(`planHost requires exactly ${HOST_CAPABILITIES.length} explicit probe facts`);
  for (const fact of facts) {
    validateContract(fact, FACT_SCHEMA_ID, "planHost received an invalid probe fact");
    if (fact.hostId !== hostId) throw invalidParamsError("probe fact hostId does not match the planned host");
  }
  const names = facts.map((fact) => fact.capability);
  if (new Set(names).size !== names.length || !HOST_CAPABILITIES.every((name) => names.includes(name))) throw invalidParamsError("probe facts must cover each capability exactly once");
  return [...facts].sort((left, right) => HOST_CAPABILITIES.indexOf(left.capability) - HOST_CAPABILITIES.indexOf(right.capability));
}

export async function planHost({ hostId, pathCategoryId, buildManifest, probeFacts, operation = "install", previousMembers = [], hostsRoot, registry } = {}) {
  const descriptor = await describeHost({ hostId, hostsRoot, registry });
  const canonicalHostId = descriptor.hostId;
  if (!["install", "update", "uninstall"].includes(operation)) throw invalidParamsError("planHost operation must be install, update or uninstall");
  if (descriptor.support !== "supported") {
    const base = { schemaVersion: 1, kind: "skill-family.host-operation-plan", hostId: descriptor.hostId, status: descriptor.support, unsupportedReason: descriptor.unsupportedReason ?? "No automated local adapter plan is registered for this host.", operation, probeFacts: [], actions: [], writeSet: [] };
    return validateContract({ ...base, digest: digestDocument(base) }, PLAN_SCHEMA_ID, "unsupported host plan fails its contract");
  }
  const category = selectCategory(descriptor, pathCategoryId);
  const facts = validateFactSet(canonicalHostId, probeFacts);
  const manifest = verifyAdapterBuildManifest(buildManifest, { hostId: canonicalHostId, pathCategory: category });
  if (!Array.isArray(previousMembers)) throw invalidParamsError("planHost previousMembers must be an array");
  const previousByTarget = new Map(previousMembers.map((member) => [member.target, member.sha256]));
  const actions = manifest.members.map((member, index) => {
    const expectedSha256 = previousByTarget.get(member.target);
    if (operation !== "install" && !expectedSha256) throw invalidParamsError(`planHost ${operation} requires a previous digest for ${member.target}`);
    return {
      sequence: index + 1,
      kind: "install-file",
      categoryId: category.id,
      scope: category.scope,
      anchor: category.anchor,
      target: member.target,
      expect: operation === "install" ? "absent" : "matching",
      sourceSha256: member.sha256,
      ...(expectedSha256 ? { expectedSha256 } : {}),
    };
  });
  const writeSet = actions.map(({ categoryId, scope, anchor, target, sourceSha256, expectedSha256 }) => ({ categoryId, scope, anchor, target, sourceSha256, ...(expectedSha256 ? { expectedSha256 } : {}) }));
  const base = { schemaVersion: 1, kind: "skill-family.host-operation-plan", hostId: descriptor.hostId, status: "planned", operation, pathCategory: category, probeFacts: facts, actions, writeSet };
  const plan = validateContract({ ...base, digest: digestDocument(base) }, PLAN_SCHEMA_ID, "host operation plan fails its contract");
  assertPlanConsistency(plan);
  return plan;
}

export function assertPlanConsistency(planInput) {
  const plan = validateContract(planInput, PLAN_SCHEMA_ID, "host operation plan fails its registered contract");
  const { digest, ...base } = plan;
  if (digestDocument(base) !== digest) throw kitError(KIT_ERROR_KINDS.HOST_CONTRACT_INVALID, "plan digest does not match its content");
  if (plan.status !== "planned") return true;
  const operation = plan.operation ?? "install";
  if (plan.actions.length !== plan.writeSet.length) throw kitError(KIT_ERROR_KINDS.HOST_CONTRACT_INVALID, "plan actions/writeSet lengths differ");
  for (let index = 0; index < plan.actions.length; index += 1) {
    const action = plan.actions[index];
    const write = plan.writeSet[index];
    const normalized = path.posix.normalize(action.target);
    if (normalized !== action.target || normalized.startsWith("../") || path.isAbsolute(action.target)) throw invalidParamsError("plan target must be a normalized contained path");
    const expectedWrite = { categoryId: action.categoryId, scope: action.scope, anchor: action.anchor, target: action.target, sourceSha256: action.sourceSha256, ...(action.expectedSha256 ? { expectedSha256: action.expectedSha256 } : {}) };
    if (action.sequence !== index + 1 || action.categoryId !== plan.pathCategory.id || action.scope !== plan.pathCategory.scope || action.anchor !== plan.pathCategory.anchor || !action.target.startsWith(`${plan.pathCategory.relPath}/`) || canonicalJson(write) !== canonicalJson(expectedWrite)) {
      throw kitError(KIT_ERROR_KINDS.HOST_CONTRACT_INVALID, "plan action, target, writeSet, category and anchor are inconsistent");
    }
    if (operation === "install" && action.expect !== "absent") throw kitError(KIT_ERROR_KINDS.HOST_CONTRACT_INVALID, "install plans must expect absent targets");
    if (operation !== "install" && action.expect !== "matching") throw kitError(KIT_ERROR_KINDS.HOST_CONTRACT_INVALID, "update and uninstall plans must expect matching targets");
  }
  return true;
}

export function refuseHostApply() {
  throw invalidParamsError("host apply is not implemented in the read-only Phase D slice", { action: "apply", stableRefusal: true });
}

export async function applyHostPlan({ plan: planInput, build, targetRoot, authorizationRef } = {}) {
  const plan = validateContract(planInput, PLAN_SCHEMA_ID, "host operation plan fails its registered contract");
  assertPlanConsistency(plan);
  if (plan.status !== "planned") return { status: "rejected", publicationState: "not-attempted", reason: plan.unsupportedReason };
  if (plan.operation === "uninstall") {
    return { status: "rejected", publicationState: "not-attempted", reason: "manual-recovery-required: uninstall has no safe bound deletion primitive", operation: plan.operation, targets: plan.actions.map((action) => ({ target: action.target, expectedSha256: action.expectedSha256 })) };
  }
  if (typeof authorizationRef !== "string" || authorizationRef.trim() === "") throw invalidParamsError("applyHostPlan requires an explicit authorizationRef");
  if (!build?.manifest || !Array.isArray(build.files)) throw invalidParamsError("applyHostPlan requires the verified build returned by buildHostAdapter");
  const manifest = verifyAdapterBuildManifest(build.manifest, { hostId: plan.hostId, pathCategory: plan.pathCategory });
  const byTarget = new Map(build.files.map((file) => [file.target, file]));
  const rootBinding = await createFilesystemRootBinding(targetRoot);
  const writes = [];
  try {
    for (const action of plan.actions) {
      const file = byTarget.get(action.target);
      if (!file || file.sha256 !== action.sourceSha256) throw kitError(KIT_ERROR_KINDS.HOST_CONTRACT_INVALID, "host plan member is not bound to the build closure", { target: action.target });
      if (plan.operation === "install") {
        await publishFileExclusive(targetRoot, action.target, file.content, { createParents: true });
      } else {
        await readFileBound(targetRoot, action.target, { rootBinding, expectedSha256: action.expectedSha256 });
        await replaceFileAtomic(targetRoot, action.target, file.content);
      }
      writes.push({ target: action.target, outcome: "succeeded", sha256: file.sha256 });
    }
  } catch (cause) {
    const publicationState = cause?.details?.publicationState === "indeterminate" ? "indeterminate" : "partially-applied";
    return { status: publicationState === "indeterminate" ? "indeterminate" : "partially_applied", publicationState, authorizationRef, operation: plan.operation, writes, reason: cause?.message ?? "host operation failed" };
  }
  return { status: "succeeded", publicationState: "succeeded", authorizationRef, operation: plan.operation, writes, manifestDigest: manifest.digest };
}
