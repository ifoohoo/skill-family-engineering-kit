import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { digestDocument, validateDocument } from "skill-family-contracts";
import { createFilesystemRootBinding, digestBytes, observeExecutableIdentity, observeFilesystemTree, readFileBound, superviseProcess } from "skill-family-harness-node";
import { invalidParamsError } from "./errors.mjs";
import { KIMI_DRIVER } from "./host-verification-drivers.mjs";
import { bundledHostProfilesRoot, observeHostDescriptor } from "./host-profiles.mjs";

const REQUEST_SCHEMA = "https://contracts.skill-family.example/v1/skill-family-directory-verification-request.json";
const RESULT_SCHEMA = "https://contracts.skill-family.example/v1/skill-family-directory-verification-result.json";
const ACTION = ["manual-temporary-root-inspection-required"];
const CONTROLLED_KIMI_FIXTURE_PROTOCOL = "skill-family.controlled-kimi-fixture/v1";

function validate(value, schema, message) {
  const check = validateDocument(value, { schemaId: schema, dialect: "2020-12", policy: "strict" });
  if (!check.valid) throw invalidParamsError(message, { errors: check.errors });
  return check.data;
}

function unknownSkills(request) {
  return request.expectedSkills.map((skill) => ({ ...skill, discovery: "unknown", load: "unknown", callId: null, resultId: null }));
}

function baseFacts(request) {
  return { familyTree: request.familyTree, skills: unknownSkills(request), workload: null };
}

function result(request, status, reason, facts, requiredActions = []) {
  return validate({
    schemaVersion: 1,
    kind: "skill-family.skill-family-directory-verification-result",
    operation: "skill-family-directory-verification",
    status,
    requestDigest: digestDocument(request),
    host: request.host,
    facts,
    reason,
    requiredActions,
  }, RESULT_SCHEMA, "skill-family directory verification result fails its registered contract");
}

function ownKeys(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).sort().join(",")
    : "";
}

function contained(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function canonicalDirectory(value, name) {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.normalize(value) !== value || value.includes("\0")) {
    throw invalidParamsError(`${name} must be a normalized absolute path`);
  }
  try {
    if (await realpath(value) !== value || !(await stat(value)).isDirectory()) throw new Error("not-canonical-directory");
  } catch {
    throw invalidParamsError(`${name} must already be a canonical directory`);
  }
  return value;
}

function relativePath(value, name) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || value.includes("\\") ||
      value.startsWith("/") || /^[A-Za-z]:/u.test(value) || value.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw invalidParamsError(`${name} must be a relative POSIX path`);
  }
  return value;
}

function assertRootIsolation(roots) {
  const entries = Object.entries(roots);
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      if (contained(entries[left][1], entries[right][1]) || contained(entries[right][1], entries[left][1])) {
        throw invalidParamsError("Kimi verification roots must be disjoint", { left: entries[left][0], right: entries[right][0] });
      }
    }
  }
}

async function validateBindings(request, bindings) {
  const required = [
    "effectivePrompt", "executableRelPath", "executableRoot", "existingUserStateRoot", "fixtureRoot", "interpreterRoot",
    "outputRoot", "privateEvidenceRoot", "repositoryRoot", "temporaryRoot", "workspaceRoot",
  ];
  if (!bindings || typeof bindings !== "object" || Array.isArray(bindings) ||
      required.some((key) => bindings[key] === undefined) || Object.keys(bindings).some((key) => !required.includes(key))) {
    throw invalidParamsError("skill-family directory verification bindings have missing, prohibited or unknown fields");
  }
  const roots = {};
  for (const name of required.filter((name) => name.endsWith("Root"))) roots[name] = await canonicalDirectory(bindings[name], name);
  assertRootIsolation(roots);
  for (const name of ["outputRoot", "privateEvidenceRoot", "temporaryRoot"]) {
    if ((await readdir(roots[name])).length !== 0) throw invalidParamsError(`${name} must be fresh`);
  }
  const executableRelPath = relativePath(bindings.executableRelPath, "executableRelPath");
  if (path.basename(executableRelPath) !== KIMI_DRIVER.executableBasename) throw invalidParamsError("Kimi executable basename does not match the built-in driver");
  if (!Buffer.isBuffer(bindings.effectivePrompt) || bindings.effectivePrompt.includes(0) ||
      digestBytes(bindings.effectivePrompt) !== request.workload.effectivePromptSha256) {
    throw invalidParamsError("Kimi effective prompt does not match its public digest");
  }
  let prompt;
  try { prompt = new TextDecoder("utf-8", { fatal: true }).decode(bindings.effectivePrompt); }
  catch { throw invalidParamsError("Kimi effective prompt must be valid UTF-8"); }
  const descriptor = await observeHostDescriptor({ hostId: "kimi-code", hostsRoot: bundledHostProfilesRoot() });
  if (request.host.hostId !== KIMI_DRIVER.hostId || request.host.driverId !== KIMI_DRIVER.driverId ||
      request.host.driverVersion !== KIMI_DRIVER.driverVersion || request.host.cliVersion !== KIMI_DRIVER.cliVersion ||
      request.host.descriptorSha256 !== descriptor.descriptorSha256 || descriptor.descriptor.verification?.driverId !== KIMI_DRIVER.driverId) {
    throw invalidParamsError("Kimi request does not match the bundled descriptor and driver");
  }
  const familyBinding = await createFilesystemRootBinding(roots.fixtureRoot);
  const family = await observeFilesystemTree({ root: roots.fixtureRoot, rootBinding: familyBinding });
  if (family.membersDigest !== request.familyTree.membersDigest || family.membersDigest !== request.workload.fixtureClosureDigest) {
    throw invalidParamsError("Kimi family tree does not match its public digest facts");
  }
  for (const expected of request.expectedSkills) {
    const candidates = family.members.filter((member) => member.type === "file" && member.path === `${expected.name}/SKILL.md`);
    if (candidates.length !== 1 || candidates[0].sha256 !== expected.sourceSha256) {
      throw invalidParamsError("Kimi expected skill source does not match the bound family tree", { skill: expected.name });
    }
  }
  const workspaceBinding = await createFilesystemRootBinding(roots.workspaceRoot);
  const workspace = await observeFilesystemTree({ root: roots.workspaceRoot, rootBinding: workspaceBinding });
  if (workspace.membersDigest !== request.workload.protectedWorkspaceClosureDigest) {
    throw invalidParamsError("Kimi protected workspace digest drifted");
  }
  const identityInput = {
    boundRoots: [
      { root: roots.executableRoot, rootBinding: await createFilesystemRootBinding(roots.executableRoot) },
      { root: roots.interpreterRoot, rootBinding: await createFilesystemRootBinding(roots.interpreterRoot) },
    ],
    lookup: { mode: "absolute-path", path: path.join(roots.executableRoot, executableRelPath) },
    interpreterPolicy: { absoluteRoots: [roots.interpreterRoot], pathEntries: [roots.interpreterRoot] },
  };
  return { roots, prompt, familyBinding, workspaceBinding, family, workspace, identityInput };
}

/**
 * Parse the isolated Kimi fixture protocol from a complete raw JSONL stream.
 * The protocol is Foundation-owned test evidence, not an assertion about the
 * official Kimi stream-json grammar, and its output never promotes a public
 * directory result to observed.
 */
export function parseKimiSkillObservation(stdout, expectedSkills) {
  if (typeof stdout !== "string" || !Array.isArray(expectedSkills)) return null;
  const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  const calls = new Map();
  const results = new Map();
  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { return null; }
    if (event?.protocol !== CONTROLLED_KIMI_FIXTURE_PROTOCOL) return null;
    if (event.type === "skill-call" && ownKeys(event) === "callId,protocol,skill,sourceSha256,type" &&
        typeof event.callId === "string" && event.callId && typeof event.skill === "string" && typeof event.sourceSha256 === "string") {
      if (calls.has(event.callId)) return null;
      calls.set(event.callId, event);
    } else if (event.type === "skill-result" && ownKeys(event) === "callId,outcome,protocol,resultId,type" &&
        typeof event.callId === "string" && event.callId && typeof event.resultId === "string" && event.resultId && event.outcome === "succeeded") {
      if (results.has(event.callId)) return null;
      results.set(event.callId, event);
    } else return null;
  }
  const pairs = [];
  for (const expected of expectedSkills) {
    const matching = [...calls.values()].filter((call) => call.skill === expected.name && call.sourceSha256 === expected.sourceSha256);
    if (matching.length !== 1) return null;
    const call = matching[0];
    const paired = results.get(call.callId);
    if (!paired) return null;
    pairs.push(Object.freeze({ name: expected.name, callId: call.callId, resultId: paired.resultId }));
  }
  if (calls.size !== expectedSkills.length || results.size !== expectedSkills.length) return null;
  return Object.freeze(pairs);
}

function execution(envelope) {
  return {
    spawned: envelope?.evidence?.pid !== undefined,
    exitStatus: envelope?.exitStatus ?? null,
    processStatus: envelope?.processStatus ?? null,
    terminationReason: envelope?.terminationReason ?? null,
    watchdogReason: envelope?.watchdogReason ?? null,
    runnerModelOverrideAbsent: true,
  };
}

async function runKimiProcessVerification(request, bindings) {
  const preflight = await validateBindings(request, bindings);
  const timeoutPolicy = (({ schemaVersion: _schemaVersion, kind: _kind, ...policy }) => policy)(request.workload.timeoutPolicy);
  const env = Object.freeze({ NO_COLOR: "1", HOME: preflight.roots.temporaryRoot, TMPDIR: preflight.roots.temporaryRoot, KIMI_CODE_HOME: preflight.roots.temporaryRoot });
  let baselineIdentity = null;
  const invoke = async (step, args) => {
    const identity = await observeExecutableIdentity(preflight.identityInput);
    if (baselineIdentity === null) baselineIdentity = identity.observationDigest;
    else if (identity.observationDigest !== baselineIdentity) {
      const error = new Error("Kimi executable identity drifted between spawns");
      error.boundaryIndeterminate = true;
      throw error;
    }
    const sink = path.join(preflight.roots.privateEvidenceRoot, `kimi-${step}`);
    await mkdir(sink, { mode: 0o700 });
    let durable;
    const envelope = await superviseProcess({
      command: identity.launch.file,
      args: [...identity.launch.argvPrefix, ...args],
      cwd: preflight.roots.workspaceRoot,
      env,
      timeoutPolicy,
      rawSink: { root: sink, stdoutFile: "stdout.bin", stderrFile: "stderr.bin", onClosed: (summary) => { durable = summary; } },
    });
    const sinkBinding = await createFilesystemRootBinding(sink);
    const stdout = await readFileBound(sink, "stdout.bin", { rootBinding: sinkBinding });
    const stderr = await readFileBound(sink, "stderr.bin", { rootBinding: sinkBinding });
    const streams = {
      stdout: { sha256: stdout.sha256, bytes: stdout.bytes, sensitivity: "private" },
      stderr: { sha256: stderr.sha256, bytes: stderr.bytes, sensitivity: "private" },
    };
    if (!durable || durable.stdout?.sha256 !== streams.stdout.sha256 || durable.stderr?.sha256 !== streams.stderr.sha256) {
      const error = new Error("Kimi raw stream changed before publication");
      error.boundaryIndeterminate = true;
      throw error;
    }
    return { envelope, stdout: stdout.content, streams };
  };
  let version;
  try { version = await invoke("version", KIMI_DRIVER.probeArgs); }
  catch (cause) {
    const indeterminate = cause?.boundaryIndeterminate || cause?.details?.boundReadDisposition === "boundary-indeterminate";
    return result(request, indeterminate ? "indeterminate" : "rejected", indeterminate ? "boundary-state-indeterminate" : "executable-observation-mismatch", baseFacts(request), indeterminate ? ACTION : []);
  }
  let versionText;
  try { versionText = new TextDecoder("utf-8", { fatal: true }).decode(version.stdout).trim(); }
  catch { versionText = ""; }
  if (version.envelope.ok !== true || versionText !== KIMI_DRIVER.cliVersion) {
    return result(request, "rejected", "executable-observation-mismatch", baseFacts(request));
  }
  let run;
  try {
    run = await invoke("skills", [
      KIMI_DRIVER.promptFlag,
      preflight.prompt,
      ...KIMI_DRIVER.outputArgs,
      KIMI_DRIVER.skillsDirectoryFlag,
      preflight.roots.fixtureRoot,
    ]);
  } catch (cause) {
    const indeterminate = cause?.boundaryIndeterminate || cause?.details?.boundReadDisposition === "boundary-indeterminate";
    return result(request, indeterminate ? "indeterminate" : "failed", indeterminate ? "boundary-state-indeterminate" : "execution-failed", baseFacts(request), indeterminate ? ACTION : []);
  }
  const familyAfter = await observeFilesystemTree({ root: preflight.roots.fixtureRoot, rootBinding: preflight.familyBinding });
  const workspaceAfter = await observeFilesystemTree({ root: preflight.roots.workspaceRoot, rootBinding: preflight.workspaceBinding });
  const snapshots = {
    family: { preClosureDigest: preflight.family.membersDigest, postClosureDigest: familyAfter.membersDigest },
    fixture: { preClosureDigest: preflight.family.membersDigest, postClosureDigest: familyAfter.membersDigest },
    protectedWorkspace: { preClosureDigest: preflight.workspace.membersDigest, postClosureDigest: workspaceAfter.membersDigest },
  };
  const snapshotsMatch = Object.values(snapshots).every(({ preClosureDigest, postClosureDigest }) => preClosureDigest === postClosureDigest);
  const workload = { execution: execution(run.envelope), streams: run.streams, snapshots, snapshotsMatch };
  const facts = { familyTree: request.familyTree, skills: unknownSkills(request), workload };
  if (!snapshotsMatch) return result(request, "failed", "snapshot-mismatch", facts);
  if (run.envelope.ok !== true) return result(request, "failed", "execution-failed", facts);
  let rawText = "";
  try { rawText = new TextDecoder("utf-8", { fatal: true }).decode(run.stdout); } catch { /* unknown raw protocol */ }
  parseKimiSkillObservation(rawText, request.expectedSkills);
  return result(request, "indeterminate", "official-observation-unavailable", facts, ACTION);
}

/** Public Kimi directory verification entry: request and private bindings only. */
export async function runSkillFamilyDirectoryVerification(options = {}) {
  if (ownKeys(options) !== "bindings,request") {
    throw invalidParamsError("runSkillFamilyDirectoryVerification accepts only request and bindings");
  }
  const normalized = validate(options.request, REQUEST_SCHEMA, "skill-family directory verification request fails its registered contract");
  return runKimiProcessVerification(normalized, options.bindings);
}

export const SKILL_FAMILY_DIRECTORY_REQUEST_SCHEMA = REQUEST_SCHEMA;
export const SKILL_FAMILY_DIRECTORY_RESULT_SCHEMA = RESULT_SCHEMA;
export const SKILL_FAMILY_DIRECTORY_ACTION = ACTION;
export const parseKimiDirectoryObservation = parseKimiSkillObservation;
