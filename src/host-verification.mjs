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
import { observeHostDescriptor } from "./host-profiles.mjs";
import {
  CLAUDE_DRIVER,
  CODEX_DRIVER,
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
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { digest: digestDocument(entries), entries, binding, name };
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
 * Codex and Qoder freeze their discovery layout structurally: the installed
 * parent must be `<workspace>/.codex/skills` / `<fresh-ws>/.qoder/skills`
 * (basenames `skills` and `.codex` / `.qoder`), so the discovery target can
 * never escape the fresh workspace or reach a real user skill root.
 *
 * Claude freezes the classic plugin layout structurally: the installed
 * parent must be `<plugin-root>/skills` (basename `skills`), so the
 * `--plugin-dir` target (the plugin root above it) always matches the
 * materialization path `<plugin-root>/skills/<skill-id>/SKILL.md`.
 */
async function assertDiscoveryLayout({ driver, installedRoot, existingUserStateRoot }) {
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
  if (driver.driverId === CODEX_DRIVER.driverId) {
    if (path.basename(skillsRoot) !== "skills") throw fail("Codex skills directory must be named skills");
    if (path.basename(path.dirname(skillsRoot)) !== ".codex") throw fail("Codex discovery root must be named .codex");
  }
  if (driver.driverId === QODER_DRIVER.driverId) {
    if (path.basename(skillsRoot) !== "skills") throw fail("Qoder skills directory must be named skills");
    if (path.basename(path.dirname(skillsRoot)) !== ".qoder") throw fail("Qoder discovery root must be named .qoder");
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
  return { skillsRoot, configRoot };
}

/**
 * Driver-fixed environment projection.  Every driver reuses the caller's
 * existing login state; the skill directory and the working directory stay
 * on the fresh isolated roots:
 *
 * - Kimi points KIMI_CODE_HOME at the existing state root and HOME at the
 *   fresh session root;
 * - WorkBuddy points HOME at the existing state root (the user's existing
 *   configuration stays in effect) and CODEBUDDY_CONFIG_DIR at the parent of
 *   the installed parent, so the CLI resolves
 *   `<config>/skills/<skill-id>/SKILL.md`, which is the installed target.
 *   That config root shape is proven by the discovery layout pre-check
 *   (assertDiscoveryLayout) before any spawn; no other skill-directory
 *   environment variable is set.
 * - claude, codex and qoder point HOME at the existing state root only
 *   (their login state lives under HOME); no model override, --config-dir or
 *   CODEX_HOME override is ever projected.
 */
function driverEnvironment({ driver, sessionRoot, existingUserStateRoot, installedParent }) {
  const env = { NO_COLOR: "1" };
  if (driver.driverId === KIMI_DRIVER.driverId) {
    env.HOME = sessionRoot;
    env.KIMI_CODE_HOME = existingUserStateRoot;
  } else {
    env.HOME = existingUserStateRoot;
    if (driver.driverId === WORKBUDDY_DRIVER.driverId) {
      env.CODEBUDDY_CONFIG_DIR = path.dirname(installedParent);
    }
  }
  for (const key of ["LANG", "LC_ALL", "PATH", "TMPDIR", "http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "no_proxy"]) {
    if (typeof process.env[key] === "string") env[key] = process.env[key];
  }
  return env;
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
 * qoder `-p -o json --no-session-persistence --cwd <fresh-ws> <prompt>`
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
    // fresh write roots, and the one-way existing user state rule.  Codex
    // freezes `<workspace>/.codex/skills/<skill-id>` as its sole discovery
    // projection (DES-013 §4.2, R-07): the installed target legitimately sits
    // inside the candidate workspace, which itself sits inside the caller's
    // repository, and its exact position is pinned by the codex branch below
    // (`dirname x3(installedRoot) === workspaceRoot`), so workspaceRoot and
    // repositoryRoot are not compared in this call; every other protected
    // input root stays bidirectionally disjoint.
    assertRootIsolation({
      inputRoots: driver.driverId === CODEX_DRIVER.driverId
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
    if (await stat(installedRoot).then(() => true, () => false)) return rejected();
    const adapterMembers = requiredMembers(bindings, "adapterMembers");
    if (driver.driverId === QODER_DRIVER.driverId && !adapterMembers.includes("SKILL.md")) {
      // R-08: a missing SKILL.md in the adapter table is a statically
      // decidable preflight failure (the sole discovery projection cannot
      // exist) — rejected before materialization with zero side effects.
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
    // S-023: codex exec must start inside the trusted repository tree
    // (R-07), so its process cwd is the candidate workspace, never the fresh
    // session root.  All other drivers keep the fresh session root as cwd.
    const processCwd = driver.driverId === CODEX_DRIVER.driverId ? workspaceRoot : state.sessionRoot;

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
    // Frozen output-protocol judgement.  Only the three 0.12.0 drivers
    // (textProtocol) decode the invocation stdout once more from the
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
