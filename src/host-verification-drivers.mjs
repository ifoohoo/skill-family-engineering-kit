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
  // CODEBUDDY_CONFIG_DIR environment projection (see host-verification.mjs),
  // which resolves `<config>/skills/<skill-id>/SKILL.md`; the config root
  // layout is pre-checked before any spawn and `skills/` must be an empty
  // real (non-symlink) directory before the skill is materialized.
  fixedArgs: Object.freeze(["--permission-mode", "dontAsk", "--no-session-persistence"]),
  versionPattern: /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u,
});

export const CLAUDE_DRIVER = Object.freeze({
  hostId: "claude",
  driverId: "claude-code-print-v1",
  driverVersion: "1.0.0",
  executableBasename: "claude",
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
  versionPattern: /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u,
});

export const BUILT_IN_HOST_VERIFICATION_DRIVERS = Object.freeze({
  [KIMI_DRIVER.driverId]: KIMI_DRIVER,
  [WORKBUDDY_DRIVER.driverId]: WORKBUDDY_DRIVER,
  [CLAUDE_DRIVER.driverId]: CLAUDE_DRIVER,
  [CODEX_DRIVER.driverId]: CODEX_DRIVER,
  [QODER_DRIVER.driverId]: QODER_DRIVER,
});

export function getBuiltInHostVerificationDriver(driverId) {
  return BUILT_IN_HOST_VERIFICATION_DRIVERS[driverId] ?? null;
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
