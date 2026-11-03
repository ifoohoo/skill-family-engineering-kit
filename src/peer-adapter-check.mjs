// @feature FND-FR-009
// @scenario S-017
// @scenario S-018
// @design FND-DES-011
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ContractsError, findSchemaByObject, validateDocument } from "skill-family-contracts";
import {
  createFilesystemRootBinding, HARNESS_ERROR_KINDS, observeFilesystemTree,
  verifyPeerAdapterDirectories,
} from "skill-family-harness-node";
import { invalidParamsError } from "./errors.mjs";
import { KIT_TOOL_NAME, KIT_VERSION } from "./skeleton.mjs";
import { resolveTargetRoot } from "./workspace.mjs";

const REQUEST_SCHEMA = "https://contracts.skill-family.example/v1/adapter-peer-verification-request.json";
const MECHANISM_KINDS = new Set(Object.values(HARNESS_ERROR_KINDS));
const LIMITATIONS = [
  "Only the explicit peer roots and their joint source-closure/mapping equivalence were selected; the caller owns selection completeness and actual family/source/adapter relationships.",
  "Each non-anchor peer was checked against one fixed anchor by the existing public peer verifier. This is not an execution of every pair or every internal comparison; a source conflict can stop that call before mapping equality is compared.",
  "Before/after observations bind observed roots and bytes, not an atomic snapshot, a historical generation baseline, or isolation from concurrent writers.",
  "No target code, generator, hook, host installation or network operation was executed. Source authority, independent shared resources, platform metadata and domain compliance require their own applicable checks.",
];

function snapshot(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)
    || Object.keys(options).sort().join(",") !== "peerRoots,request,root"
    || typeof options.root !== "string" || options.root.length === 0) {
    throw invalidParamsError("runPeerAdapterCheck requires only explicit root, request and peerRoots");
  }
  let request;
  let peerRoots;
  try {
    request = structuredClone(options.request);
    peerRoots = structuredClone(options.peerRoots);
  } catch {
    throw invalidParamsError("peer request and roots must be cloneable data");
  }
  const validated = validateDocument(request, { schemaId: REQUEST_SCHEMA, dialect: "2020-12", policy: "strict" });
  if (!validated.valid) throw invalidParamsError("peer request fails its registered contract", { errors: validated.errors });
  const ids = request.peers.map((peer) => peer.peerId);
  if (new Set(ids).size !== ids.length || !peerRoots || typeof peerRoots !== "object" || Array.isArray(peerRoots)
    || !isDeepStrictEqual(Object.keys(peerRoots).sort(), [...ids].sort())) {
    throw invalidParamsError("peerRoots must contain exactly one root for every unique peerId");
  }
  for (const id of ids) {
    const root = peerRoots[id];
    if (typeof root !== "string" || !path.isAbsolute(root) || path.normalize(root) !== root) {
      throw invalidParamsError("each peer root must be a normalized absolute path", { peerId: id });
    }
  }
  return { root: options.root, request, peerRoots };
}

function knownFailure(error) {
  if (!(error instanceof ContractsError)) return null;
  if (error.code !== "SFC2003" && !(error.code === "SFC2004" && MECHANISM_KINDS.has(error.details?.kind))) return null;
  return { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: structuredClone(error.details) }) };
}

async function observe(root) {
  const rootBinding = await createFilesystemRootBinding(root);
  const result = await observeFilesystemTree({ root, rootBinding, symlinkPolicy: { mode: "reject" } });
  return {
    rootBinding: result.rootBinding,
    members: result.members.map(({ path: memberPath, type, sha256, bytes, statMode, permissionObservation }) => ({
      path: memberPath, type,
      ...(sha256 === undefined ? {} : { sha256, bytes }),
      ...(statMode === undefined ? {} : { statMode }),
      ...(permissionObservation === undefined ? {} : { permissionObservation }),
    })),
  };
}

function matchesObservation(manifest, observation) {
  const files = observation.members.filter((member) => member.type === "file");
  const members = manifest.sourceClosure.members;
  const byPath = new Map(files.map((member) => [member.path, member]));
  return members.length === files.length && members.every((member) => {
    const file = byPath.get(member.sourcePath);
    return file?.sha256 === member.sha256 && file.bytes === member.bytes;
  });
}

/** Produce a read-only professional result using the existing peer verifier. */
export async function runPeerAdapterCheck(options) {
  const selected = snapshot(options);
  const root = await resolveTargetRoot(selected.root);
  const peers = [...selected.request.peers].sort((left, right) => left.peerId.localeCompare(right.peerId));
  const observations = [];
  for (const peer of peers) {
    const record = { peerId: peer.peerId, root: selected.peerRoots[peer.peerId], before: null, after: null, failures: [] };
    observations.push(record);
    try { record.before = await observe(record.root); } catch (error) {
      const cause = knownFailure(error);
      if (!cause) throw error;
      record.failures.push({ phase: "before", cause });
    }
  }
  const byId = new Map(observations.map((record) => [record.peerId, record]));
  const anchor = peers[0];
  const pairs = [];
  for (const peer of peers.slice(1)) {
    const ids = [anchor.peerId, peer.peerId];
    const request = { ...selected.request, peers: [anchor, peer] };
    const peerRoots = Object.fromEntries(ids.map((id) => [id, selected.peerRoots[id]]));
    const record = {
      id: `pair:${anchor.peerId}:${peer.peerId}:equivalence`, request, peerRoots,
      called: false, status: "insufficient", reason: "required pre-call observation unavailable", result: null, failure: null,
    };
    pairs.push(record);
    if (ids.some((id) => byId.get(id).before === null)) continue;
    record.called = true;
    try {
      record.result = await verifyPeerAdapterDirectories({ request, peerRoots });
      record.status = "pass";
      record.reason = "the public verifier confirmed this anchor pair's joint equivalence";
    } catch (error) {
      const cause = knownFailure(error);
      if (!cause) throw error;
      record.failure = cause;
      if (cause.code === "SFC2004" && cause.details?.kind === "closure-conflict") {
        if (!ids.includes(cause.details.peerId)) throw error;
        record.status = "findings";
        record.reason = "the public verifier rejected this pair's joint equivalence with an attributable closure conflict; internal comparison coverage is not inferred";
      } else {
        record.reason = "the public peer call could not complete under its input/read contract";
      }
    }
  }
  for (const record of observations) {
    if (record.before === null) continue;
    try { record.after = await observe(record.root); } catch (error) {
      const cause = knownFailure(error);
      if (!cause) throw error;
      record.failures.push({ phase: "after", cause });
    }
  }
  for (const pair of pairs) {
    const ids = pair.request.peers.map((peer) => peer.peerId);
    const stable = ids.every((id) => {
      const observation = byId.get(id);
      return observation.before !== null && observation.after !== null
        && isDeepStrictEqual(observation.before, observation.after);
    });
    const bound = pair.result === null || pair.result.peers.every((peer) => {
      const observation = byId.get(peer.peerId);
      return observation && matchesObservation(peer.manifest, observation.before);
    });
    if (!stable || !bound) {
      pair.status = "insufficient";
      pair.reason = "required root/byte observations were unavailable, changed, or did not match the actual peer result; any earlier finding is no longer attributable";
    }
  }
  const done = pairs.filter((pair) => pair.status !== "insufficient");
  const complete = done.length === pairs.length;
  const findings = done.some((pair) => pair.status === "findings");
  const conclusion = {
    schemaVersion: 1, kind: "skill-family.professional-conclusion",
    provider: { id: KIT_TOOL_NAME, version: KIT_VERSION, entry: "runPeerAdapterCheck" },
    subject: { ref: root },
    scope: {
      checked: done.map((pair) => pair.id),
      limitations: [...LIMITATIONS, ...pairs.filter((pair) => pair.status === "insufficient").map((pair) => `${pair.id}: ${pair.reason}`)],
    },
    outcome: {
      completion: complete ? "complete" : done.length > 0 ? "partial" : "not-performed",
      code: findings ? "ENGINEERING_FINDINGS" : complete ? "ENGINEERING_CLEAR" : "ENGINEERING_CHECK_INCOMPLETE",
      summary: findings ? "An actual selected anchor pair has a joint-equivalence conflict."
        : complete ? "All selected anchor pairs completed without joint-equivalence conflicts."
          : "The selected anchor-pair checks did not completely finish.",
    },
    details: { selection: { request: selected.request, peerRoots: selected.peerRoots }, observations, pairs },
  };
  const registration = findSchemaByObject("professional-conclusion");
  const validated = validateDocument(conclusion, { schemaId: registration.$id, dialect: registration.dialect, policy: "strict" });
  if (!validated.valid) throw new ContractsError("SFC1001", "generated peer conclusion violates its public contract", { errors: validated.errors });
  return validated.data;
}
