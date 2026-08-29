import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { digestDocument, validateDocument } from "skill-family-contracts";
import { createFilesystemRootBinding, digestBytes, observeFilesystemTree, publishFileExclusive, readFileBound, superviseProcess } from "skill-family-harness-node";
import { KitError, KIT_ERROR_KINDS, invalidParamsError, kitError } from "./errors.mjs";
import { driverEnvironment, evaluateDriverStreamProtocol, getBuiltInHostVerificationDriver } from "./host-verification-drivers.mjs";
import { bundledHostProfilesRoot, observeHostDescriptor } from "./host-profiles.mjs";

const REQUEST_SCHEMA = "https://contracts.skill-family.example/v1/plugin-verification-request.json";
const RESULT_SCHEMA = "https://contracts.skill-family.example/v1/plugin-verification-result.json";
const ACTION = ["manual-temporary-root-inspection-required"];
const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
function fail(message, details = {}) { return kitError(KIT_ERROR_KINDS.HOST_CONTRACT_INVALID, message, details); }
function contract(value, schema, message) {
  const check = validateDocument(value, { ...(typeof schema === "string" ? { schemaId: schema } : { schema }), dialect: "2020-12", policy: "strict" });
  if (!check.valid) throw new KitError("SFC1001", message, { kind: KIT_ERROR_KINDS.HOST_CONTRACT_INVALID, errors: check.errors });
  return check.data;
}
function absolute(value, name) {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.normalize(value) !== value || value.includes("\0")) throw invalidParamsError(name + " must be a normalized absolute path");
  return value;
}
async function directory(value, name) {
  const root = absolute(value, name);
  if (await realpath(root) !== root || !(await stat(root)).isDirectory()) throw fail(name + " must already be a canonical directory");
  return root;
}
function relative(value, name) {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/u.test(value) || value.split("/").some(p => !p || p === "." || p === "..")) throw fail(name + " must be a relative POSIX path");
  return value;
}
function contained(candidate, parent) { const rel = path.relative(parent, candidate); return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)); }
function emptyFacts() { return { input: { sourceClosureDigest: null, membersDigest: null, runtimeIdentities: null, probe: null }, install: null, discovery: { status: "not-performed", basis: "none", pluginId: null }, invocation: null }; }
function result(request, status, reason, facts = emptyFacts(), actions = []) {
  return contract({ schemaVersion: 1, kind: "skill-family.plugin-verification-result", operation: "plugin-verification", status, requestDigest: digestDocument(request), goal: request.goal, source: request.source, host: request.host, facts, reason, requiredActions: actions }, RESULT_SCHEMA, "plugin verification result fails its registered contract");
}
function projectMembers(observation) {
  return observation.members.map(member => member.type === "directory" ? { path: member.path, type: "directory" } : {
    path: member.path, type: "file", sha256: member.sha256, bytes: member.bytes, executable: (member.statMode & 0o111) !== 0,
  });
}
export function validateMembers(members) {
  if (!Array.isArray(members) || members.length === 0) throw fail("sourceMembers must be a nonempty canonical member table");
  const seen = new Map(); let previous = null;
  for (const member of members) {
    if (!member || typeof member !== "object" || Array.isArray(member)) throw fail("sourceMembers entry must be an object");
    const rel = relative(member.path, "sourceMembers.path");
    const keys = member.type === "directory" ? ["path", "type"] : ["path", "type", "sha256", "bytes", "executable"];
    if (!["directory", "file"].includes(member.type) || Object.keys(member).length !== keys.length || keys.some(key => !(key in member))) throw fail("sourceMembers entry has unknown or missing fields");
    if (member.type === "file" && (typeof member.sha256 !== "string" || !SHA256.test(member.sha256) || !Number.isSafeInteger(member.bytes) || member.bytes < 0 || typeof member.executable !== "boolean")) throw fail("sourceMembers file facts are invalid");
    if (previous !== null && previous >= rel || seen.has(rel.toLowerCase())) throw fail("sourceMembers paths must be sorted, unique and free of case aliases");
    const parts = rel.split("/");
    for (let count = 1; count < parts.length; count++) if (seen.get(parts.slice(0, count).join("/").toLowerCase()) !== "directory") throw fail("sourceMembers must declare each ancestor directory");
    seen.set(rel.toLowerCase(), member.type); previous = rel;
  }
  return members;
}
function validateBindingFields(request, bindings) {
  const required = ["sourceRoot", "sourceManifestRelPath", "sourceMembers", "installContainerRoot", "temporaryRoot", "privateEvidenceRoot"];
  if (request.source.type === "public-channel" || request.goal === "install-and-invoke") required.push("executableRoot", "executableRelPath", "existingUserStateRoot");
  if (request.source.type === "public-channel") required.push("channelLocator");
  if (request.goal === "install-and-invoke") required.push("effectivePrompt", "fixtureRoot", "workspaceRoot", "repositoryRoot", "outputRoot");
  if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) throw invalidParamsError("runPluginVerification requires private bindings");
  if (required.some(key => bindings[key] === undefined) || Object.keys(bindings).some(key => !required.includes(key))) throw invalidParamsError("plugin verification bindings have missing, prohibited or unknown fields");
}
function assertRootIsolation(roots, sourceRoot, hostsRoot) {
  const writes = ["installContainerRoot", "temporaryRoot", "privateEvidenceRoot", "outputRoot"].filter(key => roots[key]).map(key => roots[key]);
  const reads = [sourceRoot, hostsRoot, ...["executableRoot", "fixtureRoot", "workspaceRoot", "repositoryRoot"].filter(key => roots[key]).map(key => roots[key])];
  for (const write of writes) {
    if (reads.some(read => contained(write, read) || contained(read, write)) || writes.some(other => other !== write && (contained(write, other) || contained(other, write))) || writes.filter(other => other === write).length !== 1) throw fail("plugin verification write roots overlap");
    if (roots.existingUserStateRoot && contained(roots.existingUserStateRoot, write)) throw fail("existing user state root overlaps a write root");
  }
}
function commandObservation(step, envelope, streams, limits) {
  return { step, execution: { spawned: envelope?.evidence?.pid !== undefined, exitStatus: envelope?.exitStatus ?? null, processStatus: envelope?.processStatus ?? null, terminationReason: envelope?.terminationReason ?? null, watchdogReason: envelope?.watchdogReason ?? null, runnerModelOverrideAbsent: true }, streams: streams || null, outputByteLimits: limits || null, outputLimitExceeded: envelope?.evidence?.outputLimitExceeded ?? null };
}
async function observeTreeSafe(root, rootBinding) { try { return await observeFilesystemTree({ root, rootBinding }); } catch (cause) { if (cause?.code === "SFC2004") return null; throw cause; } }
async function readBoundSafe(root, rel, rootBinding) { try { return await readFileBound(root, rel, { rootBinding }); } catch (cause) { if (cause?.code === "SFC2004") return null; throw cause; } }
async function streamSummary(root, durable) {
  const binding = await createFilesystemRootBinding(root);
  const stdout = await readFileBound(root, "stdout.bin", { rootBinding: binding });
  const stderr = await readFileBound(root, "stderr.bin", { rootBinding: binding });
  const streams = { stdout: { sha256: stdout.sha256, bytes: stdout.bytes, sensitivity: "private" }, stderr: { sha256: stderr.sha256, bytes: stderr.bytes, sensitivity: "private" } };
  if (!durable || durable.stdout?.sha256 !== streams.stdout.sha256 || durable.stderr?.sha256 !== streams.stderr.sha256) throw fail("raw stream evidence changed before publication");
  return { streams, stdout: stdout.content };
}
async function runCommand(command, cwd, timeoutPolicy, limits, sink, env) {
  await mkdir(sink, { recursive: false, mode: 0o700 }); let durable = null; let envelope;
  try {
    envelope = await superviseProcess({ command: command.command, args: command.args, cwd, ...(env ? { env } : {}), timeoutPolicy, ...(limits ? { outputByteLimits: limits } : {}), rawSink: { root: sink, stdoutFile: "stdout.bin", stderrFile: "stderr.bin", onClosed: summary => { durable = summary; } } });
    const { streams, stdout } = await streamSummary(sink, durable);
    return { envelope, streams, stdout, observation: commandObservation(command.step, envelope, streams, limits) };
  } catch (cause) {
    const known = envelope ?? (cause?.details?.processStatus ? cause.details : null);
    if (known) cause.commandObservation = commandObservation(command.step, known, null, limits);
    throw cause;
  }
}
function parseJson(bytes) { try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return null; } }
function driverForHost(hostId) { return getBuiltInHostVerificationDriver(hostId === "claude" ? "claude-code-print-v1" : hostId === "codex" ? "codex-exec-v1" : ""); }
function qualifiedPluginVersion(driver, text) {
  const match = typeof text === "string" && driver.versionPattern.exec(text);
  return Boolean(match && `${match[1]}.${match[2]}.${match[3]}` === driver.pluginCliVersion);
}
function qualifiedPluginId(channel) {
  const simple = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;
  if (!simple.test(channel.pluginId) || !simple.test(channel.marketplaceId)) throw fail("channel identities must be simple plugin and marketplace names");
  return `${channel.pluginId}@${channel.marketplaceId}`;
}
function argsFor(driver, step, channel, locator) {
  const id = qualifiedPluginId(channel);
  if (step === "marketplace-add") return driver.hostId === "claude" ? ["plugin", "marketplace", "add", locator] : ["plugin", "marketplace", "add", locator, "--ref", channel.sourceRef, "--json"];
  if (step === "plugin-install") return driver.hostId === "claude" ? ["plugin", "install", id] : ["plugin", "add", id, "--json"];
  return ["plugin", "list", "--json"];
}
export function buildPublicChannelCommands({ hostId, channel, channelLocator }) {
  const driver = driverForHost(hostId);
  if (!driver || !channel || typeof channelLocator !== "string") throw invalidParamsError("unsupported public channel driver or locator");
  return ["marketplace-add", "plugin-install", "plugin-list"].map(step => ({ step, args: argsFor(driver, step, channel, channelLocator) }));
}
function channelEnvironment(driver, roots) {
  // Only the finite channel configuration is redirected. No credential file
  // is read/copied and no caller-controlled environment dictionary is accepted.
  const env = { NO_COLOR: "1", HOME: roots.temporaryRoot, [driver.pluginChannel.configVariable]: roots.installContainerRoot };
  for (const key of ["PATH", "LANG", "LC_ALL", "TMPDIR", "http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "no_proxy"]) if (typeof process.env[key] === "string") env[key] = process.env[key];
  return env;
}
async function nativeJson(root, rel) { return parseJson((await readFileBound(root, rel, { rootBinding: await createFilesystemRootBinding(root) })).content); }
async function detachedHead(root) {
  const text = (await readFileBound(root, ".git/HEAD", { rootBinding: await createFilesystemRootBinding(root) })).content.toString("utf8").trim();
  return COMMIT.test(text) ? text : null;
}
async function discoverChannel(driver, channel, locator, container, outputs) {
  const id = qualifiedPluginId(channel);
  const list = parseJson(outputs["plugin-list"]);
  const marketplaceRoot = path.join(container, driver.pluginChannel.marketplaceDirectory, channel.marketplaceId);
  let installedRoot;
  if (driver.hostId === "claude") {
    const rows = Array.isArray(list) ? list.filter(row => row?.id === id) : [];
    if (rows.length !== 1 || rows[0].scope !== "user" || rows[0].enabled !== true || rows[0].version !== channel.version) return null;
    const installed = await nativeJson(container, "plugins/installed_plugins.json");
    const entries = installed?.version === 2 ? installed.plugins?.[id] : null;
    const market = (await nativeJson(container, "plugins/known_marketplaces.json"))?.[channel.marketplaceId];
    if (!Array.isArray(entries) || entries.length !== 1 || entries[0].scope !== "user" || entries[0].version !== channel.version || entries[0].gitCommitSha !== channel.sourceRef || entries[0].installPath !== rows[0].installPath) return null;
    if (market?.source?.source !== "github" || `${market.source.repo}@${market.source.ref}` !== locator || market.installLocation !== marketplaceRoot) return null;
    installedRoot = entries[0].installPath;
  } else {
    const added = parseJson(outputs["marketplace-add"]);
    const installed = parseJson(outputs["plugin-install"]);
    const rows = Array.isArray(list?.installed) ? list.installed.filter(row => row?.pluginId === id) : [];
    if (added?.marketplaceName !== channel.marketplaceId || added.alreadyAdded !== false || added.installedRoot !== marketplaceRoot || installed?.pluginId !== id || installed.marketplaceName !== channel.marketplaceId || installed.name !== channel.pluginId || installed.version !== channel.version) return null;
    if (rows.length !== 1 || rows[0].name !== channel.pluginId || rows[0].marketplaceName !== channel.marketplaceId || rows[0].version !== channel.version || rows[0].installed !== true || rows[0].enabled !== true || rows[0].marketplaceSource?.sourceType !== "git" || rows[0].marketplaceSource.source !== locator) return null;
    installedRoot = installed.installedPath;
  }
  if (typeof installedRoot !== "string" || installedRoot === container || !contained(installedRoot, container)) return null;
  await directory(marketplaceRoot, "marketplaceRoot");
  await directory(installedRoot, "installedRoot");
  if (await detachedHead(marketplaceRoot) !== channel.sourceRef) return null;
  return installedRoot;
}
async function runChannel(request, bindings, preflight, facts) {
  const { driver, roots, executablePath } = preflight;
  const { installContainerRoot: container, temporaryRoot: temporary, privateEvidenceRoot: evidence } = roots;
  const limits = request.install.outputByteLimits || null;
  const { schemaVersion: _schemaVersion, kind: _kind, ...timeoutPolicy } = request.install.timeoutPolicy;
  const env = channelEnvironment(driver, roots); const outputs = {}; const commands = [];
  const finish = (status, reason) => result(request, status, reason, facts, status === "indeterminate" ? ACTION : []);
  const recordCommand = observation => {
    commands.push(observation);
    facts.install ??= { installedClosureDigest: null, payloadMatches: null, observationDigest: null, sourceMode: request.source.type, commands, retained: true };
  };
  try {
    const probe = await runCommand({ step: "version-probe", command: executablePath, args: driver.probeArgs }, temporary, timeoutPolicy, null, path.join(evidence, "version-probe"), env);
    facts.input.probe = probe.observation;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(probe.stdout).trim();
    if (probe.envelope.ok === true && driver.versionPattern.test(text)) facts.input.runtimeIdentities = { cliVersion: text };
    if (probe.envelope.ok !== true || !qualifiedPluginVersion(driver, text) || text !== request.host.cliVersion) return finish("rejected", "executable-observation-mismatch");
  } catch (cause) {
    if (cause.commandObservation) facts.input.probe = cause.commandObservation;
    return finish(cause?.code === "SFC2004" ? "indeterminate" : "rejected", cause?.code === "SFC2004" ? "boundary-state-indeterminate" : "executable-observation-mismatch");
  }
  for (const step of ["marketplace-add", "plugin-install", "plugin-list"]) {
    try {
      const run = await runCommand({ step, command: executablePath, args: argsFor(driver, step, request.source.channel, bindings.channelLocator) }, temporary, timeoutPolicy, limits, path.join(evidence, step), env);
      recordCommand(run.observation); outputs[step] = run.stdout;
      if (run.envelope.ok !== true || run.observation.outputLimitExceeded !== null) return finish("failed", "execution-failed");
    } catch (cause) {
      if (cause.commandObservation) recordCommand(cause.commandObservation);
      return finish(cause?.code === "SFC2004" ? "indeterminate" : "failed", cause?.code === "SFC2004" ? "boundary-state-indeterminate" : "execution-failed");
    }
  }
  let installedRoot;
  try { installedRoot = await discoverChannel(driver, request.source.channel, bindings.channelLocator, container, outputs); }
  catch (cause) { return finish(cause?.details?.boundReadDisposition === "boundary-indeterminate" ? "indeterminate" : "failed", cause?.details?.boundReadDisposition === "boundary-indeterminate" ? "boundary-state-indeterminate" : "channel-source-invalid"); }
  if (!installedRoot) return finish("failed", "channel-source-invalid");
  facts.discovery = { status: "observed", basis: "native-plugin-list", pluginId: request.source.channel.pluginId };
  let observation;
  try { observation = await observeFilesystemTree({ root: installedRoot, rootBinding: await createFilesystemRootBinding(installedRoot) }); }
  catch (cause) { return finish(cause?.details?.boundReadDisposition === "boundary-indeterminate" ? "indeterminate" : "failed", cause?.details?.boundReadDisposition === "boundary-indeterminate" ? "boundary-state-indeterminate" : "tree-violation"); }
  facts.install.installedClosureDigest = observation.membersDigest;
  facts.install.payloadMatches = digestDocument(projectMembers(observation)) === request.source.membersDigest;
  const record = contract({ requestDigest: digestDocument(request), installedRoot, observation }, { $ref: RESULT_SCHEMA + "#/$defs/installObservation" }, "private install observation fails its contract");
  try { await publishFileExclusive(evidence, "install-observation.json", Buffer.from(JSON.stringify(record) + "\n"), { rootBinding: await createFilesystemRootBinding(evidence), mode: 0o600 }); }
  catch (cause) { return finish(cause?.code === "SFC2004" ? "indeterminate" : "failed", cause?.code === "SFC2004" ? "boundary-state-indeterminate" : "private-evidence-publication-failed"); }
  facts.install.observationDigest = digestDocument(record);
  return finish("observed", null);
}
async function runLocalVerification(request, bindings, sourceRoot, sourceBinding, container, temporary, evidence, env) {
  const sourceObservation = bindings.__sourceObservation;
  const declared = bindings.sourceMembers;
  const input = { sourceClosureDigest: sourceObservation.membersDigest, membersDigest: digestDocument(declared), runtimeIdentities: bindings.__versionProbe ? { cliVersion: request.host.cliVersion } : null, probe: bindings.__versionProbe || null };
  if (input.membersDigest !== request.source.membersDigest) return { status: "rejected", reason: "members-drift", input };
  const target = path.join(container, "payload"); await mkdir(target, { recursive: false, mode: 0o700 }); const targetBinding = await createFilesystemRootBinding(target);
  for (const entry of sourceObservation.members) { const member = entry.path; if (entry.type === "directory") { await mkdir(path.join(target, member), { recursive: false, mode: 0o700 }); continue; } const file = await readFileBound(sourceRoot, member, { rootBinding: sourceBinding }); await publishFileExclusive(target, member, file.content, { rootBinding: targetBinding, createParents: true, mode: (file.statMode & 0o111) !== 0 ? 0o700 : 0o600 }); }
  const observation = await observeFilesystemTree({ root: target, rootBinding: targetBinding }); const payloadMatches = digestDocument(declared) === digestDocument(projectMembers(observation));
  const record = contract({ requestDigest: digestDocument(request), installedRoot: target, observation }, { $ref: RESULT_SCHEMA + "#/$defs/installObservation" }, "private install observation fails its contract"); const eb = await createFilesystemRootBinding(evidence); try { await publishFileExclusive(evidence, "install-observation.json", Buffer.from(JSON.stringify(record) + "\n"), { rootBinding: eb, mode: 0o600 }); } catch (cause) { if (cause?.code === "SFC2004") return { status: "indeterminate", reason: "boundary-state-indeterminate", actions: ACTION, input }; throw cause; }
  const install = { installedClosureDigest: observation.membersDigest, payloadMatches, observationDigest: digestDocument(record), sourceMode: request.source.type, commands: [], retained: true };
  if (request.goal === "install-only") return { status: "observed", reason: null, input, install, discovery: { status: "not-performed", basis: "none", pluginId: null } };
  if (!payloadMatches) return { status: "failed", reason: "payload-mismatch", input, install, discovery: { status: "not-performed", basis: "none", pluginId: null } };
  if (!bindings.executablePath || !bindings.effectivePrompt) return { status: "rejected", reason: "preflight-rejected", input, install, discovery: { status: "not-performed", basis: "none", pluginId: null } };
  const prompt = Buffer.isBuffer(bindings.effectivePrompt) ? bindings.effectivePrompt : Buffer.from(bindings.effectivePrompt); if (digestBytes(prompt) !== request.invocation.effectivePromptSha256 || prompt.includes(0)) return { status: "rejected", reason: "preflight-rejected", input, install, discovery: { status: "not-performed", basis: "none", pluginId: null } };
  const driver = getBuiltInHostVerificationDriver(request.host.driverId); if (!driver || driver.hostId !== request.host.hostId) return { status: "rejected", reason: "restriction-unsupported", input, install, discovery: { status: "not-performed", basis: "none", pluginId: null } }; const args = [driver.promptFlag || "-p"]; if (request.invocation.restrictions.approvalPolicy === "deny-unattended") args.push("--permission-mode", "dontAsk"); if (request.invocation.restrictions.tools === "skill-only") args.push("--tools=Skill"); if (request.invocation.restrictions.mcp === "disabled") args.push("--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'); if (request.invocation.restrictions.settingsSources === "empty") args.push("--setting-sources="); if (request.invocation.restrictions.sessionPersistence === "disabled") args.push("--no-session-persistence"); if (request.invocation.restrictions.browserIntegration === "disabled") args.push("--no-chrome"); if (request.invocation.restrictions.maxTurns !== undefined) args.push("--max-turns", String(request.invocation.restrictions.maxTurns)); if (request.invocation.restrictions.maxBudgetUsd !== undefined) args.push("--max-budget-usd", String(request.invocation.restrictions.maxBudgetUsd)); args.push("--verbose", "--output-format", "stream-json", prompt.toString("utf8"), "--plugin-dir", target); const fixtureBinding = await createFilesystemRootBinding(bindings.fixtureRoot); const workspaceBinding = await createFilesystemRootBinding(bindings.workspaceRoot); const fixtureBefore = await observeFilesystemTree({ root: bindings.fixtureRoot, rootBinding: fixtureBinding }); const workspaceBefore = await observeFilesystemTree({ root: bindings.workspaceRoot, rootBinding: workspaceBinding });
  let invocation = null;
  const finish = (status, reason, actions = []) => ({ status, reason, actions, input, install, invocation, discovery: { status: "not-performed", basis: "none", pluginId: null } });
  try {
    const run = await runCommand({ step: "plugin-install", command: bindings.executablePath, args }, bindings.workspaceRoot, ((({ schemaVersion: _s, kind: _k, ...policy }) => policy)(request.invocation.timeoutPolicy)), request.install.outputByteLimits || null, path.join(evidence, "invocation"), env);
    invocation = { execution: run.observation.execution, streams: run.observation.streams, snapshots: null, snapshotsMatch: null };
    const invocationSink = path.join(evidence, "invocation");
    const invocationStdout = await readBoundSafe(invocationSink, "stdout.bin", await createFilesystemRootBinding(invocationSink));
    if (!invocationStdout) return finish("indeterminate", "boundary-state-indeterminate", ACTION);
    if (!evaluateDriverStreamProtocol({ driver, stdoutText: invocationStdout.content.toString("utf8"), exitOk: run.envelope.ok === true })) return finish("failed", "execution-failed");
    const after = await observeTreeSafe(target, targetBinding);
    const fixtureAfter = await observeTreeSafe(bindings.fixtureRoot, fixtureBinding);
    const workspaceAfter = await observeTreeSafe(bindings.workspaceRoot, workspaceBinding);
    if (!after || !fixtureAfter || !workspaceAfter) return finish("indeterminate", "boundary-state-indeterminate", ACTION);
    invocation.snapshots = { installedPlugin: { preClosureDigest: observation.membersDigest, postClosureDigest: after.membersDigest }, fixture: { preClosureDigest: fixtureBefore.membersDigest, postClosureDigest: fixtureAfter.membersDigest }, protectedWorkspace: { preClosureDigest: workspaceBefore.membersDigest, postClosureDigest: workspaceAfter.membersDigest } };
    invocation.snapshotsMatch = Object.values(invocation.snapshots).every((x) => x.preClosureDigest === x.postClosureDigest);
    if (!invocation.snapshotsMatch) return finish("failed", "snapshot-mismatch");
    return finish(run.envelope.ok ? "observed" : "failed", run.envelope.ok ? null : "execution-failed");
  } catch (cause) {
    if (!invocation && cause.commandObservation) invocation = { execution: cause.commandObservation.execution, streams: cause.commandObservation.streams, snapshots: null, snapshotsMatch: null };
    return cause?.code === "SFC2004" ? finish("indeterminate", "boundary-state-indeterminate", ACTION) : finish("failed", "execution-failed");
  }
}
async function preflightPlugin(request, bindings, hostsRoot, facts) {
  const channel = request.source.type === "public-channel";
  const invoke = request.goal === "install-and-invoke";
  const driver = getBuiltInHostVerificationDriver(request.host.driverId);
  if (!driver || driver.hostId !== request.host.hostId || driver.driverVersion !== request.host.driverVersion || channel && (!driver.pluginChannel || invoke) || invoke && driver.hostId !== "claude") return { rejected: "restriction-unsupported" };
  if ((channel || invoke) && !qualifiedPluginVersion(driver, request.host.cliVersion)) return { rejected: "preflight-rejected" };
  const sourceRoot = await directory(bindings.sourceRoot, "sourceRoot");
  const profileRoot = await directory(hostsRoot ?? bundledHostProfilesRoot(), "hostsRoot");
  const roots = {};
  for (const name of ["installContainerRoot", "temporaryRoot", "privateEvidenceRoot", ...(channel || invoke ? ["executableRoot", "existingUserStateRoot"] : []), ...(invoke ? ["fixtureRoot", "workspaceRoot", "repositoryRoot", "outputRoot"] : [])]) roots[name] = await directory(bindings[name], name);
  assertRootIsolation(roots, sourceRoot, profileRoot);
  if (invoke && !contained(roots.workspaceRoot, roots.repositoryRoot)) return { rejected: "preflight-rejected" };
  for (const name of ["installContainerRoot", "temporaryRoot", "privateEvidenceRoot", ...(invoke ? ["outputRoot"] : [])]) if ((await readdir(roots[name])).length) return { rejected: "preflight-rejected" };
  const descriptor = await observeHostDescriptor({ hostId: request.host.hostId, hostsRoot: profileRoot });
  if (descriptor.descriptor.hostId !== request.host.hostId || descriptor.descriptorSha256 !== request.host.descriptorSha256 || descriptor.descriptor.verification?.driverId !== driver.driverId || (channel || invoke) && (descriptor.descriptor.verification.authStrategy !== request.auth.strategy || descriptor.descriptor.verification.credentialMutation !== request.auth.credentialMutation)) return { rejected: "preflight-rejected" };
  const sourceMembers = validateMembers(bindings.sourceMembers);
  if (digestDocument(sourceMembers) !== request.source.membersDigest) return { rejected: "members-drift" };
  const sourceBinding = await createFilesystemRootBinding(sourceRoot);
  const manifestPath = relative(bindings.sourceManifestRelPath, "sourceManifestRelPath");
  const manifest = await readFileBound(sourceRoot, manifestPath, { rootBinding: sourceBinding });
  if (manifest.sha256 !== request.source.sourceManifestSha256 || !sourceMembers.some(member => member.path === manifestPath && member.type === "file" && member.sha256 === manifest.sha256)) return { rejected: "source-invalid" };
  const sourceObservation = await observeFilesystemTree({ root: sourceRoot, rootBinding: sourceBinding });
  facts.input.sourceClosureDigest = sourceObservation.membersDigest;
  if (digestDocument(projectMembers(sourceObservation)) !== request.source.membersDigest) return { rejected: "members-drift" };
  facts.input.membersDigest = request.source.membersDigest;
  let executablePath;
  if (channel || invoke) {
    const rel = relative(bindings.executableRelPath, "executableRelPath");
    if (path.basename(rel) !== driver.executableBasename) return { rejected: "executable-observation-mismatch" };
    const executable = await readFileBound(roots.executableRoot, rel, { rootBinding: await createFilesystemRootBinding(roots.executableRoot) });
    if (executable.sha256 !== request.host.executableSha256) return { rejected: "executable-observation-mismatch" };
    executablePath = executable.path;
  }
  if (channel) {
    const locator = bindings.channelLocator;
    const locatorPattern = driver.hostId === "claude" ? /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[A-Za-z0-9_./-]+$/u : /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/u;
    if (typeof locator !== "string" || !locatorPattern.test(locator) || !COMMIT.test(request.source.channel.sourceRef) || digestBytes(Buffer.from(locator, "utf8")) !== request.source.channel.locatorSha256) return { rejected: "channel-source-invalid" };
    if (!driver.versionPattern.test(request.host.cliVersion)) return { rejected: "preflight-rejected" };
    qualifiedPluginId(request.source.channel);
  }
  if (invoke) {
    const prompt = bindings.effectivePrompt;
    if (!Buffer.isBuffer(prompt) || prompt.includes(0) || digestBytes(prompt) !== request.invocation.effectivePromptSha256) return { rejected: "preflight-rejected" };
    try { new TextDecoder("utf-8", { fatal: true }).decode(prompt); } catch { return { rejected: "preflight-rejected" }; }
    for (const [name, expected] of [["fixtureRoot", request.invocation.fixtureClosureDigest], ["workspaceRoot", request.invocation.protectedWorkspaceClosureDigest]]) {
      const observed = await observeFilesystemTree({ root: roots[name], rootBinding: await createFilesystemRootBinding(roots[name]) });
      if (observed.membersDigest !== expected) return { rejected: "preflight-rejected" };
    }
  }
  return { driver, roots, sourceRoot, sourceBinding, sourceObservation, executablePath };
}

export async function runPluginVerification({ request, bindings, hostsRoot } = {}) {
  const normalized = contract(request, REQUEST_SCHEMA, "plugin verification request fails its registered contract");
  validateBindingFields(normalized, bindings);
  const facts = emptyFacts();
  let preflight;
  try { preflight = await preflightPlugin(normalized, bindings, hostsRoot, facts); }
  catch (cause) {
    if (cause?.details?.boundReadDisposition === "boundary-indeterminate") return result(normalized, "indeterminate", "boundary-state-indeterminate", facts, ACTION);
    if (cause?.code === "SFC2003") throw cause;
    return result(normalized, "rejected", cause?.details?.kind === "read-failed" ? "tree-violation" : "preflight-rejected", facts);
  }
  if (preflight.rejected) return result(normalized, "rejected", preflight.rejected, facts);
  if (normalized.source.type === "public-channel") return runChannel(normalized, bindings, preflight, facts);
  const { roots, sourceRoot, sourceBinding } = preflight;
  const effectiveBindings = { ...bindings, executablePath: preflight.executablePath, __sourceObservation: preflight.sourceObservation };
  let env;
  if (normalized.goal === "install-and-invoke") {
    env = driverEnvironment({ driver: preflight.driver, sessionRoot: roots.temporaryRoot, existingUserStateRoot: roots.existingUserStateRoot });
    const { schemaVersion: _schemaVersion, kind: _kind, ...timeoutPolicy } = normalized.invocation.timeoutPolicy;
    try {
      const probe = await runCommand({ step: "version-probe", command: preflight.executablePath, args: preflight.driver.probeArgs }, roots.temporaryRoot, timeoutPolicy, null, path.join(roots.privateEvidenceRoot, "version-probe"), env);
      facts.input.probe = probe.observation;
      const text = new TextDecoder("utf-8", { fatal: true }).decode(probe.stdout).trim();
      const version = text.match(/^(?:codex-cli )?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))/u)?.[1];
      if (probe.envelope.ok !== true || !qualifiedPluginVersion(preflight.driver, text) || normalized.host.cliVersion !== text && normalized.host.cliVersion !== version) return result(normalized, "rejected", "executable-observation-mismatch", facts);
      facts.input.runtimeIdentities = { cliVersion: normalized.host.cliVersion };
      effectiveBindings.__versionProbe = probe.observation;
    } catch (cause) {
      if (cause.commandObservation) facts.input.probe = cause.commandObservation;
      return result(normalized, cause?.code === "SFC2004" ? "indeterminate" : "rejected", cause?.code === "SFC2004" ? "boundary-state-indeterminate" : "executable-observation-mismatch", facts, cause?.code === "SFC2004" ? ACTION : []);
    }
  }
  const outcome = await runLocalVerification(normalized, effectiveBindings, sourceRoot, sourceBinding, roots.installContainerRoot, roots.temporaryRoot, roots.privateEvidenceRoot, env);
  facts.input = outcome.input || facts.input;
  facts.install = outcome.install || null;
  facts.invocation = outcome.invocation || null;
  facts.discovery = outcome.discovery || facts.discovery;
  return result(normalized, outcome.status, outcome.reason, facts, outcome.actions || []);
}
export { REQUEST_SCHEMA as PLUGIN_VERIFICATION_REQUEST_SCHEMA, RESULT_SCHEMA as PLUGIN_VERIFICATION_RESULT_SCHEMA };
