import path from "node:path";
import { probeVersionVector } from "skill-family-harness-node";

const CAPABILITIES = Object.freeze(["cli", "version", "payload", "registry", "discover", "enabled", "reload", "smoke", "uninstall"]);
const DRIVERS = Object.freeze({
  "claude-version-v1": Object.freeze({ executableBasename: "claude", argv: Object.freeze(["--version"]) }),
  "codex-version-v1": Object.freeze({ executableBasename: "codex", argv: Object.freeze(["--version"]) }),
});

/**
 * Selects one audited host-specific driver vector. The generic process and
 * four-state classification mechanism lives in Harness.
 */
export async function probeTrustedVersionDriver({ hostId, driverId, capabilities = CAPABILITIES, executable, allowSpawn = false, timeoutMs = 5000, runner } = {}) {
  const driver = DRIVERS[driverId];
  if (!driver) throw new TypeError(`unknown frozen host driver: ${String(driverId)}`);
  if (allowSpawn && path.basename(executable ?? "") !== driver.executableBasename) {
    throw new TypeError(`driver ${driverId} requires an explicit ${driver.executableBasename} executable`);
  }
  return probeVersionVector({ hostId, capabilities, executable, argv: driver.argv, allowSpawn, timeoutMs, runner });
}

export const HOST_CAPABILITIES = CAPABILITIES;
export const HOST_DRIVER_IDS = Object.freeze(Object.keys(DRIVERS));
