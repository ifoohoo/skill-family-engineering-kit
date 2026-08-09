import path from "node:path";
import { canonicalJson, digestDocument, validateDocument } from "skill-family-contracts";
import {
  buildAdapterClosure,
  materializeAdapterBuild,
  verifyAdapterBuildManifest,
} from "skill-family-harness-node";
import { invalidParamsError, kitError, KIT_ERROR_KINDS } from "./errors.mjs";
import { HOST_CAPABILITIES, probeTrustedVersionDriver } from "./host-drivers.mjs";
import { describeHost } from "./host-profiles.mjs";

const FACT_SCHEMA_ID = "https://contracts.skill-family.example/v1/host-capability-fact.json";
const PROBE_RESULT_SCHEMA_ID = "https://contracts.skill-family.example/v1/host-probe-result.json";
const PLAN_SCHEMA_ID = "https://contracts.skill-family.example/v1/host-operation-plan.json";

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
    return validateContract({ schemaVersion: 1, kind: "skill-family.host-probe-result", hostId, support: "unsupported", reason: descriptor.unsupportedReason, facts: [] }, PROBE_RESULT_SCHEMA_ID, "unsupported probe result fails its contract");
  }
  const facts = await probeTrustedVersionDriver({
    hostId,
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
  return validateContract({ schemaVersion: 1, kind: "skill-family.host-probe-result", hostId, support: "supported", facts }, PROBE_RESULT_SCHEMA_ID, "host probe result fails its contract");
}

export async function buildHostAdapter({ hostId, pathCategoryId, input, hostsRoot, registry } = {}) {
  const descriptor = await describeHost({ hostId, hostsRoot, registry });
  if (descriptor.support !== "supported") return { status: "unsupported", reason: descriptor.unsupportedReason };
  return buildAdapterClosure({ hostId, pathCategory: selectCategory(descriptor, pathCategoryId), input });
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

export async function planHost({ hostId, pathCategoryId, buildManifest, probeFacts, hostsRoot, registry } = {}) {
  const descriptor = await describeHost({ hostId, hostsRoot, registry });
  if (descriptor.support !== "supported") {
    const base = { schemaVersion: 1, kind: "skill-family.host-operation-plan", hostId, status: "unsupported", unsupportedReason: descriptor.unsupportedReason, probeFacts: [], actions: [], writeSet: [] };
    return validateContract({ ...base, digest: digestDocument(base) }, PLAN_SCHEMA_ID, "unsupported host plan fails its contract");
  }
  const category = selectCategory(descriptor, pathCategoryId);
  const facts = validateFactSet(hostId, probeFacts);
  const manifest = verifyAdapterBuildManifest(buildManifest, { hostId, pathCategory: category });
  const actions = manifest.members.map((member, index) => ({ sequence: index + 1, kind: "install-file", categoryId: category.id, scope: category.scope, anchor: category.anchor, target: member.target, expect: "absent", sourceSha256: member.sha256 }));
  const writeSet = actions.map(({ categoryId, scope, anchor, target, sourceSha256 }) => ({ categoryId, scope, anchor, target, sourceSha256 }));
  const base = { schemaVersion: 1, kind: "skill-family.host-operation-plan", hostId, status: "planned", pathCategory: category, probeFacts: facts, actions, writeSet };
  const plan = validateContract({ ...base, digest: digestDocument(base) }, PLAN_SCHEMA_ID, "host operation plan fails its contract");
  assertPlanConsistency(plan);
  return plan;
}

export function assertPlanConsistency(planInput) {
  const plan = validateContract(planInput, PLAN_SCHEMA_ID, "host operation plan fails its registered contract");
  const { digest, ...base } = plan;
  if (digestDocument(base) !== digest) throw kitError(KIT_ERROR_KINDS.HOST_CONTRACT_INVALID, "plan digest does not match its content");
  if (plan.status === "unsupported") return true;
  if (plan.actions.length !== plan.writeSet.length) throw kitError(KIT_ERROR_KINDS.HOST_CONTRACT_INVALID, "plan actions/writeSet lengths differ");
  for (let index = 0; index < plan.actions.length; index += 1) {
    const action = plan.actions[index];
    const write = plan.writeSet[index];
    const normalized = path.posix.normalize(action.target);
    if (normalized !== action.target || normalized.startsWith("../") || path.isAbsolute(action.target)) throw invalidParamsError("plan target must be a normalized contained path");
    if (action.sequence !== index + 1 || action.categoryId !== plan.pathCategory.id || action.scope !== plan.pathCategory.scope || action.anchor !== plan.pathCategory.anchor || !action.target.startsWith(`${plan.pathCategory.relPath}/`) || canonicalJson(write) !== canonicalJson({ categoryId: action.categoryId, scope: action.scope, anchor: action.anchor, target: action.target, sourceSha256: action.sourceSha256 })) {
      throw kitError(KIT_ERROR_KINDS.HOST_CONTRACT_INVALID, "plan action, target, writeSet, category and anchor are inconsistent");
    }
  }
  return true;
}

export function refuseHostApply() {
  throw invalidParamsError("host apply is not implemented in the read-only Phase D slice", { action: "apply", stableRefusal: true });
}
