import { lstat, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { CONTRACTS_VERSION, ContractsError, findSchemaByObject } from "skill-family-contracts";
import {
  computeResourceClosure,
  digestBytes,
  readFileContained,
  validateContractDocument,
  writeFileAtomic,
} from "skill-family-harness-node";
import { KIT_ERROR_KINDS, kitError } from "./errors.mjs";
import {
  describeSkeletonFiles,
  KIT_TOOL_NAME,
  KIT_VERSION,
  MANAGED_LOCK_PATH,
  normalizeSkeletonInputs,
  PROJECT_MANIFEST_PATH,
} from "./skeleton.mjs";
import { resolveTargetRoot } from "./workspace.mjs";
import { resolveScaffoldCapabilities } from "./capability-assessment.mjs";

/**
 * scaffold — generate a project skeleton into an EMPTY target only.
 *
 * Boundary rules (all enforced before any write):
 * - the target must be an existing empty directory, or a not-yet-existing
 *   path whose parent exists (the kit creates the final directory only);
 * - a non-empty target (any entry, dotfiles included) is refused with the
 *   stable kind target-not-empty and left byte-for-byte untouched;
 * - every file write goes through the harness atomic contained writer, so
 *   a failure never leaves a partial file and no path can escape the
 *   target root.
 *
 * After writing, the two contract documents are re-read from disk and
 * validated against their registered schemas, and the resource closure of
 * the written set is computed; both are part of the returned result.
 */

async function assertEmptyTarget(root) {
  let dirents;
  try {
    dirents = await readdir(root, { withFileTypes: true });
  } catch (cause) {
    throw kitError(
      KIT_ERROR_KINDS.INVALID_ROOT,
      `target directory cannot be read: ${cause && cause.code ? cause.code : "unknown"}`,
      { root: "<opaque>" },
    );
  }
  if (dirents.length > 0) {
    throw kitError(
      KIT_ERROR_KINDS.TARGET_NOT_EMPTY,
      `scaffold refuses a non-empty target (${dirents.length} entr${dirents.length === 1 ? "y" : "ies"} present); nothing was written`,
      { root: "<opaque>", entryCount: dirents.length },
    );
  }
}

/**
 * Scaffolds one project skeleton.
 * Options: { root, projectId, projectName, profileId, licensingProfile, licensingProfileData, profilesRoot }.
 * Returns a structured result; throws KitError with a stable kind on any
 * refusal. Never writes outside the target root.
 */
export async function scaffoldTarget({ root, projectId, projectName, profileId, licensingProfile, licensingVariant, licensingProfileData, profilesRoot, identityProjections, capabilities = [] } = {}) {
  if (root === undefined || root === null) {
    throw kitError(KIT_ERROR_KINDS.INVALID_ROOT, "scaffold requires an explicit target root");
  }
  const rootAbs = path.resolve(root);

  // Intake validation first: a rejected id/name/profile must not create
  // anything on disk.
  const inputs = normalizeSkeletonInputs({
    projectId,
    projectName,
    profileId,
    licensingProfile,
    licensingVariant,
    rootBasename: path.basename(rootAbs),
  });

  // Resolve and validate the entire repeated selection before the target is
  // created. This is the only capability selection pass used by scaffold.
  const scaffoldSelection = await resolveScaffoldCapabilities(capabilities);

  // Resolve the licensing profile and compute the complete deterministic
  // write set before creating the target directory. Invalid or incomplete
  // profile coordinates (for example a multi-variant profile without a
  // variant) must leave zero filesystem traces.
  const skeleton = await describeSkeletonFiles({
    ...inputs,
    scaffoldSelection,
    licensingProfileData,
    profilesRoot,
    identityProjections,
  });

  // The target may not exist yet; its parent must (the kit creates only
  // the final component, never a chain of directories outside the target).
  let targetExists = false;
  try {
    const st = await lstat(rootAbs);
    targetExists = true;
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw kitError(
        KIT_ERROR_KINDS.TARGET_NOT_DIRECTORY,
        "scaffold target exists but is not a plain directory",
      );
    }
  } catch (cause) {
    if (cause instanceof ContractsError) throw cause;
    if (targetExists) throw cause;
  }

  if (targetExists) {
    await assertEmptyTarget(rootAbs);
  } else {
    try {
      await mkdir(rootAbs); // non-recursive: parent must already exist
    } catch (cause) {
      throw kitError(
        KIT_ERROR_KINDS.INVALID_ROOT,
        `cannot create scaffold target (does its parent exist?): ${cause && cause.code ? cause.code : "unknown"}`,
        { root: "<opaque>" },
      );
    }
  }

  // From here on, every access is contained in rootAbs.
  const resolvedRoot = await resolveTargetRoot(rootAbs);
  const written = [];
  for (const file of skeleton.files) {
    await writeFileAtomic(resolvedRoot, file.path, file.content);
    written.push({
      path: file.path,
      fileClass: file.fileClass,
      sha256: digestBytes(Buffer.from(file.content, "utf8")),
    });
  }

  // Self-verification: re-read the contract documents from disk and
  // validate them against the registered schemas (contracts authority).
  const verifications = [];
  for (const [objectName, relPath] of [
    ["project-manifest", PROJECT_MANIFEST_PATH],
    ["managed-file-lock", MANAGED_LOCK_PATH],
  ]) {
    const registration = findSchemaByObject(objectName);
    const text = await readFileContained(resolvedRoot, relPath, { encoding: "utf8" });
    const outcome = validateContractDocument(JSON.parse(text), { schemaId: registration.$id });
    if (!outcome.valid) {
      throw kitError(
        KIT_ERROR_KINDS.PROJECTION_WRITE_FAILED,
        `scaffold produced a ${objectName} that fails its registered schema`,
        { path: relPath, errorCode: outcome.errorCode },
      );
    }
    verifications.push({ path: relPath, schemaId: registration.$id, valid: true });
  }

  // Resource closure of the written set (harness mechanism).
  const closure = await computeResourceClosure({
    root: resolvedRoot,
    resources: skeleton.files.map((file) => ({ path: file.path, role: "output" })),
  });

  return {
    kind: "skill-family.scaffold-result",
    schemaVersion: 1,
    generatedBy: { tool: KIT_TOOL_NAME, version: KIT_VERSION },
    project: {
      ...inputs,
      licensingProfile: skeleton.licensing.profile,
      licensingVariant: skeleton.licensing.variant,
      contractsVersion: CONTRACTS_VERSION,
    },
    files: written,
    verifications,
    closure: { digest: closure.digest, resourceCount: closure.resources.length },
    selectedCapabilities: skeleton.scaffoldSelection.selectedCapabilities,
    generatedContractTests: skeleton.scaffoldSelection.generatedContractTests,
    selectionWarnings: skeleton.scaffoldSelection.selectionWarnings,
    policy:
      "scaffold writes only into an empty target; every write is atomic and contained; nothing outside the target is touched",
  };
}
