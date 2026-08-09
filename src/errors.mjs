import { ContractsError, isRegisteredErrorCode } from "skill-family-contracts";

/**
 * Engineering kit error policy.
 *
 * The kit never invents error codes: every rejection carries a code from the
 * frozen contracts registry (skill-family-contracts owns the registry; adding
 * a code there would be a contracts change outside this package's write set).
 *
 * Mapping onto the frozen SFC codes:
 * - SFC2002 (UNKNOWN_OPERATION)  — intake rejected a name outside the frozen
 *                                  four-command vocabulary.
 * - SFC2003 (INVALID_PARAMS)     — intake rejected option/parameter values
 *                                  (unknown flags, malformed ids, requests
 *                                  for mutation modes the kit does not have).
 * - SFC2004 (EXECUTION_FAILED)   — a well-formed command failed while
 *                                  executing; details.kind carries one stable
 *                                  KIT_ERROR_KINDS value (same pairing the
 *                                  harness uses for mechanism evidence).
 * - SFC1001 (SCHEMA_VALIDATION_FAILED) — a contract document discovered in a
 *                                  target failed its registered schema (the
 *                                  check command reports these).
 *
 * HarnessError instances thrown by skill-family-harness-node are already
 * coded (SFC2004 + their own stable kinds) and propagate unchanged; the kit
 * never re-wraps or masks them.
 */

/**
 * Stable kit-level failure kinds. Each value appears as `details.kind` on a
 * KitError or as the `kind` of a plan/check finding. The set is frozen for
 * the v1 kit; values are strings so they serialize unchanged.
 */
export const KIT_ERROR_KINDS = Object.freeze({
  // scaffold
  TARGET_NOT_DIRECTORY: "target-not-directory",
  TARGET_NOT_EMPTY: "target-not-empty",
  INVALID_ROOT: "invalid-root",
  // projection
  INVALID_MANIFEST: "invalid-manifest",
  UNAUTHORIZED_PATH: "unauthorized-path",
  HANDWRITTEN_OVERWRITE: "handwritten-overwrite",
  SELF_PROJECTION: "self-projection",
  CONFLICT_DRIFT: "conflict-drift",
  TYPE_CONFLICT: "type-conflict",
  SYMLINK_ON_PLANNED_PATH: "symlink-on-planned-path",
  PROJECTION_WRITE_FAILED: "projection-write-failed",
  // check / shared
  CONTRACTS_MISSING: "contracts-missing",
  CONTRACT_PARSE_FAILED: "contract-parse-failed",
  DOCUMENT_INCOMPLETE: "document-incomplete",
  CHECK_CLASS_FAILED: "check-class-failed",
  MANAGED_FILE_MISSING: "managed-file-missing",
  MANAGED_FILE_DRIFT: "managed-file-drift",
  SYMLINK_AT_MANAGED_PATH: "symlink-at-managed-path",
  NOT_A_REGULAR_FILE: "not-a-regular-file",
  CLOSURE_INPUT_MISSING: "closure-input-missing",
  CONTRACTS_VERSION_MISMATCH: "contracts-version-mismatch",
  README_MISSING: "readme-missing",
  IDENTITY_MISMATCH: "identity-mismatch",
  IDENTITY_RECORD_MISSING: "identity-record-missing",
  GIT_NO_COMMITS: "git-no-commits",
  GIT_DIRTY: "git-dirty",
  MUTATION_MODE_REQUESTED: "mutation-mode-requested",
  // core check: the single shared closed-world entry (C2)
  UNREGISTERED_FILE: "unregistered-file",
  SYMLINK_ENTRY: "symlink-entry",
  SPECIAL_ENTRY: "special-entry",
  UNCONTAINED_DECLARATION: "uncontained-declaration",
  // report sub-actions (projection report / check report, FND-ADR-005)
  REPORT_INPUT_MISSING: "report-input-missing",
  REPORT_PATH_CONFLICT: "report-path-conflict",
  REPORT_WRITE_FAILED: "report-write-failed",
  // read-only host integration slice
  HOST_CONTRACT_INVALID: "host-contract-invalid",
  HOST_PROBE_FAILED: "host-probe-failed",
  HOST_BUILD_FAILED: "host-build-failed",
});

/** Error carrying one frozen SFC code plus a stable kit kind in details. */
export class KitError extends ContractsError {
  constructor(code, message, details) {
    if (!isRegisteredErrorCode(code)) {
      throw new TypeError(
        `KitError refuses unregistered error code: ${String(code)}`,
      );
    }
    super(code, message, details);
    this.name = "KitError";
  }
}

/**
 * Builds the canonical kit execution-failure error: SFC2004 with a stable
 * details.kind. Extra structured evidence may be merged into details but can
 * never override the kind.
 */
export function kitError(kind, message, extraDetails) {
  const values = Object.values(KIT_ERROR_KINDS);
  if (!values.includes(kind)) {
    throw new TypeError(`kitError: unknown kit error kind: ${String(kind)}`);
  }
  const details = { ...(extraDetails ?? {}), kind };
  return new KitError("SFC2004", message, details);
}

/**
 * Aggregate refusal error for projection refusals. The first refusal's kind
 * becomes details.kind; it may be a kit kind OR a stable harness kind
 * (path-traversal, symlink-escape, ...) that propagated unchanged — both
 * sets are frozen and stable, and the SFC code stays registered.
 */
export function refusalError(refusals, message, extraDetails) {
  if (!Array.isArray(refusals) || refusals.length === 0) {
    throw new TypeError("refusalError: refusals must be a non-empty array");
  }
  const first = refusals[0];
  const kind = first && typeof first.kind === "string" && first.kind.length > 0 ? first.kind : "refused";
  return new KitError("SFC2004", message, { ...(extraDetails ?? {}), kind, refusals });
}

/** Intake rejection: a name outside the frozen four-command vocabulary. */
export function unknownCommandError(name) {
  return new KitError(
    "SFC2002",
    `unknown command: ${String(name)} (the kit has exactly four top-level commands)`,
    { kind: "unknown-command", command: String(name) },
  );
}

/** Intake rejection: option/parameter values violate the command contract. */
export function invalidParamsError(message, extraDetails) {
  return new KitError("SFC2003", message, {
    ...(extraDetails ?? {}),
    kind: "invalid-params",
  });
}

/**
 * Flags that request a mutation mode the kit structurally does not have.
 * They are refused at intake (never silently ignored) so a caller cannot
 * believe an auto-fix or an adopt-in-place happened.
 */
export const REFUSED_MUTATION_FLAGS = Object.freeze([
  "--fix",
  "--apply",
  "--adopt",
  "--write",
  "--repair",
  "--force",
  "--overwrite",
]);

export function mutationModeError(flag, command) {
  return new KitError(
    "SFC2003",
    `refused: '${flag}' requests a mutation mode the '${command}' command does not have (the kit never auto-fixes)`,
    { kind: KIT_ERROR_KINDS.MUTATION_MODE_REQUESTED, flag },
  );
}
