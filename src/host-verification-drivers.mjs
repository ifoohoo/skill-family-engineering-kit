/**
 * Closed, built-in real-host driver table.  The table contains mechanism
 * facts only; it does not own a host registry or domain assertions.
 *
 * Both admitted drivers reuse the caller's existing login state
 * (`existing-user-state + host-managed`); the table deliberately repeats no
 * auth facts.  The version observation rule is the same closed bare
 * `major.minor.patch` pattern for both drivers: three digit groups without
 * leading zeros, no prefix, suffix, extra lines or other characters.
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

export const BUILT_IN_HOST_VERIFICATION_DRIVERS = Object.freeze({
  [KIMI_DRIVER.driverId]: KIMI_DRIVER,
  [WORKBUDDY_DRIVER.driverId]: WORKBUDDY_DRIVER,
});

export function getBuiltInHostVerificationDriver(driverId) {
  return BUILT_IN_HOST_VERIFICATION_DRIVERS[driverId] ?? null;
}
