import { ContractsError } from "skill-family-contracts";
import { buildProfileDraft, planAdoption } from "./adopt-plan.mjs";
import { CHECK_CLASSES, DOCUMENT_STATES, PLATFORM_SUBSET_DECLARATION_KIND, runChecks } from "./check.mjs";
import { CORE_CHECK_SECURITY_KINDS, isContainedDeclaration, runCoreCheck } from "./core-check.mjs";
import {
  checkEntriesAction,
  ENTRY_CONTRACT_DECLARATION_KIND,
  ENTRY_CONTRACT_DECLARATION_PATH,
  ENTRY_FORMS,
  ENTRY_SIDE_EFFECT_CLASSES,
  runEntryContractCheck,
} from "./entry-check.mjs";
import {
  RELOCK_LOCK_PATH_PATTERN,
  RELOCK_REPORT_KIND,
  relockAction,
  runRelock,
} from "./relock.mjs";
import {
  invalidParamsError,
  KitError,
  KIT_ERROR_KINDS,
  kitError,
  mutationModeError,
  REFUSED_MUTATION_FLAGS,
  unknownCommandError,
} from "./errors.mjs";
import {
  GIT_CHECK_IGNORE_ARGS,
  GIT_LS_FILES_ARGS,
  GIT_READ_ONLY_ALLOWLIST,
  GIT_STATUS_ARGS,
  probeGitFacts,
  probeGitState,
} from "./gitprobe.mjs";
import {
  assessAdoptionBinding,
  assessLegacyExitList,
  assessLegacyReferences,
  assessVerificationEvidence,
  evaluateMigrationCompletion,
  EXCEPTION_REQUIRED_FIELDS,
  findNestedRepositories,
  loadMigrationManifest,
  loadMigrationManifestState,
  MIGRATION_MANIFEST_KIND,
  MIGRATION_MANIFEST_PATH,
  MIGRATION_MANIFEST_SCHEMA_ID,
  MIGRATION_MANIFEST_STATES,
  MIGRATION_STATES,
  REQUIRED_FOUNDATION_PACKAGES,
  VERIFICATION_EVIDENCE_KINDS,
  validateException,
} from "./migration.mjs";
import {
  checkIdentityDrift,
  loadIdentityRecord,
  validateIdentityAgainstProfile,
} from "./identity-check.mjs";
import {
  bundledProfilesRoot,
  generateIdentityRecord,
  generateLicenseContent,
  generateNoticeContent,
  listLicensingProfiles,
  loadLicensingProfile,
} from "./licensing.mjs";
import { buildProjectionClosure, compileProjectionPlan, PROJECTION_AUTHORITY_BINDING_KINDS, runProjection, loadProjectionManifest } from "./projection.mjs";
import { checkReportAction, renderReportAction } from "./report.mjs";
import { scaffoldTarget } from "./scaffold.mjs";
import {
  assertPlanConsistency,
  buildHostAdapter,
  verifyHostPeers,
  materializeHostBuild,
  planHost,
  applyHostPlan,
  probeHost,
  refuseHostApply,
} from "./host.mjs";
import { bundledHostProfilesRoot, describeHost, loadHostRegistry, resolveHostId } from "./host-profiles.mjs";
import { runHostVerification, verifyHostVerificationBindings } from "./host-verification.mjs";
import { runPluginVerification } from "./plugin-verification.mjs";
import {
  describeSkeletonFiles,
  IDENTITY_RECORD_PATH,
  KIT_TOOL_NAME,
  KIT_VERSION,
  MANAGED_LOCK_PATH,
  normalizeSkeletonInputs,
  PLATFORM_SUBSET_DECLARATION_PATH,
  PROJECT_MANIFEST_PATH,
  PROJECTION_MANIFEST_PATH,
  PUBLIC_BOUNDARY_DECLARATION_PATH,
} from "./skeleton.mjs";
import { matchAnyGlob } from "./workspace.mjs";

/**
 * skill-family-engineering-kit: the four build-time engineering commands.
 *
 * The kit consumes skill-family-contracts (structures, registered schemas,
 * stable error codes) and skill-family-harness-node (atomic contained
 * writes, path containment, resource closure, digests); it re-declares none
 * of them. It owns exactly four top-level commands and their read-only /
 * restricted-write boundaries. It never performs git writes, publishes,
 * deletes user content, or touches a network.
 */

export const TOP_LEVEL_COMMANDS = Object.freeze([
  "scaffold",
  "adopt-plan",
  "projection",
  "check",
]);

export const FORBIDDEN_SIDE_EFFECTS = Object.freeze([
  "git-init",
  "git-commit",
  "git-push",
  "git-tag",
  "publish",
  "delete",
  "remote-write",
]);

/** Stable side-effect declarations, one per command (surfaced by --help). */
export const COMMAND_SIDE_EFFECTS = Object.freeze({
  scaffold: Object.freeze({
    summary: "在空目录生成 Skill Family 项目骨架。",
    sideEffect:
      "writes skeleton files into the target directory only; the target must be empty (or a not-yet-existing path whose parent exists); every write is atomic and contained",
    exitCodes: "0 成功；2 拒绝/用法/机制错误",
  }),
  "adopt-plan": Object.freeze({
    summary: "严格只读地规划存量仓采用与迁移闭环。",
    sideEffect:
      "none — strictly read-only: no files written (not even temporary ones), no git writes, no renames, no remote access; the plan (write set, conflicts, risks, legacy exit list, exception validation, completion gate) is printed to stdout",
    exitCodes: "0 计划已输出；2 拒绝/用法/机制错误",
  }),
  projection: Object.freeze({
    summary: "投影受管生成物。",
    sideEffect:
      "writes or deletes only explicitly owned, manifest-authorized managed artifacts; the report sub-action (projection report) writes only the explicitly named --out/--binding paths contained in --root (Markdown goes to stdout when no --out is given); unauthorized, handwritten, escaping, or conflicting paths are refused before mutation",
    exitCodes: "0 成功；2 拒绝/用法/机制错误",
  }),
  check: Object.freeze({
    summary: "契约/漂移/闭包/版本/文档事实/Git 前置状态诊断。",
    sideEffect:
      "none for ordinary diagnosis — never writes, never auto-fixes; git is probed read-only (one frozen status query at most); report and entries sub-actions remain read-only; relock is the one controlled write transaction; qualification is separately explicit and may invoke the capability-specific native host only after its preflight",
    exitCodes: "0 无发现；1 有发现；2 拒绝/用法/机制错误",
  }),
});

/** Stable process exit codes for every command. */
export const KIT_EXIT_CODES = Object.freeze({
  ok: 0,
  findings: 1,
  rejected: 2,
});

/**
 * Dispatches one command by name. Returns { exitCode, output } where output
 * is the structured result document (JSON-serializable). Throws KitError /
 * HarnessError with registered SFC codes; the CLI maps throws to exit 2.
 */
export async function runCommand(command, options = {}) {
  if (!TOP_LEVEL_COMMANDS.includes(command)) {
    throw unknownCommandError(command);
  }
  switch (command) {
    case "scaffold": {
      const output = await scaffoldTarget(options);
      return { exitCode: KIT_EXIT_CODES.ok, output };
    }
    case "adopt-plan": {
      const output = await planAdoption(options);
      return { exitCode: KIT_EXIT_CODES.ok, output };
    }
    case "projection": {
      const output = await runProjection(options);
      return { exitCode: KIT_EXIT_CODES.ok, output };
    }
    case "check": {
      const output = await runChecks(options);
      // 0 clean; 2 mechanism (a selected class could not complete); 1 findings.
      const exitCode = output.mechanism
        ? KIT_EXIT_CODES.rejected
        : output.ok
          ? KIT_EXIT_CODES.ok
          : KIT_EXIT_CODES.findings;
      return { exitCode, output };
    }
    default: {
      // TOP_LEVEL_COMMANDS is frozen with exactly the cases above; this
      // branch is unreachable and exists only to keep the switch total.
      throw unknownCommandError(command);
    }
  }
}

export {
  KitError,
  KIT_ERROR_KINDS,
  kitError,
  invalidParamsError,
  unknownCommandError,
  mutationModeError,
  REFUSED_MUTATION_FLAGS,
};
export {
  scaffoldTarget,
  planAdoption,
  buildProfileDraft,
  buildProjectionClosure,
  compileProjectionPlan,
  PROJECTION_AUTHORITY_BINDING_KINDS,
  runProjection,
  loadProjectionManifest,
  renderReportAction,
  checkReportAction,
  runEntryContractCheck,
  checkEntriesAction,
  ENTRY_CONTRACT_DECLARATION_PATH,
  ENTRY_CONTRACT_DECLARATION_KIND,
  ENTRY_FORMS,
  ENTRY_SIDE_EFFECT_CLASSES,
  runRelock,
  relockAction,
  RELOCK_LOCK_PATH_PATTERN,
  RELOCK_REPORT_KIND,
  runChecks,
  CHECK_CLASSES,
  DOCUMENT_STATES,
  PLATFORM_SUBSET_DECLARATION_KIND,
  runCoreCheck,
  CORE_CHECK_SECURITY_KINDS,
  isContainedDeclaration,
  probeGitState,
  probeGitFacts,
  GIT_READ_ONLY_ALLOWLIST,
  GIT_STATUS_ARGS,
  GIT_LS_FILES_ARGS,
  GIT_CHECK_IGNORE_ARGS,
  describeSkeletonFiles,
  normalizeSkeletonInputs,
  KIT_TOOL_NAME,
  KIT_VERSION,
  PROJECT_MANIFEST_PATH,
  MANAGED_LOCK_PATH,
  PROJECTION_MANIFEST_PATH,
  IDENTITY_RECORD_PATH,
  PUBLIC_BOUNDARY_DECLARATION_PATH,
  PLATFORM_SUBSET_DECLARATION_PATH,
  matchAnyGlob,
  describeHost,
  resolveHostId,
  loadHostRegistry,
  bundledHostProfilesRoot,
  probeHost,
  buildHostAdapter,
  materializeHostBuild,
  planHost,
  verifyHostPeers,
  applyHostPlan,
  assertPlanConsistency,
  refuseHostApply,
  runHostVerification,
  verifyHostVerificationBindings,
  runPluginVerification,
};
export { ContractsError };

// Licensing and identity exports (FND-045, single licensing policy authority)
export {
  loadLicensingProfile,
  listLicensingProfiles,
  bundledProfilesRoot,
  generateLicenseContent,
  generateNoticeContent,
  generateIdentityRecord,
};
export {
  loadIdentityRecord,
  checkIdentityDrift,
  validateIdentityAgainstProfile,
};

// Migration closure exports (FND-070, formalized by the migration manifest contract)
export {
  MIGRATION_MANIFEST_PATH,
  MIGRATION_MANIFEST_KIND,
  MIGRATION_MANIFEST_SCHEMA_ID,
  MIGRATION_MANIFEST_STATES,
  MIGRATION_STATES,
  REQUIRED_FOUNDATION_PACKAGES,
  VERIFICATION_EVIDENCE_KINDS,
  EXCEPTION_REQUIRED_FIELDS,
  loadMigrationManifest,
  loadMigrationManifestState,
  validateException,
  findNestedRepositories,
  assessAdoptionBinding,
  assessVerificationEvidence,
  assessLegacyExitList,
  assessLegacyReferences,
  evaluateMigrationCompletion,
};
