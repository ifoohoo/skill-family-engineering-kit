import { validateDocument } from "skill-family-contracts";
import { readFileContained } from "skill-family-harness-node";
import { invalidParamsError, kitError, KIT_ERROR_KINDS } from "./errors.mjs";

const HOST_DESCRIPTOR_SCHEMA_ID = "https://contracts.skill-family.example/v1/host-descriptor.json";
const HOST_REGISTRY_SCHEMA_ID = "https://contracts.skill-family.example/v1/host-registry.json";
const HOST_ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;

function validateRegistered(document, schemaId, message) {
  const result = validateDocument(document, { schemaId, dialect: "2020-12", policy: "strict" });
  if (!result.valid) throw kitError(KIT_ERROR_KINDS.HOST_CONTRACT_INVALID, message, { errors: result.errors });
  return result.data;
}

function assertRegistrySemantics(registry) {
  return registry;
}

async function readDescriptor(hostId, hostsRoot) {
  let document;
  try {
    document = JSON.parse((await readFileContained(hostsRoot, `${hostId}/host-descriptor.json`)).toString("utf8"));
  } catch (cause) {
    if (cause?.code?.startsWith?.("SFC")) throw cause;
    throw kitError(KIT_ERROR_KINDS.HOST_CONTRACT_INVALID, "host descriptor cannot be read or parsed", { hostId, causeKind: cause?.details?.kind ?? "unknown" });
  }
  const descriptor = validateRegistered(document, HOST_DESCRIPTOR_SCHEMA_ID, "host descriptor fails its registered contract");
  if (descriptor.hostId !== hostId) throw kitError(KIT_ERROR_KINDS.HOST_CONTRACT_INVALID, "host descriptor hostId does not match its registry entry", { hostId });
  const categoryIds = descriptor.pathCategories.map((category) => category.id);
  if (new Set(categoryIds).size !== categoryIds.length) throw kitError(KIT_ERROR_KINDS.HOST_CONTRACT_INVALID, "host descriptor has duplicate path category ids", { hostId });
  return descriptor;
}

async function loadDescriptors(loaded, hostsRoot) {
  const descriptors = await Promise.all(loaded.hosts.map((hostId) => readDescriptor(hostId, hostsRoot)));
  const canonicalIds = new Set(descriptors.map((descriptor) => descriptor.hostId));
  const aliases = new Map();
  for (const descriptor of descriptors) {
    for (const alias of descriptor.sourceAliases ?? []) {
      if (canonicalIds.has(alias)) throw kitError(KIT_ERROR_KINDS.HOST_CONTRACT_INVALID, "host source alias conflicts with a canonical host id", { alias, hostId: descriptor.hostId });
      const previous = aliases.get(alias);
      if (previous && previous !== descriptor.hostId) throw kitError(KIT_ERROR_KINDS.HOST_CONTRACT_INVALID, "host source alias is ambiguous", { alias, first: previous, second: descriptor.hostId });
      aliases.set(alias, descriptor.hostId);
    }
  }
  return { descriptors, aliases };
}

export async function loadHostRegistry({ hostsRoot, registry } = {}) {
  if (registry !== undefined) return Object.freeze(structuredClone(assertRegistrySemantics(validateRegistered(registry, HOST_REGISTRY_SCHEMA_ID, "host registry fails its registered contract"))));
  if (!hostsRoot) throw invalidParamsError("loadHostRegistry requires an explicit hostsRoot or injected registry");
  let document;
  try {
    document = JSON.parse((await readFileContained(hostsRoot, "registry.json")).toString("utf8"));
  } catch (cause) {
    if (cause?.code?.startsWith?.("SFC")) throw cause;
    throw kitError(KIT_ERROR_KINDS.HOST_CONTRACT_INVALID, "host registry cannot be read or parsed", { causeKind: cause?.details?.kind ?? "unknown" });
  }
  return Object.freeze(structuredClone(assertRegistrySemantics(validateRegistered(document, HOST_REGISTRY_SCHEMA_ID, "host registry fails its registered contract"))));
}

export async function describeHost({ hostId, hostsRoot, registry } = {}) {
  if (!HOST_ID_PATTERN.test(hostId ?? "")) throw invalidParamsError("describeHost requires a valid hostId");
  const loaded = await loadHostRegistry({ hostsRoot, registry });
  if (!hostsRoot) throw invalidParamsError("host descriptor resolution requires an explicit hostsRoot");
  const { descriptors, aliases } = await loadDescriptors(loaded, hostsRoot);
  const canonicalHostId = loaded.hosts.includes(hostId) ? hostId : aliases.get(hostId);
  if (!canonicalHostId) throw invalidParamsError(`unknown host: ${hostId}`, { hostId });
  const descriptor = descriptors.find((candidate) => candidate.hostId === canonicalHostId);
  return Object.freeze(structuredClone(descriptor));
}

export async function resolveHostId(options = {}) {
  return (await describeHost(options)).hostId;
}

export { HOST_DESCRIPTOR_SCHEMA_ID, HOST_REGISTRY_SCHEMA_ID };
