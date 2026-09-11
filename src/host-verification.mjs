import { lstat, mkdir, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { canonicalJson, digestDocument, validateDocument } from "skill-family-contracts";
import {
  createFilesystemRootBinding,
  digestBytes,
  publishFileExclusive,
  readFileBound,
  superviseProcess,
} from "skill-family-harness-node";
import { KitError, KIT_ERROR_KINDS, kitError, invalidParamsError } from "./errors.mjs";
import { bundledHostProfilesRoot, observeHostDescriptor } from "./host-profiles.mjs";
import {
  CLAUDE_DRIVER,
  CODEBUDDY_DRIVER,
  CODEX_DRIVER,
  CURSOR_DRIVER,
  driverEnvironment,
  evaluateDriverStreamProtocol,
  getBuiltInHostVerificationDriver,
  KIMI_DRIVER,
  QODER_DRIVER,
  WORKBUDDY_DRIVER,
} from "./host-verification-drivers.mjs";

const REQUEST_SCHEMA = "https://contracts.skill-family.example/v1/host-verification-request.json";
const RESULT_SCHEMA_ID = "https://contracts.skill-family.example/v1/host-verification-result.json";

function fail(message, details = {}) {
  return kitError(KIT_ERROR_KINDS.HOST_CONTRACT_INVALID, message, details);
}

function validateExternalContract(value, schemaId, message) {
  const result = validateDocument(value, { schemaId, dialect: "2020-12", policy: "strict" });
  if (!result.valid) throw new KitError("SFC1001", message, { kind: KIT_ERROR_KINDS.HOST_CONTRACT_INVALID, errors: result.errors });
  return result.data;
}

function validateProducedResult(value) {
  const result = validateDocument(value, { schemaId: RESULT_SCHEMA_ID, dialect: "2020-12", policy: "strict" });
  if (!result.valid) throw fail("host verification produced a result outside its registered contract", { errors: result.errors });
  return result.data;
}

function isWithin(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function requiredBinding(value, name) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0") || path.normalize(value) !== value) {
    throw invalidParamsError(`${name} must be a normalized absolute path`);
  }
  return value;
}

async function canonicalDirectory(value, name) {
  const absolute = requiredBinding(value, name);
  const resolved = await realpath(absolute).catch((cause) => { throw fail(`${name} cannot be canonicalized`, { cause: cause.code }); });
  if (resolved !== absolute) throw fail(`${name} must already be its canonical realpath`);
  const info = await stat(absolute).catch((cause) => { throw fail(`${name} cannot be inspected`, { cause: cause.code }); });
  if (!info.isDirectory()) throw fail(`${name} must be a directory`);
  return absolute;
}

async function assertEmptyDirectory(root, name) {
  if ((await readdir(root)).length !== 0) throw fail(`${name} must be a fresh empty directory`);
}

function requiredMembers(bindings, name) {
  const value = bindings?.[name];
  if (!Array.isArray(value) || value.length === 0 || new Set(value).size !== value.length || value.some((item) => (
    typeof item !== "string" || item.length === 0 || item.includes("\\") || item.startsWith("/") || item.split("/").some((part) => part === "" || part === "." || part === "..")
  ))) throw fail(`${name} must be a non-empty unique POSIX relative member list`);
  return value;
}

function requiredRelative(value, name) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || value.startsWith("/") || value.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw fail(`${name} must be a normalized POSIX relative path`);
  }
  return value;
}

function resultBase(request, status, reason, requiredActions = []) {
  return {
    schemaVersion: 1,
    kind: "skill-family.host-verification-result",
    operation: "host-verification",
    status,
    requestDigest: digestDocument(request),
    common: request.common,
    host: request.host,
    runtimeIdentities: null,
    execution: { spawned: false, exitStatus: null, processStatus: null, terminationReason: null, watchdogReason: null, runnerModelOverrideAbsent: true },
    snapshots: null,
    streams: null,
    reason,
    requiredActions,
  };
}

function validateResult(result) {
  return validateProducedResult(result);
}

async function rootClosure(root, members, name) {
  const binding = await createFilesystemRootBinding(root);
  const entries = [];
  for (const relative of members) {
    const read = await readFileBound(root, relative, { rootBinding: binding });
    entries.push({ path: relative, sha256: read.sha256, bytes: read.bytes });
  }
  return { digest: memberDigest(entries), entries, binding, name };
}

function memberDigest(entries) {
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return digestDocument(entries);
}

async function readBound(root, relative, expectedSha256) {
  const binding = await createFilesystemRootBinding(root);
  return readFileBound(root, relative, { rootBinding: binding, expectedSha256 });
}

async function materializeMembers(sourceRoot, targetRoot, members) {
  const sourceBinding = await createFilesystemRootBinding(sourceRoot);
  const requestedTarget = requiredBinding(targetRoot, "installedSkillRoot");
  const requestedParent = path.dirname(requestedTarget);
  const canonicalParent = await canonicalDirectory(requestedParent, "installedSkillRoot parent");
  if (canonicalParent !== requestedParent || path.join(canonicalParent, path.basename(requestedTarget)) !== requestedTarget) {
    throw fail("installedSkillRoot must be a direct child of its canonical parent");
  }
  if (isWithin(requestedTarget, sourceRoot) || isWithin(sourceRoot, requestedTarget)) {
    throw fail("installedSkillRoot overlaps adapterRoot");
  }
  await mkdir(requestedTarget, { recursive: false, mode: 0o700 });
  const canonicalTarget = await canonicalDirectory(requestedTarget, "installedSkillRoot");
  if (isWithin(canonicalTarget, sourceRoot) || isWithin(sourceRoot, canonicalTarget)) {
    throw fail("installedSkillRoot overlaps adapterRoot");
  }
  const targetBinding = await createFilesystemRootBinding(canonicalTarget);
  for (const relative of members) {
    const read = await readFileBound(sourceRoot, relative, { rootBinding: sourceBinding });
    await publishFileExclusive(canonicalTarget, relative, read.content, { rootBinding: targetBinding, createParents: true, mode: 0o600 });
  }
  return rootClosure(canonicalTarget, members, "installedSkillMembers");
}

function descriptorMatches(descriptor, request) {
  const verification = descriptor.verification;
  // The descriptor's single-value auth pair is the only fact source; the
  // request auth must equal it exactly before any superviseProcess() call
  // (the closed driver table deliberately repeats no auth facts).
  return verification
    && verification.driverId === request.host.driverId
    && verification.authStrategy === request.auth.strategy
    && verification.credentialMutation === request.auth.credentialMutation;
}

function strictUtf8(bytes, name) {
  try {
    // The prompt digest binds the original argv bytes.  Do not let the
    // decoder's default BOM handling silently turn those bytes into a
    // different command argument.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (cause) {
    throw fail(`${name} is not valid UTF-8`, { cause: cause.message });
  }
}

/**
 * One central isolation check over every fresh write root the invocation
 * owns (output, temporary, private evidence, installed skill, WorkBuddy
 * config root) and every protected input root.  Pure lexical checks on
 * canonical normalized paths; zero side effects.  A path boundary, not an
 * operating system sandbox.
 *
 * - Fresh write roots are pairwise bidirectionally disjoint (ancestor or
 *   descendant both refused — a nested target would write through it, and a
 *   target above it would shadow it).
 * - Every fresh write root is bidirectionally disjoint from every protected
 *   input root.
 * - One-way rule between the existing user state root and every fresh write
 *   root: the state root may contain a fresh write root (the caller owns
 *   both), but it may never equal or sit inside one — a write root around
 *   the state root would let the invocation write or clean through it.
 *   Foundation itself never reads the state root content, digests, cleans or
 *   writes it through the binding, and no state facts enter the public
 *   result.  Read-only roots (repository, candidate, fixture, workspace,
 *   adapter) may sit anywhere under the state root.
 *
 * The WorkBuddy config root legitimately contains the installed skill root,
 * so the two are checked in separate calls and never compared against each
 * other.
 */
function assertRootIsolation({ inputRoots, writeRoots, existingUserStateRoot }) {
  for (const [name, value] of writeRoots) {
    for (const [otherName, otherValue] of inputRoots) {
      if (isWithin(value, otherValue) || isWithin(otherValue, value)) {
        throw fail(`${name} overlaps ${otherName}`);
      }
    }
    for (const [otherName, otherValue] of writeRoots) {
      if (name === otherName) continue;
      if (isWithin(value, otherValue) || isWithin(otherValue, value)) {
        throw fail(`${name} overlaps ${otherName}`);
      }
    }
    if (isWithin(existingUserStateRoot, value)) {
      throw fail(`existingUserStateRoot overlaps ${name}`);
    }
  }
}

/**
 * Driver-aware discovery layout pre-check, all before any mkdir or spawn.
 * Every driver installs exactly `<skills-root>/<skill-id>` and requires the
 * skills root to be empty before materialization.  WorkBuddy additionally
 * derives its config root from the skills root: the skills root basename
 * must be exactly `skills`, the config root must already be a canonical
 * directory containing only the empty `skills/` directory, and `skills/`
 * must be a real (non-symlink) directory.  The WorkBuddy config root is a
 * fresh write root under the same one-way state rule.
 *
 * Codex, Qoder and Cursor freeze their discovery layout structurally: the
 * installed parent must be `<workspace>/.codex/skills`,
 * `<fresh-ws>/.qoder/skills` or `<workspace>/.cursor/skills` (basenames
 * `skills` and `.codex` / `.qoder` / `.cursor`), so the discovery target can
 * never escape the fresh workspace or reach a real user skill root.
 *
 * Claude freezes the classic plugin layout structurally: the installed
 * parent must be `<plugin-root>/skills` (basename `skills`), so the
 * `--plugin-dir` target (the plugin root above it) always matches the
 * materialization path `<plugin-root>/skills/<skill-id>/SKILL.md`.
 */
async function assertDiscoveryLayout({ driver, installedRoot, existingUserStateRoot, allowMissing = false }) {
  const skillsRoot = path.dirname(installedRoot);
  let configRoot = null;
  if (driver.driverId === WORKBUDDY_DRIVER.driverId) {
    if (path.basename(skillsRoot) !== "skills") throw fail("WorkBuddy skills directory must be named skills");
    configRoot = path.dirname(skillsRoot);
    await canonicalDirectory(configRoot, "WorkBuddy config root");
    const configMembers = await readdir(configRoot);
    if (configMembers.length !== 1 || configMembers[0] !== "skills") {
      throw fail("WorkBuddy config root must contain only the empty skills directory");
    }
    const skillsInfo = await lstat(skillsRoot).catch((cause) => { throw fail("WorkBuddy skills directory cannot be inspected", { cause: cause.code }); });
    if (!skillsInfo.isDirectory() || skillsInfo.isSymbolicLink()) {
      throw fail("WorkBuddy skills directory must be a real directory");
    }
    if (isWithin(existingUserStateRoot, configRoot)) throw fail("existingUserStateRoot overlaps WorkBuddy config root");
  }
  if (driver.driverId === CODEBUDDY_DRIVER.driverId) {
    if (path.basename(skillsRoot) !== "skills") throw fail("CodeBuddy skills directory must be named skills");
    const codeBuddyProjectRoot = path.dirname(path.dirname(skillsRoot));
    if (path.basename(path.dirname(skillsRoot)) !== ".codebuddy") throw fail("CodeBuddy discovery root must be named .codebuddy");
    await canonicalDirectory(codeBuddyProjectRoot, "CodeBuddy project root");
    const codeBuddyRoot = path.dirname(skillsRoot);
    const codeBuddyInfo = await lstat(codeBuddyRoot).catch((cause) => { throw fail("CodeBuddy discovery root cannot be inspected", { cause: cause.code }); });
    if (!codeBuddyInfo.isDirectory() || codeBuddyInfo.isSymbolicLink()) {
      throw fail("CodeBuddy discovery root must be a real directory");
    }
    const codeBuddySkillsInfo = await lstat(skillsRoot).catch((cause) => { throw fail("CodeBuddy skills directory cannot be inspected", { cause: cause.code }); });
    if (!codeBuddySkillsInfo.isDirectory() || codeBuddySkillsInfo.isSymbolicLink()) {
      throw fail("CodeBuddy skills directory must be a real directory");
    }
    const projectMembers = await readdir(codeBuddyProjectRoot);
    if (projectMembers.length !== 1 || projectMembers[0] !== ".codebuddy") {
      throw fail("CodeBuddy project root must contain only the empty .codebuddy directory");
    }
    if (isWithin(existingUserStateRoot, codeBuddyProjectRoot)) throw fail("existingUserStateRoot overlaps CodeBuddy project root");
  }
  if (driver.driverId === CODEX_DRIVER.driverId) {
    if (path.basename(skillsRoot) !== "skills") throw fail("Codex skills directory must be named skills");
    if (path.basename(path.dirname(skillsRoot)) !== ".codex") throw fail("Codex discovery root must be named .codex");
  }
  if (driver.driverId === QODER_DRIVER.driverId) {
    if (path.basename(skillsRoot) !== "skills") throw fail("Qoder skills directory must be named skills");
    if (path.basename(path.dirname(skillsRoot)) !== ".qoder") throw fail("Qoder discovery root must be named .qoder");
  }
  if (driver.driverId === CURSOR_DRIVER.driverId) {
    if (path.basename(skillsRoot) !== "skills") throw fail("Cursor skills directory must be named skills");
    if (path.basename(path.dirname(skillsRoot)) !== ".cursor") throw fail("Cursor discovery root must be named .cursor");
    // Preparation checks the same layout before creating missing parents.
    for (const directory of [path.dirname(skillsRoot), skillsRoot]) {
      const info = await lstat(directory).catch((cause) => {
        if (allowMissing && cause.code === "ENOENT") return null;
        throw cause;
      });
      if (info === null) return { skillsRoot, configRoot: null, projectRoot: null };
      await canonicalDirectory(directory, "Cursor discovery directory");
    }
  }
  if (driver.driverId === CLAUDE_DRIVER.driverId) {
    // Classic Claude plugin layout `<plugin-root>/skills/<skill-id>/SKILL.md`:
    // the skills directory basename is pinned so the --plugin-dir target
    // (the plugin root, one segment above) always matches the
    // materialization path.
    if (path.basename(skillsRoot) !== "skills") throw fail("Claude skills directory must be named skills");
  }
  await canonicalDirectory(skillsRoot, "skills directory");
  if ((await readdir(skillsRoot)).length !== 0) throw fail("skills directory must be empty before materialization");
  return {
    skillsRoot,
    configRoot,
    projectRoot: driver.driverId === CODEBUDDY_DRIVER.driverId ? path.dirname(path.dirname(skillsRoot)) : null,
  };
}

/**
 * Driver-fixed invocation vector.  No auto-accept, model override, trust
 * auto-confirmation, permission-bypass or remote-session flag may ever enter
 * this vector; the closed driver table owns every entry byte-exactly.
 *
 * The 0.12.0 drivers trail the prompt after their fixed flag sequence
 * (`promptTrailing`) so the vector matches the frozen argv byte-for-byte:
 * claude `-p --verbose --no-session-persistence --output-format stream-json
 * <prompt> --plugin-dir <dir>`, codex `exec --json --ephemeral <prompt>`,
 * qoder `-p -o json --no-session-persistence --cwd <fresh-ws> <prompt>`,
 * cursor `--print --output-format json --mode ask --sandbox enabled
 * --workspace <workspace> <prompt>`
 * where the --cwd target is the fresh workspace two segments above the
 * installed parent (`<fresh-ws>/.qoder/skills/<skill-id>`).  The claude
 * `--plugin-dir` target is the plugin root one segment above the installed
 * parent (`<plugin-root>/skills/<skill-id>/SKILL.md`, classic plugin
 * layout, `skillsDirectoryTarget: "plugin-root"`).
 */
function driverInvocationArgs({ driver, prompt, installedParent }) {
  if (driver.promptTrailing) {
    const args = driver.subcommand ? [driver.subcommand] : [driver.promptFlag];
    args.push(...driver.outputArgs);
    if (driver.fixedArgs) args.push(...driver.fixedArgs);
    if (driver.cwdFlag) {
      args.push(driver.cwdFlag, path.dirname(path.dirname(installedParent)));
    }
    args.push(prompt);
    if (driver.skillsDirectoryFlag) args.push(driver.skillsDirectoryFlag, skillsDirectoryTarget({ driver, installedParent }));
    return args;
  }
  const args = [driver.promptFlag, prompt, ...driver.outputArgs];
  if (driver.skillsDirectoryFlag) args.push(driver.skillsDirectoryFlag, skillsDirectoryTarget({ driver, installedParent }));
  if (driver.fixedArgs) args.push(...driver.fixedArgs);
  return args;
}

function skillsDirectoryTarget({ driver, installedParent }) {
  // Claude's classic plugin layout resolves `<plugin-root>/skills/<skill-id>/SKILL.md`,
  // so the frozen flag points at the plugin root one segment above the
  // installed parent; every other driver points at the installed parent
  // itself (`<skills-dir>/<skill-id>/SKILL.md`).
  return driver.skillsDirectoryTarget === "plugin-root" ? path.dirname(installedParent) : installedParent;
}

function publicExecution(envelope) {
  return { spawned: true, exitStatus: envelope.exitStatus, processStatus: envelope.processStatus, terminationReason: envelope.terminationReason, watchdogReason: envelope.watchdogReason, runnerModelOverrideAbsent: true };
}

function notInvokedExecution() {
  return { spawned: false, exitStatus: null, processStatus: null, terminationReason: null, watchdogReason: null, runnerModelOverrideAbsent: true };
}

async function streamSummary(root, stdoutPath, stderrPath, durableSummary) {
  const binding = await createFilesystemRootBinding(root);
  const stdout = await readFileBound(root, stdoutPath, { rootBinding: binding });
  const stderr = await readFileBound(root, stderrPath, { rootBinding: binding });
  const summary = {
    stdout: { sha256: stdout.sha256, bytes: stdout.bytes, sensitivity: "private" },
    stderr: { sha256: stderr.sha256, bytes: stderr.bytes, sensitivity: "private" },
  };
  if (!durableSummary
    || durableSummary.stdout?.sha256 !== summary.stdout.sha256
    || durableSummary.stdout?.bytes !== summary.stdout.bytes
    || durableSummary.stderr?.sha256 !== summary.stderr.sha256
    || durableSummary.stderr?.bytes !== summary.stderr.bytes) {
    throw fail("durable raw stream summary does not match bound evidence bytes");
  }
  return summary;
}

async function publishEnvelope(root, rootBinding, member, envelope) {
  await publishFileExclusive(root, member, Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, "utf8"), {
    rootBinding,
    createParents: false,
    mode: 0o600,
  });
}

function preparationObject(value, keys, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Reflect.ownKeys(value).length !== keys.length
    || keys.some((key) => !Object.hasOwn(value, key))) {
    throw invalidParamsError(`${name} must contain exactly ${keys.join(", ")}`);
  }
  return value;
}

function preparationBytes(value, name) {
  if (typeof value !== "string" && !Buffer.isBuffer(value)) throw invalidParamsError(`${name} must be a string or Buffer`);
  return Buffer.from(value);
}

function freezePreparation(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezePreparation(child);
    Object.freeze(value);
  }
  return value;
}

/** Prepares one process-local Cursor invocation; the caller owns all roots. */
export async function prepareHostVerification(options) {
  preparationObject(options, ["hostId", "verificationSetId", "candidate", "skill", "workloadDocument", "fixtureFiles", "workspace", "platformManifest", "effectivePrompt", "executable", "existingUserStateRoot", "sessionRoot", "timeoutPolicy"], "options");
  preparationObject(options.candidate, ["ref", "manifest"], "candidate");
  preparationObject(options.skill, ["root", "entrySkill", "members"], "skill");
  preparationObject(options.workspace, ["repositoryRoot", "root", "protectedMembers"], "workspace");
  preparationObject(options.executable, ["root", "relPath"], "executable");
  if (options.hostId !== CURSOR_DRIVER.hostId) throw invalidParamsError("preparation supports only cursor");
  if (!Array.isArray(options.fixtureFiles) || options.fixtureFiles.length === 0) throw invalidParamsError("fixtureFiles must be non-empty");
  // Copy all caller-owned values before the first await, including Buffers.
  const candidateBytes = preparationBytes(options.candidate.manifest, "candidate.manifest");
  const workloadBytes = preparationBytes(options.workloadDocument, "workloadDocument");
  const platformBytes = preparationBytes(options.platformManifest, "platformManifest");
  const promptBytes = preparationBytes(options.effectivePrompt, "effectivePrompt");
  const fixtures = options.fixtureFiles.map((file) => {
    preparationObject(file, ["path", "content"], "fixtureFiles member");
    return { path: file.path, content: preparationBytes(file.content, "fixture content") };
  });
  let input;
  let prompt;
  try {
    input = structuredClone({
      verificationSetId: options.verificationSetId, candidateRef: options.candidate.ref,
      skill: options.skill, workspace: options.workspace, executable: options.executable,
      existingUserStateRoot: options.existingUserStateRoot, sessionRoot: options.sessionRoot,
      timeoutPolicy: options.timeoutPolicy,
    });
    requiredMembers({ members: input.skill.members }, "members");
    requiredMembers({ members: input.workspace.protectedMembers }, "members");
    requiredMembers({ members: fixtures.map((file) => file.path) }, "members");
    if (fixtures.some((file) => fixtures.some((other) => other.path !== file.path && other.path.startsWith(`${file.path}/`)))) throw invalidParamsError("fixture file paths must not contain another fixture file");
    for (const relative of [...input.skill.members, ...input.workspace.protectedMembers, ...fixtures.map((file) => file.path), input.skill.entrySkill, input.executable.relPath]) {
      requiredRelative(relative, "member");
      if (relative.includes("\0") || relative.split("/").some((part) => /^[A-Za-z]:/u.test(part))) throw invalidParamsError("member contains an invalid path segment");
    }
    if (input.skill.entrySkill.includes("/") || !input.skill.members.includes("SKILL.md")) throw invalidParamsError("skill requires one entry segment and a SKILL.md member");
    if (path.posix.basename(input.executable.relPath) !== CURSOR_DRIVER.executableBasename) throw invalidParamsError("executable must name cursor-agent inside its explicit root");
    prompt = strictUtf8(promptBytes, "effectivePrompt");
    if (prompt.includes("\0")) throw invalidParamsError("effectivePrompt must not contain NUL");
    for (const root of [input.skill.root, input.workspace.root, input.workspace.repositoryRoot, input.executable.root, input.sessionRoot, input.existingUserStateRoot]) {
      requiredBinding(root, "root");
      if (root.includes("\\")) throw invalidParamsError("root must not contain backslashes");
    }
  } catch (cause) {
    if (cause?.code === "SFC2003") throw cause;
    throw invalidParamsError("invalid host verification preparation fields", { cause: cause.message });
  }
  const timeoutPolicy = validateExternalContract(input.timeoutPolicy, "https://contracts.skill-family.example/v1/timeout-policy.json", "timeoutPolicy fails its registered contract");
  try {
    const hostsRoot = bundledHostProfilesRoot();
    const { descriptor, descriptorSha256 } = await observeHostDescriptor({ hostId: CURSOR_DRIVER.hostId, hostsRoot });
    const driver = getBuiltInHostVerificationDriver(descriptor.verification?.driverId);
    if (driver !== CURSOR_DRIVER) throw fail("Cursor descriptor does not select the fixed driver");
    const repositoryRoot = await canonicalDirectory(input.workspace.repositoryRoot, "repositoryRoot");
    const workspaceRoot = await canonicalDirectory(input.workspace.root, "workspaceRoot");
    const adapterRoot = await canonicalDirectory(input.skill.root, "skill.root");
    const executableRoot = await canonicalDirectory(input.executable.root, "executable.root");
    const existingUserStateRoot = await canonicalDirectory(input.existingUserStateRoot, "existingUserStateRoot");
    const sessionRoot = await canonicalDirectory(input.sessionRoot, "sessionRoot");
    if (!isWithin(workspaceRoot, repositoryRoot)) throw fail("repositoryRoot must contain workspaceRoot");
    await assertEmptyDirectory(sessionRoot, "sessionRoot");
    const inputRoots = [["hostsRoot", hostsRoot], ["repositoryRoot", repositoryRoot], ["workspaceRoot", workspaceRoot], ["adapterRoot", adapterRoot], ["executableRoot", executableRoot]];
    const installedSkillRoot = path.join(workspaceRoot, ".cursor", "skills", input.skill.entrySkill);
    assertRootIsolation({ inputRoots, writeRoots: [["sessionRoot", sessionRoot]], existingUserStateRoot });
    assertRootIsolation({ inputRoots: inputRoots.filter(([name]) => name !== "repositoryRoot" && name !== "workspaceRoot"), writeRoots: [["sessionRoot", sessionRoot], ["installedSkillRoot", installedSkillRoot]], existingUserStateRoot });
    await assertDiscoveryLayout({ driver, installedRoot: installedSkillRoot, existingUserStateRoot, allowMissing: true });
    const adapter = await rootClosure(adapterRoot, input.skill.members, "adapterMembers");
    const workspace = await rootClosure(workspaceRoot, input.workspace.protectedMembers, "protectedWorkspaceMembers");
    const executable = await readBound(executableRoot, input.executable.relPath);
    const request = validateExternalContract({
      schemaVersion: 1, kind: "skill-family.host-verification-request", operation: "host-verification",
      common: {
        verificationSetId: input.verificationSetId, candidateRef: input.candidateRef,
        candidateManifestSha256: digestBytes(candidateBytes), workloadDocumentSha256: digestBytes(workloadBytes),
        fixtureClosureDigest: memberDigest(fixtures.map((file) => ({ path: file.path, sha256: digestBytes(file.content), bytes: file.content.length }))),
        protectedWorkspaceClosureDigest: workspace.digest,
      },
      host: {
        hostId: driver.hostId, descriptorSha256, driverId: driver.driverId, driverVersion: driver.driverVersion,
        platformManifestSha256: digestBytes(platformBytes), adapterClosureDigest: adapter.digest,
        installedSkillClosureDigest: adapter.digest, effectivePromptSha256: digestBytes(promptBytes), executableSha256: executable.sha256,
      },
      auth: { strategy: descriptor.verification.authStrategy, credentialMutation: descriptor.verification.credentialMutation },
      execution: { timeoutPolicy, modelOverridePolicy: "forbidden" },
    }, REQUEST_SCHEMA, "host verification request fails its registered contract");
    const sessionBinding = await createFilesystemRootBinding(sessionRoot);
    const bindings = {
      repositoryRoot, workspaceRoot, adapterRoot, executableRoot, existingUserStateRoot,
      installedSkillRoot, effectivePrompt: prompt, executableRelPath: input.executable.relPath,
      adapterMembers: input.skill.members, protectedWorkspaceMembers: input.workspace.protectedMembers,
      fixtureMembers: fixtures.map((file) => file.path),
      candidateManifestRelPath: "candidate.bin", workloadDocumentRelPath: "workload.bin", platformManifestRelPath: "platform.bin",
    };
    for (const name of ["candidateRoot", "workloadRoot", "fixtureRoot", "platformManifestRoot", "outputRoot", "temporaryRoot", "privateEvidenceRoot"]) {
      if ((await createFilesystemRootBinding(sessionRoot)).digest !== sessionBinding.digest) throw fail("sessionRoot changed during preparation");
      const root = path.join(sessionRoot, name);
      await mkdir(root, { recursive: false, mode: 0o700 });
      bindings[name] = await canonicalDirectory(root, name);
    }
    const evidenceBinding = await createFilesystemRootBinding(bindings.privateEvidenceRoot);
    for (const [root, relative, bytes, expected] of [
      [bindings.candidateRoot, bindings.candidateManifestRelPath, candidateBytes, request.common.candidateManifestSha256],
      [bindings.workloadRoot, bindings.workloadDocumentRelPath, workloadBytes, request.common.workloadDocumentSha256],
      [bindings.platformManifestRoot, bindings.platformManifestRelPath, platformBytes, request.host.platformManifestSha256],
      ...fixtures.map((file) => [bindings.fixtureRoot, file.path, file.content, digestBytes(file.content)]),
    ]) {
      await publishFileExclusive(root, relative, bytes, { createParents: true, mode: 0o600 });
      await readBound(root, relative, expected);
    }
    if ((await rootClosure(bindings.fixtureRoot, bindings.fixtureMembers, "fixtureMembers")).digest !== request.common.fixtureClosureDigest) throw fail("fixture bytes changed during preparation");
    await canonicalDirectory(workspaceRoot, "workspaceRoot");
    assertRootIsolation({ inputRoots, writeRoots: [["sessionRoot", sessionRoot]], existingUserStateRoot });
    await assertDiscoveryLayout({ driver, installedRoot: installedSkillRoot, existingUserStateRoot, allowMissing: true });
    for (const directory of [path.join(workspaceRoot, ".cursor"), path.dirname(installedSkillRoot)]) {
      await mkdir(directory, { recursive: false, mode: 0o700 }).catch((cause) => { if (cause.code !== "EEXIST") throw cause; });
      await canonicalDirectory(directory, "Cursor discovery directory");
    }
    await assertDiscoveryLayout({ driver, installedRoot: installedSkillRoot, existingUserStateRoot });
    freezePreparation(request);
    freezePreparation(bindings);
    const requestDigest = digestDocument(request);
    async function readInvocationStream(result, stream) {
      if (!["stdout", "stderr"].includes(stream)) throw invalidParamsError("stream must be stdout or stderr");
      const normalized = validateExternalContract(result, RESULT_SCHEMA_ID, "host verification result fails its registered contract");
      if (normalized.requestDigest !== requestDigest || canonicalJson(normalized.common) !== canonicalJson(request.common) || canonicalJson(normalized.host) !== canonicalJson(request.host)) throw fail("result does not match this prepared request");
      const summary = normalized.streams?.[stream];
      if (!summary) throw fail("result has no invocation stream summary");
      const read = await readFileBound(bindings.privateEvidenceRoot, `invocation/${stream}.bin`, { rootBinding: evidenceBinding, expectedSha256: summary.sha256 });
      if (read.bytes !== summary.bytes) throw fail("invocation stream byte count differs from its summary");
      return read.content;
    }
    return Object.freeze({ request, bindings, hostsRoot, readInvocationStream });
  } catch (cause) {
    if (cause?.code?.startsWith?.("SFC")) throw cause;
    throw fail("host verification preparation failed", { cause: cause?.code ?? cause?.message });
  }
}

/**
 * Runs one fresh host verification using only an admitted built-in driver.
 * The request auth must match the bundled descriptor exactly; the existing
 * user state root is only projected into the child environment — Foundation
 * never reads its content, digests, cleans or writes it through the binding,
 * and the real host may read, refresh or modify its own state.  No state
 * facts enter the public result.  Auth failures surface as the real CLI's
 * non-zero exit (failed + execution-failed) with the raw error text kept
 * inside the private stream evidence.
 *
 * The session root is created under the caller-owned temporary root and is
 * deliberately never removed here: Foundation cannot prove it is safe to
 * delete, so the caller cleans its exclusive outer temporaryRoot after the
 * call.
 */
export async function runHostVerification({ request, bindings, hostsRoot } = {}) {
  const normalized = validateExternalContract(request, REQUEST_SCHEMA, "host verification request fails its registered contract");
  const { schemaVersion: _schemaVersion, kind: _kind, ...supervisionTimeoutPolicy } = normalized.execution.timeoutPolicy;
  const rejected = (reason = "preflight-rejected", requiredActions = []) => validateResult(resultBase(normalized, "rejected", reason, requiredActions));
  const buildResult = (status, reason, requiredActions = [], extra = {}) => validateResult({ ...resultBase(normalized, status, reason, requiredActions), ...extra });
  if (!bindings || typeof bindings !== "object") throw invalidParamsError("runHostVerification requires private bindings");

  // The session root is tracked only so the process cwd/env can point at it
  // and so a failed mkdir never pretends there is something to clean.  The
  // session itself is intentionally retained for the caller.
  const state = {
    sessionRoot: null,
    processStarted: false,
  };
  let evidenceRoot = null;
  let temporaryRoot = null;

  // Ordered post-process tail: result only.  The retained session stays
  // under the caller-owned temporary root for the caller to clean.
  function finishDeterminedProcess({ status, reason, requiredActions = [], extra = {} }) {
    return buildResult(status, reason, requiredActions, extra);
  }

  // Known preflight refusal after the session root was created: the session
  // is retained (the caller owns the outer temporary root), so the refusal
  // stays a plain rejection.
  function rejectAfterSession() {
    return rejected();
  }

  try {
    if (typeof hostsRoot !== "string") throw invalidParamsError("runHostVerification requires an explicit hostsRoot");
    const descriptorRoot = await canonicalDirectory(hostsRoot, "hostsRoot");
    const { descriptor, descriptorSha256 } = await observeHostDescriptor({ hostId: normalized.host.hostId, hostsRoot: descriptorRoot });
    const driver = getBuiltInHostVerificationDriver(normalized.host.driverId);
    if (!driver || driver.hostId !== normalized.host.hostId || !descriptorMatches(descriptor, normalized)) return rejected();
    if (normalized.host.driverVersion !== driver.driverVersion) return rejected();

    const candidateRoot = await canonicalDirectory(bindings.candidateRoot, "candidateRoot");
    const workloadRoot = await canonicalDirectory(bindings.workloadRoot, "workloadRoot");
    const fixtureRoot = await canonicalDirectory(bindings.fixtureRoot, "fixtureRoot");
    const workspaceRoot = await canonicalDirectory(bindings.workspaceRoot, "workspaceRoot");
    const repositoryRoot = await canonicalDirectory(bindings.repositoryRoot, "repositoryRoot");
    const adapterRoot = await canonicalDirectory(bindings.adapterRoot, "adapterRoot");
    const platformRoot = await canonicalDirectory(bindings.platformManifestRoot, "platformManifestRoot");
    const executableRoot = await canonicalDirectory(bindings.executableRoot, "executableRoot");
    const outputRoot = await canonicalDirectory(bindings.outputRoot, "outputRoot");
    temporaryRoot = await canonicalDirectory(bindings.temporaryRoot, "temporaryRoot");
    evidenceRoot = await canonicalDirectory(bindings.privateEvidenceRoot, "privateEvidenceRoot");
    await assertEmptyDirectory(outputRoot, "outputRoot");
    await assertEmptyDirectory(temporaryRoot, "temporaryRoot");
    await assertEmptyDirectory(evidenceRoot, "privateEvidenceRoot");
    const evidenceBinding = await createFilesystemRootBinding(evidenceRoot);
    const existingUserStateRoot = await canonicalDirectory(bindings.existingUserStateRoot, "existingUserStateRoot");
    if (!isWithin(workspaceRoot, repositoryRoot)) throw fail("repositoryRoot must contain workspaceRoot");
    const inputRoots = [
      ["hostsRoot", descriptorRoot],
      ["repositoryRoot", repositoryRoot],
      ["workspaceRoot", workspaceRoot],
      ["candidateRoot", candidateRoot],
      ["workloadRoot", workloadRoot],
      ["fixtureRoot", fixtureRoot],
      ["adapterRoot", adapterRoot],
      ["platformManifestRoot", platformRoot],
      ["executableRoot", executableRoot],
    ];
    const baseWriteRoots = [
      ["outputRoot", outputRoot],
      ["temporaryRoot", temporaryRoot],
      ["privateEvidenceRoot", evidenceRoot],
    ];
    assertRootIsolation({
      inputRoots,
      writeRoots: baseWriteRoots,
      existingUserStateRoot,
    });
    const candidatePath = requiredRelative(bindings.candidateManifestRelPath, "candidateManifestRelPath");
    const workloadPath = requiredRelative(bindings.workloadDocumentRelPath, "workloadDocumentRelPath");
    const platformPath = requiredRelative(bindings.platformManifestRelPath, "platformManifestRelPath");
    const executablePath = requiredRelative(bindings.executableRelPath, "executableRelPath");
    if (path.basename(executablePath) !== driver.executableBasename) return rejected("executable-observation-mismatch");
    const candidate = await readBound(candidateRoot, candidatePath);
    const workload = await readBound(workloadRoot, workloadPath);
    const platform = await readBound(platformRoot, platformPath);
    const executable = await readBound(executableRoot, executablePath);
    const fixture = await rootClosure(fixtureRoot, requiredMembers(bindings, "fixtureMembers"), "fixtureMembers");
    const workspace = await rootClosure(workspaceRoot, requiredMembers(bindings, "protectedWorkspaceMembers"), "protectedWorkspaceMembers");
    const adapter = await rootClosure(adapterRoot, requiredMembers(bindings, "adapterMembers"), "adapterMembers");
    if (normalized.host.executableSha256 !== executable.sha256) return rejected("executable-observation-mismatch");
    if (normalized.common.candidateManifestSha256 !== candidate.sha256 || normalized.common.workloadDocumentSha256 !== workload.sha256 || normalized.common.fixtureClosureDigest !== fixture.digest || normalized.common.protectedWorkspaceClosureDigest !== workspace.digest || normalized.host.descriptorSha256 !== descriptorSha256 || normalized.host.platformManifestSha256 !== platform.sha256 || normalized.host.adapterClosureDigest !== adapter.digest) return rejected();
    const promptBytes = Buffer.isBuffer(bindings.effectivePrompt) ? bindings.effectivePrompt : typeof bindings.effectivePrompt === "string" ? Buffer.from(bindings.effectivePrompt, "utf8") : null;
    if (promptBytes === null || digestBytes(promptBytes) !== normalized.host.effectivePromptSha256) return rejected();
    // A non-UTF-8 prompt is a known preflight violation (fail() is
    // SFC2004-coded; the outer catch maps it to rejected before spawn).
    strictUtf8(promptBytes, "effectivePrompt");

    // Installed target: overlap refusals, discovery layout pre-checks and
    // existence rejection all run before any mkdir, so a refusal has zero
    // side effects.  The canonical-parent/direct-child and adapter-overlap
    // re-checks live in materializeMembers, still ahead of its mkdir.
    const installedRoot = requiredBinding(bindings.installedSkillRoot, "installedSkillRoot");
    // The install target is a fresh write root: the same central isolation
    // check covers it against every protected input root, the three other
    // fresh write roots, and the one-way existing user state rule.  Codex and
    // Cursor freeze their workspace-local skill roots: the installed target
    // legitimately sits
    // inside the candidate workspace, which itself sits inside the caller's
    // repository, and its exact position is pinned by the driver branches below
    // (`dirname x3(installedRoot) === workspaceRoot`), so workspaceRoot and
    // repositoryRoot are not compared in this call; every other protected
    // input root stays bidirectionally disjoint.
    assertRootIsolation({
      inputRoots: [CODEX_DRIVER.driverId, CURSOR_DRIVER.driverId].includes(driver.driverId)
        ? inputRoots.filter(([name]) => name !== "workspaceRoot" && name !== "repositoryRoot")
        : inputRoots,
      writeRoots: [...baseWriteRoots, ["installedSkillRoot", installedRoot]],
      existingUserStateRoot,
    });
    const discovery = await assertDiscoveryLayout({ driver, installedRoot, existingUserStateRoot });
    if (discovery.configRoot !== null) {
      // The derived config root legitimately contains the installed skill
      // root, so it is checked in its own call (never against installedRoot).
      assertRootIsolation({
        inputRoots,
        writeRoots: [...baseWriteRoots, ["WorkBuddy config root", discovery.configRoot]],
        existingUserStateRoot,
      });
    }
    if (discovery.projectRoot !== null) {
      assertRootIsolation({
        inputRoots,
        writeRoots: [...baseWriteRoots, ["CodeBuddy project root", discovery.projectRoot]],
        existingUserStateRoot,
      });
    }
    if (driver.driverId === QODER_DRIVER.driverId) {
      // The qoder --cwd target (the fresh workspace, two segments above the
      // installed parent) is a fresh write root under the same one-way state
      // rule: the existing user state root may never equal or sit inside it,
      // so the discovery target can never reach a real user skill root.
      const qoderWorkspaceRoot = path.dirname(path.dirname(path.dirname(installedRoot)));
      assertRootIsolation({
        inputRoots,
        writeRoots: [...baseWriteRoots, ["Qoder workspace root", qoderWorkspaceRoot]],
        existingUserStateRoot,
      });
    }
    if (driver.driverId === CODEX_DRIVER.driverId) {
      // R-07: the candidate workspace is the caller's existing git repository
      // (repositoryRoot) — a read-only presence pre-check of
      // repositoryRoot/.git before any spawn; no git command is ever run and
      // --skip-git-repo-check never enters the vector.  The installed parent
      // must be exactly `<workspaceRoot>/.codex/skills`.
      const gitMarker = path.join(repositoryRoot, ".git");
      const gitInfo = await lstat(gitMarker).catch(() => null);
      if (gitInfo === null) return rejected();
      if (path.dirname(path.dirname(path.dirname(installedRoot))) !== workspaceRoot) return rejected();
    }
    if (driver.driverId === CURSOR_DRIVER.driverId
      && path.dirname(path.dirname(path.dirname(installedRoot))) !== workspaceRoot) return rejected();
    if (await stat(installedRoot).then(() => true, () => false)) return rejected();
    const adapterMembers = requiredMembers(bindings, "adapterMembers");
    if ([QODER_DRIVER.driverId, CURSOR_DRIVER.driverId].includes(driver.driverId) && !adapterMembers.includes("SKILL.md")) {
      // A missing SKILL.md in the adapter table is a statically decidable
      // preflight failure for these sole project-level projections — reject
      // before materialization with zero side effects.
      return rejected();
    }
    if (driver.driverId === CODEX_DRIVER.driverId) {
      // F-3: the frozen codex loader fact (S-023/DES-013 §4.2) is that a
      // SKILL.md without legal YAML frontmatter cannot load, but the real
      // CLI only warns on stderr without changing its exit code — not
      // detectable from the CLI contract.  Foundation asserts the delimiter
      // statically before any mkdir or spawn: the first non-empty line of
      // the adapter SKILL.md must start with `---`.  No YAML parsing, no
      // name/description validation, no stderr participation; zero side
      // effects (the bytes are bound-read, never written).
      if (!adapterMembers.includes("SKILL.md")) return rejected();
      const skillText = strictUtf8((await readBound(adapterRoot, "SKILL.md")).content, "codex adapter SKILL.md");
      const firstNonEmptyLine = skillText.split("\n").find((line) => line.trim() !== "");
      if (firstNonEmptyLine === undefined || !firstNonEmptyLine.trim().startsWith("---")) return rejected();
    }
    // Pre-write digest gate: the caller-declared installed skill closure must
    // equal the adapter closure recomputed from the bound member bytes before
    // any mkdir, so a mismatch rejects with zero writes to the install tree,
    // session, evidence and output roots.
    if (normalized.host.installedSkillClosureDigest !== adapter.digest) return rejected();

    // Install from the adapter member table into the fresh target, then the
    // fresh session root under the temporary root.
    let installed;
    try {
      installed = await materializeMembers(adapterRoot, installedRoot, adapterMembers);
      if (installed.digest !== normalized.host.installedSkillClosureDigest) return rejected();
      // The session root is tracked only after mkdir succeeded, so a failed
      // mkdir never pretends there is something to clean.
      const sessionCandidate = path.join(temporaryRoot, `session-${process.pid}-${Date.now()}`);
      await mkdir(sessionCandidate, { recursive: false, mode: 0o700 });
      state.sessionRoot = sessionCandidate;
    } catch (cause) {
      // These operations are still preflight, but the installed target or
      // session may already exist: the session is retained for the caller
      // (who owns the outer temporary root), then reject.
      return rejectAfterSession();
    }
    const probeSinkRoot = path.join(evidenceRoot, "probe");
    try {
      await mkdir(probeSinkRoot, { recursive: false, mode: 0o700 });
    } catch (cause) {
      return rejectAfterSession();
    }
    const env = driverEnvironment({
      driver,
      sessionRoot: state.sessionRoot,
      existingUserStateRoot,
      installedParent: path.dirname(installedRoot),
    });
    // Codex and Cursor must start in the candidate workspace selected by
    // their frozen invocation vectors; all other drivers keep their existing
    // cwd rules.
    const processCwd = [CODEX_DRIVER.driverId, CURSOR_DRIVER.driverId].includes(driver.driverId)
      ? workspaceRoot
      : driver.driverId === CODEBUDDY_DRIVER.driverId
        ? discovery.projectRoot
        : state.sessionRoot;

    // Identity probe. superviseProcess rejects only when the process/stream/
    // sink boundary cannot be proven.  The session always stays retained
    // under the caller-owned temporary root.
    state.processStarted = true;
    let probeDurableStreams = null;
    let probe;
    try {
      probe = await superviseProcess({
        command: executable.path,
        args: driver.probeArgs,
        cwd: processCwd,
        env,
        timeoutPolicy: supervisionTimeoutPolicy,
        rawSink: {
          root: probeSinkRoot,
          stdoutFile: "stdout.bin",
          stderrFile: "stderr.bin",
          onClosed(summary) { probeDurableStreams = summary; },
        },
      });
    } catch (cause) {
      if (cause?.code === "SFC2004") {
        return buildResult("indeterminate", "boundary-state-indeterminate", [
          "manual-temporary-root-inspection-required",
        ]);
      }
      throw cause;
    }
    try {
      await publishEnvelope(evidenceRoot, evidenceBinding, "probe.envelope.json", probe);
    } catch (cause) {
      if (cause?.code !== "SFC2004") throw cause;
      return finishDeterminedProcess({ status: "failed", reason: "private-evidence-publication-failed", extra: { execution: notInvokedExecution() } });
    }
    if (!probe.ok) {
      // Probe started and its failure is determined (non-zero, timeout or
      // failed-to-start).
      return finishDeterminedProcess({ status: "failed", reason: "execution-failed", extra: { execution: notInvokedExecution() } });
    }
    let version;
    let probeStreams;
    try {
      probeStreams = await streamSummary(probeSinkRoot, "stdout.bin", "stderr.bin", probeDurableStreams);
    } catch (cause) {
      if (cause?.code !== "SFC2004") throw cause;
      // The probe stream evidence failed deterministically.
      return finishDeterminedProcess({ status: "failed", reason: "private-evidence-publication-failed", extra: { execution: notInvokedExecution() } });
    }
    try {
      const probeSinkBinding = await createFilesystemRootBinding(probeSinkRoot);
      version = strictUtf8((await readFileBound(probeSinkRoot, "stdout.bin", { rootBinding: probeSinkBinding, expectedSha256: probeStreams.stdout.sha256 })).content, `${driver.hostId} probe output`).trim();
    } catch (cause) {
      // cliVersion missing, unparseable or unreachable: a known failed
      // observation (the closed pattern cannot be satisfied).
      return finishDeterminedProcess({ status: "failed", reason: "executable-observation-mismatch", extra: { execution: notInvokedExecution() } });
    }
    if (!driver.versionPattern.test(version)) {
      // Probe passed but the observed version violates the closed pattern.
      return finishDeterminedProcess({ status: "failed", reason: "executable-observation-mismatch", extra: { execution: notInvokedExecution() } });
    }

    // Business invocation with the same unique supervisor.  A login-state
    // failure surfaces here as the real CLI's non-zero exit: the raw error
    // text stays inside the private stream evidence.
    const invocationSinkRoot = path.join(evidenceRoot, "invocation");
    try {
      await mkdir(invocationSinkRoot, { recursive: false, mode: 0o700 });
    } catch (cause) {
      return finishDeterminedProcess({ status: "failed", reason: "private-evidence-publication-failed", extra: { execution: notInvokedExecution() } });
    }
    let invocationDurableStreams = null;
    let invocation;
    try {
      invocation = await superviseProcess({
        command: executable.path,
        args: driverInvocationArgs({ driver, prompt: strictUtf8(promptBytes, "effectivePrompt"), installedParent: path.dirname(installedRoot) }),
        cwd: processCwd,
        env,
        timeoutPolicy: supervisionTimeoutPolicy,
        rawSink: {
          root: invocationSinkRoot,
          stdoutFile: "stdout.bin",
          stderrFile: "stderr.bin",
          onClosed(summary) { invocationDurableStreams = summary; },
        },
      });
    } catch (cause) {
      if (cause?.code === "SFC2004") {
        return buildResult("indeterminate", "boundary-state-indeterminate", [
          "manual-temporary-root-inspection-required",
        ]);
      }
      throw cause;
    }
    try {
      await publishEnvelope(evidenceRoot, evidenceBinding, "invocation.envelope.json", invocation);
    } catch (cause) {
      if (cause?.code !== "SFC2004") throw cause;
      return finishDeterminedProcess({ status: "failed", reason: "private-evidence-publication-failed", extra: { execution: publicExecution(invocation) } });
    }
    const pre = { installedSkill: installed.digest, fixture: fixture.digest, protectedWorkspace: workspace.digest };
    let postInstalled;
    let postFixture;
    let postWorkspace;
    try {
      postInstalled = await rootClosure(installedRoot, adapterMembers, "installedSkillMembers");
      postFixture = await rootClosure(fixtureRoot, requiredMembers(bindings, "fixtureMembers"), "fixtureMembers");
      postWorkspace = await rootClosure(workspaceRoot, requiredMembers(bindings, "protectedWorkspaceMembers"), "protectedWorkspaceMembers");
    } catch (cause) {
      if (cause?.code !== "SFC2004") throw cause;
      // A member add/remove/change is a determined post-invocation drift;
      // any other unprovable observation folds into indeterminate.
      if (cause?.details?.boundReadDisposition === "member-policy-violation") {
        return finishDeterminedProcess({ status: "failed", reason: "snapshot-mismatch", extra: { execution: publicExecution(invocation) } });
      }
      return finishDeterminedProcess({ status: "indeterminate", reason: "boundary-state-indeterminate", requiredActions: ["manual-temporary-root-inspection-required"], extra: { execution: publicExecution(invocation) } });
    }
    const snapshots = {
      installedSkill: { preClosureDigest: pre.installedSkill, postClosureDigest: postInstalled.digest },
      fixture: { preClosureDigest: pre.fixture, postClosureDigest: postFixture.digest },
      protectedWorkspace: { preClosureDigest: pre.protectedWorkspace, postClosureDigest: postWorkspace.digest },
    };
    const snapshotsStable = Object.values(snapshots).every((snapshot) => snapshot.preClosureDigest === snapshot.postClosureDigest);
    let streams;
    try {
      streams = await streamSummary(invocationSinkRoot, "stdout.bin", "stderr.bin", invocationDurableStreams);
    } catch (cause) {
      if (cause?.code !== "SFC2004") throw cause;
      return finishDeterminedProcess({ status: "failed", reason: "private-evidence-publication-failed", extra: { execution: publicExecution(invocation), snapshots } });
    }
    // Frozen output-protocol judgement.  Drivers marked textProtocol decode
    // the invocation stdout once more from the
    // private evidence (digest-bound) as UTF-8 text and judge the closed
    // driver protocol; the raw text itself never enters the public result.
    // Kimi and WorkBuddy keep their 0.11.0 raw-byte behavior: no decode, no
    // protocol assertion, exit status only, so a non-UTF-8 stdout (e.g. a
    // single 0xff byte with exit 0) keeps its 0.11.0 observed semantics with
    // the stream digests retained.
    let stdoutText;
    if (driver.textProtocol === true) {
      try {
        const invocationSinkBinding = await createFilesystemRootBinding(invocationSinkRoot);
        const stdoutBytes = await readFileBound(invocationSinkRoot, "stdout.bin", { rootBinding: invocationSinkBinding, expectedSha256: streams.stdout.sha256 });
        try {
          stdoutText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(stdoutBytes.content);
        } catch {
          // A non-UTF-8 stdout cannot satisfy a frozen text protocol: output
          // protocol drift, failed closed.
          return finishDeterminedProcess({ status: "failed", reason: "execution-failed", extra: { execution: publicExecution(invocation), snapshots } });
        }
      } catch (cause) {
        if (cause?.code !== "SFC2004") throw cause;
        return finishDeterminedProcess({ status: "failed", reason: "private-evidence-publication-failed", extra: { execution: publicExecution(invocation), snapshots } });
      }
    }
    const outputOk = evaluateDriverStreamProtocol({ driver, stdoutText, exitOk: invocation.ok });
    const status = outputOk && snapshotsStable ? "observed" : "failed";
    const reason = status === "observed" ? null : (snapshotsStable ? "execution-failed" : "snapshot-mismatch");
    return finishDeterminedProcess({
      status,
      reason,
      extra: {
        runtimeIdentities: { cliVersion: version },
        execution: publicExecution(invocation),
        snapshots,
        streams,
      },
    });
  } catch (cause) {
    if (state.processStarted) {
      // Last resort: the process/stream boundary is unknown.  The session
      // stays retained under the caller-owned temporary root, which the
      // caller inspects and cleans.
      return buildResult("indeterminate", "boundary-state-indeterminate", [
        "manual-temporary-root-inspection-required",
      ]);
    }
    if (cause?.code === "SFC2004") return rejected();
    throw cause;
  }
}

/** Pure common-field/request-digest composition; no freshness or per-host equality. */
export function verifyHostVerificationBindings({ results, expectedCommon, expectedRequestDigestByHost } = {}) {
  if (!Array.isArray(results) || results.length < 2) throw invalidParamsError("results must contain at least two host results");
  if (!expectedCommon || typeof expectedCommon !== "object" || !expectedRequestDigestByHost || typeof expectedRequestDigestByHost !== "object") throw invalidParamsError("expected common and request digests are required");
  const expectedHosts = Object.keys(expectedRequestDigestByHost).sort();
  if (expectedHosts.length !== results.length || expectedHosts.some((hostId) => !/^[a-z][a-z0-9-]{1,63}$/u.test(hostId) || !/^[0-9a-f]{64}$/u.test(expectedRequestDigestByHost[hostId]))) {
    throw invalidParamsError("expected request digest keys must exactly name the result hosts with lowercase SHA-256 digests");
  }
  const seen = new Set();
  for (const result of results) {
    const normalized = validateExternalContract(result, RESULT_SCHEMA_ID, "host verification result fails its registered contract");
    if (normalized.status !== "observed") throw fail("only observed host verification results may be composed");
    // The observed result schema already forces snapshots to be present; the
    // pre/post equality is semantic and cannot be expressed by the schema,
    // so every snapshot pair is checked here.
    for (const snapshot of Object.values(normalized.snapshots)) {
      if (snapshot.preClosureDigest !== snapshot.postClosureDigest) throw fail("host verification result snapshot drifted");
    }
    if (seen.has(normalized.host.hostId)) throw fail("duplicate host verification result");
    seen.add(normalized.host.hostId);
    if (canonicalJson(normalized.common) !== canonicalJson(expectedCommon)) throw fail("host verification common fields drifted");
    if (normalized.requestDigest !== expectedRequestDigestByHost[normalized.host.hostId]) throw fail("host verification request digest drifted");
  }
  if (expectedHosts.some((hostId) => !seen.has(hostId))) throw invalidParamsError("expected request digest keys must exactly match result hosts");
  return { status: "bound" };
}
