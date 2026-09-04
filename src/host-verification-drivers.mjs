import path from "node:path";

export const CONTROLLED_NATIVE_LIFECYCLE_FIXTURE_PROTOCOL = "skill-family.controlled-native-lifecycle-fixture/v1";

const NATIVE_TREE_ROLES = Object.freeze({
  preflight: Object.freeze([]),
  "validate-v1": Object.freeze(["source-v1"]),
  "marketplace-add": Object.freeze(["config"]),
  "install-v1": Object.freeze(["installed", "cache", "config", "data"]),
  "discover-v1": Object.freeze(["installed", "cache", "config", "data"]),
  "invoke-v1": Object.freeze(["installed"]),
  disable: Object.freeze(["installed", "config"]),
  enable: Object.freeze(["installed", "config"]),
  "update-v2": Object.freeze(["source-v2", "installed", "cache", "config", "data"]),
  "invoke-v2": Object.freeze(["installed"]),
  uninstall: Object.freeze(["installed", "cache", "config", "data"]),
  "absent-after-uninstall": Object.freeze(["installed", "cache", "config", "data"]),
});

function nativeStage(name, commands) {
  return Object.freeze({
    name,
    commands: Object.freeze(commands.map(({ step, args }) => Object.freeze({ step, args: Object.freeze(args) }))),
    treeRoles: NATIVE_TREE_ROLES[name],
  });
}

function qoderNativeLifecyclePlan({ request, roots, prompt }) {
  const global = ["--cwd", roots.workspaceRoot, "--config-dir", roots.temporaryRoot];
  const plugin = `${request.source.pluginId}@${request.source.marketplaceId}`;
  const invoke = (step) => ({ step, args: [...global, "-p", "-o", "json", "--no-session-persistence", prompt] });
  const manage = (step, ...args) => ({ step, args: [...global, "plugins", ...args] });
  return Object.freeze([
    nativeStage("preflight", [{ step: "version-probe", args: ["--version"] }]),
    nativeStage("validate-v1", [manage("plugin-validate", "validate", roots.sourceRoot, "--json", "--strict")]),
    nativeStage("marketplace-add", [manage("marketplace-add", "marketplace", "add", roots.sourceRoot, "--scope", "local")]),
    nativeStage("install-v1", [manage("plugin-install", "install", plugin, "--scope", "local", "--json")]),
    nativeStage("discover-v1", [manage("plugin-list", "list", "--json")]),
    nativeStage("invoke-v1", [invoke("plugin-invoke")]),
    nativeStage("disable", [
      manage("plugin-disable", "disable", plugin, "--scope", "local"),
      manage("plugin-list", "list", "--json"),
      invoke("plugin-invoke-negative"),
    ]),
    nativeStage("enable", [
      manage("plugin-enable", "enable", plugin, "--scope", "local"),
      manage("plugin-list", "list", "--json"),
      invoke("plugin-invoke-positive"),
    ]),
    nativeStage("update-v2", [
      manage("marketplace-add", "marketplace", "add", roots.fixtureRoot, "--scope", "local"),
      manage("plugin-update", "update", plugin, "--scope", "local"),
      manage("plugin-list", "list", "--json"),
    ]),
    nativeStage("invoke-v2", [invoke("plugin-invoke")]),
    nativeStage("uninstall", [manage("plugin-uninstall", "uninstall", plugin, "--scope", "local", "--json")]),
    nativeStage("absent-after-uninstall", [manage("plugin-list", "list", "--json")]),
  ]);
}

function workBuddyNativeLifecyclePlan({ request, roots, prompt }) {
  const plugin = `${request.source.pluginId}@${request.source.marketplaceId}`;
  const invoke = (step) => ({ step, args: ["-p", prompt, "--output-format", "stream-json", "--permission-mode", "dontAsk", "--no-session-persistence"] });
  const manage = (step, ...args) => ({ step, args: ["plugin", ...args] });
  return Object.freeze([
    nativeStage("preflight", [{ step: "version-probe", args: ["--version"] }]),
    nativeStage("validate-v1", [manage("plugin-validate", "validate", roots.sourceRoot)]),
    nativeStage("marketplace-add", [manage("marketplace-add", "marketplace", "add", roots.sourceRoot, "--name", request.source.marketplaceId)]),
    nativeStage("install-v1", [manage("plugin-install", "install", plugin, "--scope", "local", "--json")]),
    nativeStage("discover-v1", [manage("plugin-list", "list", "--json")]),
    nativeStage("invoke-v1", [invoke("plugin-invoke")]),
    nativeStage("disable", [
      manage("plugin-disable", "disable", plugin, "--scope", "local"),
      manage("plugin-list", "list", "--json"),
      invoke("plugin-invoke-negative"),
    ]),
    nativeStage("enable", [
      manage("plugin-enable", "enable", plugin, "--scope", "local"),
      manage("plugin-list", "list", "--json"),
      invoke("plugin-invoke-positive"),
    ]),
    nativeStage("update-v2", [
      manage("marketplace-add", "marketplace", "add", roots.fixtureRoot, "--name", request.source.marketplaceId),
      manage("plugin-update", "update", plugin, "--scope", "local"),
      manage("plugin-list", "list", "--json"),
    ]),
    nativeStage("invoke-v2", [invoke("plugin-invoke")]),
    nativeStage("uninstall", [manage("plugin-uninstall", "uninstall", plugin, "--scope", "local")]),
    nativeStage("absent-after-uninstall", [manage("plugin-list", "list", "--json")]),
  ]);
}

const QODER_NATIVE_LIFECYCLE = Object.freeze({
  executableBasename: "qodercli",
  buildPlan: qoderNativeLifecyclePlan,
  environment: (roots) => Object.freeze({
    NO_COLOR: "1",
    HOME: roots.temporaryRoot,
    TMPDIR: roots.temporaryRoot,
    QODER_PLUGIN_CACHE_DIR: roots.installContainerRoot,
  }),
});

const WORKBUDDY_NATIVE_LIFECYCLE = Object.freeze({
  executableBasename: "codebuddy",
  buildPlan: workBuddyNativeLifecyclePlan,
  environment: (roots) => Object.freeze({
    NO_COLOR: "1",
    HOME: roots.temporaryRoot,
    TMPDIR: roots.temporaryRoot,
    CODEBUDDY_CONFIG_DIR: roots.temporaryRoot,
    WORKBUDDY_CONFIG_DIR: roots.temporaryRoot,
    CODEBUDDY_DISABLE_COMPILE_CACHE: "1",
  }),
});

function ownKeys(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).sort().join(",")
    : "";
}

/**
 * Parse the explicit controlled-fixture protocol after a real production
 * driver spawn. This protocol is Foundation-owned isolation evidence; it is
 * intentionally distinct from, and never presented as, either vendor's
 * official output grammar.
 */
export function evaluateControlledNativeLifecycleFixture({ bytes, hostId, stage, step } = {}) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return Object.freeze({ status: "indeterminate" });
  }
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1) return Object.freeze({ status: "indeterminate" });
  let event;
  try {
    event = JSON.parse(lines[0]);
  } catch {
    return Object.freeze({ status: "indeterminate" });
  }
  if (ownKeys(event) !== "hostId,invocation,protocol,stage,stageCode,step" ||
      event.protocol !== CONTROLLED_NATIVE_LIFECYCLE_FIXTURE_PROTOCOL ||
      event.hostId !== hostId || event.stage !== stage || event.step !== step ||
      !Array.isArray(event.invocation)) {
    return Object.freeze({ status: "indeterminate" });
  }
  const invocationStep = step.includes("invoke");
  if (!invocationStep && event.invocation.length !== 0) return Object.freeze({ status: "indeterminate" });
  if (invocationStep) {
    if (event.invocation.length !== 1 || ownKeys(event.invocation[0]) !== "callId,result") {
      return Object.freeze({ status: "indeterminate" });
    }
    const pair = event.invocation[0];
    if (typeof pair.callId !== "string" || pair.callId.length === 0 || ownKeys(pair.result) !== "callId,outcome" ||
        pair.result.callId !== pair.callId || !["blocked", "succeeded"].includes(pair.result.outcome)) {
      return Object.freeze({ status: "indeterminate" });
    }
    const expectedOutcome = step === "plugin-invoke-negative" ? "blocked" : "succeeded";
    if (pair.result.outcome !== expectedOutcome) return Object.freeze({ status: "failed" });
  }
  if (event.stageCode === `${stage}:ok`) return Object.freeze({ status: "observed" });
  if (["disable:call-succeeded", "update-v2:version-v1", "absent-after-uninstall:present"].includes(event.stageCode)) {
    return Object.freeze({ status: "failed" });
  }
  return Object.freeze({ status: "indeterminate" });
}

/**
 * Closed, built-in real-host driver table.  The table contains mechanism
 * facts only; it does not own a host registry or domain assertions.
 *
 * All admitted drivers reuse the caller's existing login state
 * (`existing-user-state + host-managed`); the table deliberately repeats no
 * auth facts.  The default version observation rule is the closed bare
 * `major.minor.patch` pattern: three digit groups without leading zeros, no
 * prefix, suffix, extra lines or other characters.  Two frozen variants
 * exist: codex (`codex-cli <major.minor.patch>`) and claude — a line-leading
 * bare semver plus the single frozen literal suffix ` (Claude Code)` (the
 * real `2.1.233 (Claude Code)` form), matched by
 * `^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?: \(Claude Code\))?$`
 * (multi-line output, a `v` prefix, any other suffix and leading zeros are
 * still refused).
 *
 * New 0.12.0 drivers (claude-code-print-v1, codex-exec-v1, qodercli-print-v1)
 * follow the frozen invocation specs of FND-DES-013 section 4.  The prompt is
 * a trailing positional argument (`promptTrailing`) so the fixed flag
 * sequence matches the frozen argv byte-for-byte; `outputArgs` carries the
 * fixed flags that precede the prompt, `fixedArgs` the ones after them.
 * qodercli-print-v1 additionally needs the global `--cwd` flag whose value is
 * the fresh workspace (two path segments above the installed parent, i.e.
 * `<fresh-ws>/.qoder/skills/<skill-id>`), expressed through `cwdFlag`.
 * The three 0.12.0 drivers decode their stdout as UTF-8 text for the frozen
 * protocol judgement (`textProtocol`); Kimi and WorkBuddy do not, and keep
 * raw byte capture with exit-status-only judgement.
 * Kimi and WorkBuddy keep their 0.11.0 byte-exact vectors.
 */
export const KIMI_DRIVER = Object.freeze({
  hostId: "kimi-code",
  driverId: "kimi-code-print-v1",
  driverVersion: "1.0.0",
  cliVersion: "0.39.1",
  executableBasename: "kimi",
  probeArgs: Object.freeze(["--version"]),
  promptFlag: "-p",
  outputArgs: Object.freeze(["--output-format", "stream-json"]),
  // The parent of the installed target is the host discovery directory; the
  // CLI resolves `<skills-dir>/<skill-id>/SKILL.md` from it.  The discovery
  // directory must be empty before the skill is materialized.
  skillsDirectoryFlag: "--skills-dir",
  versionPattern: /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u,
});

export const WORKBUDDY_DRIVER = Object.freeze({
  hostId: "workbuddy",
  driverId: "workbuddy-codebuddy-print-v1",
  driverVersion: "1.0.0",
  executableBasename: "codebuddy",
  probeArgs: Object.freeze(["--version"]),
  promptFlag: "-p",
  outputArgs: Object.freeze(["--output-format", "stream-json"]),
  // No auto-accept (`-y`), model override or trust auto-confirmation flag may
  // enter the vector.  The skill discovery directory comes from the
  // CODEBUDDY_CONFIG_DIR environment projection (driverEnvironment below),
  // which resolves `<config>/skills/<skill-id>/SKILL.md`; the config root
  // layout is pre-checked before any spawn and `skills/` must be an empty
  // real (non-symlink) directory before the skill is materialized.
  fixedArgs: Object.freeze(["--permission-mode", "dontAsk", "--no-session-persistence"]),
  nativeLifecycle: WORKBUDDY_NATIVE_LIFECYCLE,
  versionPattern: /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u,
});

export const CODEBUDDY_DRIVER = Object.freeze({
  hostId: "codebuddy",
  driverId: "codebuddy-print-v1",
  driverVersion: "1.0.0",
  executableBasename: "codebuddy",
  probeArgs: Object.freeze(["--version"]),
  promptFlag: "-p",
  outputArgs: Object.freeze(["--output-format", "stream-json"]),
  // CodeBuddy's project skill discovery is rooted at the process cwd's
  // `.codebuddy/skills` directory.  Its user state is projected through
  // HOME, while the fresh project discovery root remains caller-owned.
  fixedArgs: Object.freeze(["--permission-mode", "dontAsk", "--no-session-persistence"]),
  versionPattern: /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u,
});

export const CLAUDE_DRIVER = Object.freeze({
  hostId: "claude",
  driverId: "claude-code-print-v1",
  driverVersion: "1.0.0",
  executableBasename: "claude",
  pluginCliVersion: "2.1.233",
  pluginChannel: Object.freeze({ configVariable: "CLAUDE_CONFIG_DIR", marketplaceDirectory: "plugins/marketplaces" }),
  probeArgs: Object.freeze(["--version"]),
  promptFlag: "-p",
  // Frozen invocation (S-022): `-p --verbose --no-session-persistence
  // --output-format stream-json <prompt> --plugin-dir <dir>`.  The prompt is
  // a trailing positional argument.  The discovery layout is the classic
  // plugin form: `--plugin-dir <plugin-root>` where the skill is installed at
  // `<plugin-root>/skills/<skill-id>/SKILL.md` (the plugin root is the
  // parent of the installed parent, expressed through
  // `skillsDirectoryTarget: "plugin-root"`), and the process cwd is the fresh
  // session root (claude has no --cwd / --skills-dir).  Never
  // --dangerously-skip-permissions, --bare or a model override.
  outputArgs: Object.freeze(["--verbose", "--no-session-persistence", "--output-format", "stream-json"]),
  skillsDirectoryFlag: "--plugin-dir",
  skillsDirectoryTarget: "plugin-root",
  promptTrailing: true,
  textProtocol: true,
  // Frozen version observation (F-1): the real `claude --version` prints
  // `2.1.233 (Claude Code)` — line-leading bare semver plus the single
  // literal suffix ` (Claude Code)`; a bare semver without the suffix is
  // also accepted.  Multi-line, prefixed, arbitrary-suffix and leading-zero
  // shapes are still refused.
  versionPattern: /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?: \(Claude Code\))?$/u,
});

export const CODEX_DRIVER = Object.freeze({
  hostId: "codex",
  driverId: "codex-exec-v1",
  driverVersion: "1.0.0",
  executableBasename: "codex",
  pluginCliVersion: "0.145.0",
  pluginChannel: Object.freeze({ configVariable: "CODEX_HOME", marketplaceDirectory: ".tmp/marketplaces" }),
  probeArgs: Object.freeze(["--version"]),
  // Frozen invocation (S-023): `codex exec --json --ephemeral <prompt>`.
  // Never --dangerously-bypass-approvals-and-sandbox,
  // --dangerously-bypass-hook-trust, --skip-git-repo-check, git init or a
  // model override.  Skill discovery is the workspace-level
  // `<workspace>/.codex/skills/<skill-id>/SKILL.md` projection (the installed
  // parent is `<workspace>/.codex/skills`).
  subcommand: "exec",
  outputArgs: Object.freeze(["--json", "--ephemeral"]),
  promptTrailing: true,
  textProtocol: true,
  // Frozen version observation: the real `codex --version` prints
  // `codex-cli <major.minor.patch>` (codex-cli 0.145.0).
  versionPattern: /^codex-cli (0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u,
});

export const QODER_DRIVER = Object.freeze({
  hostId: "qoder",
  driverId: "qodercli-print-v1",
  driverVersion: "1.0.0",
  executableBasename: "qoder",
  probeArgs: Object.freeze(["--version"]),
  promptFlag: "-p",
  // Frozen invocation (S-024): `qoder -p -o json --no-session-persistence
  // --cwd <fresh-ws> "<prompt>"`.  The global --cwd flag must precede any
  // subcommand and points at the fresh workspace
  // (`<fresh-ws>/.qoder/skills/<skill-id>/SKILL.md` is the sole discovery
  // projection).  Never --config-dir, --dangerously-skip-permissions,
  // permission-mode bypass, a model override, a remote session or a daemon;
  // `skills install`/`skills list` never enter the product vector.
  outputArgs: Object.freeze(["-o", "json"]),
  fixedArgs: Object.freeze(["--no-session-persistence"]),
  cwdFlag: "--cwd",
  promptTrailing: true,
  textProtocol: true,
  nativeLifecycle: QODER_NATIVE_LIFECYCLE,
  versionPattern: /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u,
});

export const BUILT_IN_HOST_VERIFICATION_DRIVERS = Object.freeze({
  [KIMI_DRIVER.driverId]: KIMI_DRIVER,
  [WORKBUDDY_DRIVER.driverId]: WORKBUDDY_DRIVER,
  [CODEBUDDY_DRIVER.driverId]: CODEBUDDY_DRIVER,
  [CLAUDE_DRIVER.driverId]: CLAUDE_DRIVER,
  [CODEX_DRIVER.driverId]: CODEX_DRIVER,
  [QODER_DRIVER.driverId]: QODER_DRIVER,
});

export function getBuiltInHostVerificationDriver(driverId) {
  return BUILT_IN_HOST_VERIFICATION_DRIVERS[driverId] ?? null;
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
 * - CodeBuddy points HOME at the existing state root only; its project skill
 *   discovery is the fresh cwd `.codebuddy/skills` tree and therefore does
 *   not set CODEBUDDY_CONFIG_DIR.
 * - claude, codex and qoder point HOME at the existing state root only
 *   (their login state lives under HOME); no model override, --config-dir or
 *   CODEX_HOME override is ever projected.
 */
export function driverEnvironment({ driver, sessionRoot, existingUserStateRoot, installedParent }) {
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
 * Frozen stream-protocol evaluation, one per admitted driver.  All three
 * 0.12.0 drivers share the minimal "exit status + frozen structure" shape
 * (R-04/R-05/R-06): the raw stream text is read from the private evidence
 * only and never enters the public result.  The product never judges any
 * fixed output string: domain output semantics belong to the consumer and
 * its fixtures, and a legal non-marker text output still passes the
 * protocol judgement.  Kimi and WorkBuddy keep their 0.11.0 behavior (exit
 * status only, no output protocol assertion, raw byte capture).
 *
 * - claude: the whole stream-json text is read; every non-empty line must be
 *   a JSON object with a string `type`, and the sequence must contain
 *   system → assistant → result; stderr never participates (the caller
 *   keeps it private).
 * - codex: JSONL structure chain thread.started → turn.started →
 *   item.completed(agent_message) → turn.completed; the whole stream is
 *   read, so a malformed tail or a non-event line fails closed; `error`
 *   events are frozen environment noise and are skipped, never classified,
 *   and never influence the outcome.
 * - qoder: `-o json` output must parse as an object and expose a boolean
 *   `is_error`; `is_error: true` (including the frozen quota-exhausted
 *   error_code 118) is a determined failure that maps to the existing
 *   failed + execution-failed, with no account state entering the result.
 */
export function evaluateDriverStreamProtocol({ driver, stdoutText, exitOk }) {
  if (driver.driverId === CLAUDE_DRIVER.driverId) {
    return exitOk && claudeEventSequenceOk(stdoutText);
  }
  if (driver.driverId === CODEX_DRIVER.driverId) {
    return exitOk && codexJsonlChainOk(stdoutText);
  }
  if (driver.driverId === QODER_DRIVER.driverId) {
    return exitOk && qoderJsonOk(stdoutText);
  }
  return exitOk;
}

function claudeEventSequenceOk(stdoutText) {
  // phase 0: system → 1: assistant → 2: result.  Unknown event types are
  // skipped; the whole stream is read, so a malformed tail or a non-event
  // line (null, array, scalar or object without a string `type`) is a
  // protocol drift that fails the sequence.
  let phase = 0;
  let sawResult = false;
  for (const line of stdoutText.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return false;
    }
    if (typeof event?.type !== "string") return false;
    if (phase === 0 && event.type === "system") phase = 1;
    else if (phase === 1 && event.type === "assistant") phase = 2;
    else if (phase === 2 && event.type === "result") sawResult = true;
  }
  return sawResult;
}

function codexJsonlChainOk(stdoutText) {
  // phase 0: thread.started → 1: turn.started → 2: item.completed(agent_message)
  // → 3: turn.completed.  `error` events are frozen network-reconnect noise
  // and are skipped without classification.  The whole stream is read, so a
  // malformed tail or a non-event line fails closed.
  let phase = 0;
  let chainComplete = false;
  for (const line of stdoutText.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return false;
    }
    const type = event?.type;
    if (typeof type !== "string") return false;
    if (type === "error") continue;
    if (phase === 0) {
      if (type === "thread.started") phase = 1;
    } else if (phase === 1) {
      if (type === "turn.started") phase = 2;
    } else if (phase === 2) {
      if (type === "item.completed" && event.item?.type === "agent_message") {
        phase = 3;
      } else if (type === "turn.completed") {
        return false;
      }
    } else if (phase === 3) {
      if (type === "turn.completed") chainComplete = true;
    }
  }
  return chainComplete;
}

function qoderJsonOk(stdoutText) {
  let parsed;
  try {
    parsed = JSON.parse(stdoutText);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  // The frozen `-o json` protocol exposes a boolean is_error; without it the
  // output cannot be judged by the frozen protocol and fails closed.
  if (typeof parsed.is_error !== "boolean") return false;
  return !parsed.is_error;
}
