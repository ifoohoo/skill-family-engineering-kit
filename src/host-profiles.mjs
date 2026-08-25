import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateDocument } from "skill-family-contracts";
import { createFilesystemRootBinding, readFileBound } from "skill-family-harness-node";
import { invalidParamsError, kitError, KIT_ERROR_KINDS } from "./errors.mjs";

const HOST_DESCRIPTOR_SCHEMA_ID = "https://contracts.skill-family.example/v1/host-descriptor.json";
const HOST_REGISTRY_SCHEMA_ID = "https://contracts.skill-family.example/v1/host-registry.json";
const HOST_ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;

/** Canonical root of the host Profile closure shipped inside this package. */
export function bundledHostProfilesRoot() {
  return realpathSync(fileURLToPath(new URL("../data/hosts/", import.meta.url)));
}

function validateRegistered(document, schemaId, message) {
  const result = validateDocument(document, { schemaId, dialect: "2020-12", policy: "strict" });
  if (!result.valid) throw kitError(KIT_ERROR_KINDS.HOST_CONTRACT_INVALID, message, { errors: result.errors });
  return result.data;
}

function assertRegistrySemantics(registry) {
  return registry;
}

/**
 * One bound read of a descriptor file yields both the validated descriptor
 * and the raw-byte digest. The digest must come from the same bytes the
 * descriptor was parsed from: a second read could observe a different file.
 */
async function readDescriptorObservation(hostId, hostsRoot) {
  let document;
  let descriptorSha256;
  try {
    const rootBinding = await createFilesystemRootBinding(hostsRoot);
    const descriptorBytes = await readFileBound(hostsRoot, `${hostId}/host-descriptor.json`, { rootBinding });
    descriptorSha256 = descriptorBytes.sha256;
    document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(descriptorBytes.content));
  } catch (cause) {
    if (cause?.code?.startsWith?.("SFC")) throw cause;
    throw kitError(KIT_ERROR_KINDS.HOST_CONTRACT_INVALID, "host descriptor cannot be read or parsed", { hostId, causeKind: cause?.details?.kind ?? "unknown" });
  }
  const descriptor = validateRegistered(document, HOST_DESCRIPTOR_SCHEMA_ID, "host descriptor fails its registered contract");
  if (descriptor.hostId !== hostId) throw kitError(KIT_ERROR_KINDS.HOST_CONTRACT_INVALID, "host descriptor hostId does not match its registry entry", { hostId });
  const categoryIds = descriptor.pathCategories.map((category) => category.id);
  if (new Set(categoryIds).size !== categoryIds.length) throw kitError(KIT_ERROR_KINDS.HOST_CONTRACT_INVALID, "host descriptor has duplicate path category ids", { hostId });
  return { descriptor, descriptorSha256 };
}

async function loadDescriptorObservations(loaded, hostsRoot) {
  const observations = await Promise.all(loaded.hosts.map((hostId) => readDescriptorObservation(hostId, hostsRoot)));
  const descriptors = observations.map((observation) => observation.descriptor);
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
  return { observations, aliases };
}

function resolveObservation(loaded, observations, aliases, hostId) {
  const canonicalHostId = loaded.hosts.includes(hostId) ? hostId : aliases.get(hostId);
  if (!canonicalHostId) throw invalidParamsError(`unknown host: ${hostId}`, { hostId });
  return observations.find((observation) => observation.descriptor.hostId === canonicalHostId);
}

export async function loadHostRegistry({ hostsRoot, registry } = {}) {
  if (registry !== undefined) return Object.freeze(structuredClone(assertRegistrySemantics(validateRegistered(registry, HOST_REGISTRY_SCHEMA_ID, "host registry fails its registered contract"))));
  if (!hostsRoot) throw invalidParamsError("loadHostRegistry requires an explicit hostsRoot or injected registry");
  let document;
  try {
    const rootBinding = await createFilesystemRootBinding(hostsRoot);
    const registryBytes = await readFileBound(hostsRoot, "registry.json", { rootBinding });
    document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(registryBytes.content));
  } catch (cause) {
    if (cause?.code?.startsWith?.("SFC")) throw cause;
    throw kitError(KIT_ERROR_KINDS.HOST_CONTRACT_INVALID, "host registry cannot be read or parsed", { causeKind: cause?.details?.kind ?? "unknown" });
  }
  return Object.freeze(structuredClone(assertRegistrySemantics(validateRegistered(document, HOST_REGISTRY_SCHEMA_ID, "host registry fails its registered contract"))));
}

export async function describeHost({ hostId, hostsRoot, registry } = {}) {
  if (!HOST_ID_PATTERN.test(hostId ?? "")) throw invalidParamsError("describeHost requires a valid hostId");
  return (await observeHostDescriptor({ hostId, hostsRoot, registry })).descriptor;
}

/**
 * Package-internal observation helper: one bound read yields the validated
 * descriptor together with the raw-byte sha256 it was parsed from. Deliberately
 * not part of the public package surface (host verification is the only
 * consumer); `describeHost` keeps returning the descriptor alone.
 */
export async function observeHostDescriptor({ hostId, hostsRoot, registry } = {}) {
  if (!HOST_ID_PATTERN.test(hostId ?? "")) throw invalidParamsError("observeHostDescriptor requires a valid hostId");
  const loaded = await loadHostRegistry({ hostsRoot, registry });
  if (!hostsRoot) throw invalidParamsError("host descriptor resolution requires an explicit hostsRoot");
  const { observations, aliases } = await loadDescriptorObservations(loaded, hostsRoot);
  const observation = resolveObservation(loaded, observations, aliases, hostId);
  return Object.freeze({ descriptor: Object.freeze(structuredClone(observation.descriptor)), descriptorSha256: observation.descriptorSha256 });
}

export async function resolveHostId(options = {}) {
  return (await describeHost(options)).hostId;
}

export { HOST_DESCRIPTOR_SCHEMA_ID, HOST_REGISTRY_SCHEMA_ID };
