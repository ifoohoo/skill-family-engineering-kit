import path from "node:path";
import {
  CONTRACTS_VERSION,
  ContractsError,
  findSchemaByObject,
  validateDocument,
  validateEngineeringBaseline,
} from "skill-family-contracts";
import { digestBytes, readFileContained } from "skill-family-harness-node";
import { runChecks } from "./check.mjs";
import { probeGitFacts, probeGitState } from "./gitprobe.mjs";
import {
  assessAdoptionBinding,
  assessLegacyExitList,
  assessLegacyReferences,
  assessVerificationEvidence,
  evaluateMigrationCompletion,
  findNestedRepositories,
  loadMigrationManifestState,
  MIGRATION_MANIFEST_PATH,
  REQUIRED_FOUNDATION_PACKAGES,
  validateException,
} from "./migration.mjs";
import {
  describeSkeletonFiles,
  describeSkeletonReferenceImplementation,
  KIT_TOOL_NAME,
  KIT_VERSION,
  normalizeSkeletonInputs,
} from "./skeleton.mjs";
import { bundledProfilesRoot } from "./licensing.mjs";
import { invalidParamsError } from "./errors.mjs";
import {
  listTargetEntries,
  loadTargetFacts,
  matchAnyGlob,
  normalizeRelPath,
  resolveTargetRoot,
} from "./workspace.mjs";
import { buildCapabilityAssessment } from "./capability-assessment.mjs";
import { assessCapabilityMigration, CONSUMER_VERIFICATION_NOT_EVALUATED } from "./migration.mjs";

async function readProfileCapabilities(rootAbs, { projectId, profileId } = {}) {
  // Profile capability declarations are target-owned data. Kit reads only a
  // contract-valid project profile with matching identity; it never validates,
  // repairs, or writes profile.json and never consumes an alternate shape.
  let value;
  try {
    const bytes = await readFileContained(rootAbs, "profile.json");
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    return [];
  }
  if (!value || typeof value !== "object") return [];
  const registration = findSchemaByObject("project-profile");
  if (!registration) return [];
  const validation = validateDocument(value, {
    schemaId: registration.$id,
    dialect: registration.dialect,
    policy: "strict",
  });
  if (!validation.valid) return [];
  const profile = validation.data;
  if (profile.schemaVersion !== 1 || profile.kind !== "skill-family.project-profile") return [];
  if (profile.project?.id !== projectId) return [];
  if (profile.adoption?.foundation_profile?.id !== profileId) return [];
  return Array.isArray(profile.adoption?.capabilities) ? [...profile.adoption.capabilities] : [];
}

function buildCapabilityGuidance({ manifest, assessment, migrationFacts, profileCapabilities }) {
  const uses = manifest?.capabilityUses ?? [];
  const decisions = manifest?.capabilityDecisions ?? [];
  const views = new Map([
    ...(assessment?.scopeCapabilities ?? []),
    ...(assessment?.scopeBoundaries ?? []),
  ].map((view) => [view.id, view]));
  return uses.flatMap((use) => {
    const matching = decisions.filter((decision) => decision?.useId === use.useId);
    if (matching.length !== 1) return [];
    const decision = matching[0];
    const guidance = {
      useId: use.useId,
      disposition: decision.disposition,
      reason: decision.reason,
      retainedResponsibility: [...use.retainedGuarantees],
      legacy: migrationFacts.legacyByUse.get(use.useId) ?? { infra: [], references: [] },
      blockers: migrationFacts.byUse.get(use.useId) ?? [],
      profile: { declared: null },
      currentPin: null,
      nextActions: [],
      consumerVerification: CONSUMER_VERIFICATION_NOT_EVALUATED,
    };
    if (decision.disposition === "direct-adoption" || decision.disposition === "compatibility-layer") {
      guidance.targetCapability = decision.targetCapability;
      guidance.capability = views.get(decision.targetCapability) ?? null;
      guidance.profile = { declared: profileCapabilities.includes(decision.targetCapability) };
      guidance.currentPin = assessment.foundationPackages.find(
        (candidate) => candidate.name === guidance.capability?.package,
      )?.version ?? assessment.foundationPackages[0]?.version ?? null;
      guidance.nextActions = guidance.blockers.length > 0
        ? ["先处理当前 guidance.blockers，再由消费者完成契约测试和领域验收"]
        : ["由消费者运行公共入口、同版本契约向量和领域测试后确认采用"];
    } else {
      guidance.nextActions = ["保留消费者领域实现，并从旧实现退出清单移除错误关联"];
    }
    return [guidance];
  });
}

/**
 * adopt-plan — strictly read-only adoption planning.
 *
 * Computes the exact write set, conflicts, risks, and verification plan for
 * adopting the Skill Family skeleton into an existing target. The function
 * contains no write call of any kind: it reads the target, computes the
 * plan in memory, and returns it. Callers print it; nothing is written,
 * not even a temporary file (so "zero byte change on dirty repositories"
 * is trivially verifiable with before/after hash walks).
 *
 * Planned content comes from describeSkeletonFiles — the same pure function
 * scaffold consumes — so the plan and the later action are byte-identical.
 */

async function readExistingBytes(rootAbs, relPath) {
  // Contained read: even though planned paths are a frozen set, every fs
  // access goes through the harness containment layer.
  try {
    return await readFileContained(rootAbs, relPath);
  } catch {
    return null;
  }
}

function assertEngineeringBaselineOptions(engineeringBaseline, compareSkeleton) {
  const hasBaseline = engineeringBaseline !== undefined;
  const comparisonEnabled = compareSkeleton === true;
  if (hasBaseline !== comparisonEnabled || (compareSkeleton !== undefined && compareSkeleton !== true)) {
    throw invalidParamsError(
      "engineeringBaseline and compareSkeleton: true must be provided together",
      { reason: "invalid-option-combination" },
    );
  }
  if (!hasBaseline) return null;

  const validation = validateEngineeringBaseline(engineeringBaseline);
  if (!validation.valid) {
    throw new ContractsError(
      "SFC1001",
      "engineeringBaseline violates the registered engineering-baseline contract",
      { errors: validation.errors },
    );
  }
  return validation.data;
}

async function prepareEngineeringBaselineComparison({
  engineeringBaseline,
  compareSkeleton,
  profileId,
}) {
  const baseline = assertEngineeringBaselineOptions(engineeringBaseline, compareSkeleton);
  if (baseline === null) return null;

  const declaredReference = baseline.referenceImplementation;
  if (declaredReference.foundationVersion !== KIT_VERSION) {
    throw new ContractsError(
      "SFC1013",
      `engineering baseline Foundation version mismatch (expected ${KIT_VERSION}, received ${declaredReference.foundationVersion})`,
      {
        expectedFoundationVersion: KIT_VERSION,
        receivedFoundationVersion: declaredReference.foundationVersion,
      },
    );
  }

  const referenceImplementation = await describeSkeletonReferenceImplementation({
    profile: declaredReference.profile,
  });
  if (declaredReference.skeletonDigest !== referenceImplementation.skeletonDigest) {
    throw new ContractsError(
      "SFC1013",
      "engineering baseline reference skeleton digest does not match the installed Foundation package",
      {
        expectedSkeletonDigest: referenceImplementation.skeletonDigest,
        receivedSkeletonDigest: declaredReference.skeletonDigest,
      },
    );
  }

  if (profileId !== undefined && profileId !== null && profileId !== declaredReference.profile) {
    throw invalidParamsError(
      `explicit profile '${profileId}' conflicts with engineering baseline profile '${declaredReference.profile}'`,
      { reason: "engineering-baseline-profile-conflict" },
    );
  }

  const referenceSkeleton = await describeSkeletonFiles({
    projectId: "fictional-reference-plugin",
    projectName: "Fictional Reference Plugin",
    profileId: declaredReference.profile,
    licensingProfile: "open-source",
    licensingVariant: "default",
    profilesRoot: bundledProfilesRoot(),
    capabilities: [],
  });
  return {
    baseline,
    referenceImplementation,
    referenceSkeleton,
    effectiveProfileId: declaredReference.profile,
  };
}

function targetFileClass(relPath, facts) {
  if (facts.managedSet.has(relPath)) return "managed";
  if (matchAnyGlob(facts.handwrittenPatterns, relPath)) return "handwritten";
  return "unclassified";
}

function buildStructuralDifferences(referenceFiles, entries, facts) {
  const referenceByPath = new Map(referenceFiles.map((file) => [normalizeRelPath(file.path), file]));
  const targetByPath = new Map(entries.map((entry) => [entry.path, entry]));
  const referenceOnly = [];
  const entryTypeDifferences = [];
  const fileClassDifferences = [];

  for (const [relPath, reference] of referenceByPath) {
    const target = targetByPath.get(relPath);
    if (!target) {
      referenceOnly.push({ path: relPath, fileClass: reference.fileClass });
      continue;
    }
    if (target.kind !== "file") {
      entryTypeDifferences.push({
        path: relPath,
        referenceType: "file",
        targetType: target.kind,
        referenceFileClass: reference.fileClass,
      });
      continue;
    }
    const actualFileClass = targetFileClass(relPath, facts);
    if (actualFileClass !== reference.fileClass) {
      fileClassDifferences.push({
        path: relPath,
        referenceFileClass: reference.fileClass,
        targetFileClass: actualFileClass,
      });
    }
  }

  const targetOnly = entries
    .filter((entry) =>
      !referenceByPath.has(entry.path)
      && entry.kind !== "directory"
      && entry.kind !== "directory-opaque")
    .map((entry) => ({ path: entry.path, entryType: entry.kind }));

  const byPath = (left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  referenceOnly.sort(byPath);
  targetOnly.sort(byPath);
  entryTypeDifferences.sort(byPath);
  fileClassDifferences.sort(byPath);
  return { referenceOnly, targetOnly, entryTypeDifferences, fileClassDifferences };
}

/**
 * The per-adoption project profile draft (SPI v3; remediation handoff C3/D-8).
 *
 * Replaces the deprecated ten-field hand-off draft of the adoption-lock
 * era: the adoption-lock concept and its artifact form are abolished, and
 * the lightweight adoption proof is the profile.json descriptor's own
 * adoption declaration, machine-verified by verifyProjectProfile:
 * descriptor-schema completeness of the minimal adoption field set, GK-4
 * real-file digest discipline (SPE1006), and the tightening-only overrides
 * policy (SPE1007).
 *
 * The draft pre-fills everything derivable from read-only facts:
 * - descriptor identity (profile id/name from the plan inputs) and the
 *   frozen contracts base;
 * - the D-8 minimal adoption field set (foundation_profile, foundation_pin,
 *   adopted_at) with pin versions pre-filled manifest-declaration-first,
 *   then from the loaded package constants;
 * - an empty overrides array — the empty example. Overrides are opt-in
 *   self-tightening declarations; the kit never enumerates rule examples
 *   (the core never imports the profile layer).
 * Every non-derivable field stays null and is listed in incompleteFields —
 * the kit never guesses. The draft binds the target file-set digest and the
 * Foundation plan digest.
 */
export function buildProfileDraft({ inputs, migrationManifest, writeSet, entries }) {
  const incompleteFields = [];

  // foundation_profile (D-8 minimal set): the adopted foundation profile id
  // is derivable from the plan inputs; its version and stability are human
  // decisions the kit never guesses.
  const foundationProfile = { id: inputs.profileId, version: null, stability: null };
  incompleteFields.push("adoption.foundation_profile.version", "adoption.foundation_profile.stability");

  // foundation_pin (D-8 minimal set): versions are manifest-declared
  // bindings first, then loaded package constants; path and sha256 exist
  // only once the real pinned artifacts have been placed inside the profile
  // write set — until then they stay null (GK-4 digest discipline: a digest
  // is computed from real artifact bytes, never guessed).
  const declaredPackages = Array.isArray(migrationManifest?.foundationPackages)
    ? migrationManifest.foundationPackages
    : [];
  const declaredByName = new Map(
    declaredPackages
      .filter((pkg) => pkg && typeof pkg.name === "string")
      .map((pkg) => [pkg.name, pkg]),
  );
  const loadedVersions = Object.freeze({
    "skill-family-contracts": KIT_VERSION,
    "skill-family-harness-node": KIT_VERSION,
    "skill-family-engineering-kit": KIT_VERSION,
  });
  const packages = {};
  for (const name of [...REQUIRED_FOUNDATION_PACKAGES].sort()) {
    const version = declaredByName.get(name)?.version ?? loadedVersions[name] ?? null;
    if (version === null) incompleteFields.push(`adoption.foundation_pin.packages.${name}.version`);
    incompleteFields.push(
      `adoption.foundation_pin.packages.${name}.path`,
      `adoption.foundation_pin.packages.${name}.sha256`,
    );
    packages[name] = { version, path: null, sha256: null };
  }

  incompleteFields.push("adoption.adopted_at");

  // Binding digests: the target file-set summary and the Foundation plan.
  const targetSetDigest = digestBytes(
    Buffer.from(entries.map((entry) => `${entry.path}:${entry.kind}`).sort().join("\n"), "utf8"),
  );
  const foundationPlanDigest = digestBytes(
    Buffer.from(writeSet.map((item) => `${item.path}:${item.action}:${item.sha256}`).sort().join("\n"), "utf8"),
  );

  const projectProfile = {
    schemaVersion: 1,
    kind: "skill-family.project-profile",
    project: { id: inputs.projectId, workspace: `${inputs.projectId}-workspace` },
    adoption: {
      foundation_profile: foundationProfile,
      foundation_pin: { algorithm: "sha256", packages },
      adopted_at: null,
    },
    overrides: [],
  };

  return {
    kind: "skill-family.project-profile-draft",
    schemaVersion: 1,
    profileRelPath: "profile.json",
    projectProfile,
    overridesGuidance:
      "overrides stays empty by default. An override is admissible only when it reuses an existing rule id with a project-level numeric value that strictly tightens the frozen rule baseline catalog in the parameter's declared direction (not-increase: strictly less; not-decrease: strictly greater). Equality and relaxation are refused (SPE1007); risk identification for misuse of tightening belongs to skill-failure-auditor, not to this mechanical check.",
    incompleteFields,
    ready: incompleteFields.length === 0,
    binding: { targetSetDigest, foundationPlanDigest },
    policyNote:
      "adoption-lock is deprecated (remediation handoff D-8): the kit no longer produces adoption-lock-form artifacts. The adoption proof is this project's adoption declaration, completed with real artifact paths and digests inside the profile write set and machine-verified by verifyProjectProfile (SPE1006 digest discipline, SPE1007 tightening-only overrides).",
  };
}

/**
 * Plans the adoption of the skeleton into root.
 * Options: { root, projectId, projectName, profileId, licensingProfile,
 * licensingProfileData, profilesRoot, engineeringBaseline, compareSkeleton,
 * allowGitSpawn, now }.
 * Returns the plan document; throws KitError only for unusable inputs
 * (an unreadable target). Never writes anywhere.
 */
export async function planAdoption({
  root,
  projectId,
  projectName,
  profileId,
  licensingProfile,
  licensingVariant,
  licensingProfileData,
  profilesRoot,
  identityProjections,
  engineeringBaseline,
  compareSkeleton,
  allowGitSpawn = true,
  now = Date.now(),
} = {}) {
  const baselineComparison = await prepareEngineeringBaselineComparison({
    engineeringBaseline,
    compareSkeleton,
    profileId,
  });
  const rootAbs = await resolveTargetRoot(root ?? ".");
  const entries = await listTargetEntries(rootAbs);
  const facts = await loadTargetFacts(rootAbs);
  const git = await probeGitState(rootAbs, { allowSpawn: allowGitSpawn });

  const inputs = normalizeSkeletonInputs({
    projectId,
    projectName,
    profileId: baselineComparison?.effectiveProfileId ?? profileId,
    licensingProfile,
    licensingVariant,
    rootBasename: path.basename(rootAbs),
  });
  const skeleton = await describeSkeletonFiles({
    ...inputs,
    licensingProfileData,
    profilesRoot,
    identityProjections,
  });

  const entryByPath = new Map(entries.map((entry) => [entry.path, entry]));

  const writeSet = [];
  const conflicts = [];
  for (const file of skeleton.files) {
    const rel = normalizeRelPath(file.path);
    const plannedSha256 = digestBytes(Buffer.from(file.content, "utf8"));
    const existing = entryByPath.get(rel);

    if (!existing) {
      writeSet.push({
        path: rel,
        fileClass: file.fileClass,
        action: "create",
        sha256: plannedSha256,
      });
      continue;
    }

    if (existing.kind === "symlink") {
      conflicts.push({
        path: rel,
        kind: "symlink-on-planned-path",
        code: "SFC2004",
        detail:
          "a symbolic link occupies the planned path; the kit never writes through links — resolve it manually before adoption",
      });
      continue;
    }
    if (existing.kind === "directory") {
      conflicts.push({
        path: rel,
        kind: "type-conflict",
        code: "SFC2004",
        detail: "a directory occupies the planned file path",
      });
      continue;
    }

    const bytes = await readExistingBytes(rootAbs, rel);
    const existingSha256 = bytes === null ? null : digestBytes(bytes);
    if (existingSha256 === plannedSha256) {
      writeSet.push({
        path: rel,
        fileClass: file.fileClass,
        action: "unchanged",
        sha256: plannedSha256,
      });
      continue;
    }

    // The migration manifest is target-held data once seeded: adoption
    // never overwrites an existing manifest, and its contract validity is
    // assessed exclusively by the migration section below (parse/schema,
    // legacy exit list, temporary exceptions).
    if (rel === MIGRATION_MANIFEST_PATH) continue;

    // Existing, different content: adoption never overwrites. Handwritten
    // material is a hard conflict; a drifted managed declaration needs an
    // explicit human decision before any re-projection.
    const handwritten =
      matchAnyGlob(facts.handwrittenPatterns, rel) || !facts.managedSet.has(rel);
    conflicts.push({
      path: rel,
      kind: handwritten ? "handwritten-conflict" : "managed-drift",
      code: "SFC2004",
      detail: handwritten
        ? "existing content is handwritten (or not declared managed); the kit will never overwrite it"
        : "existing content differs from the planned managed bytes; reconcile before adoption",
    });
  }

  const risks = [];
  // Git-independent unregistered content (also feeds the ten-field hand-off
  // draft field 2): neither planned nor declared managed.
  const plannedPaths = new Set(
    skeleton.files
      .filter((file) => normalizeRelPath(file.path) !== MIGRATION_MANIFEST_PATH)
      .map((file) => normalizeRelPath(file.path)),
  );
  const unregisteredPaths = entries
    .filter(
      (entry) =>
        (entry.kind === "file" || entry.kind === "symlink") &&
        !plannedPaths.has(entry.path) &&
        !facts.managedSet.has(entry.path),
    )
    .map((entry) => entry.path)
    .sort();
  if (git.repository && git.headCommit === false) {
    risks.push({
      kind: "git-no-commits",
      detail: "the target is a git repository without any commit; nothing is protected by history yet",
    });
  }
  if (git.repository && git.cleanState === false) {
    risks.push({
      kind: "git-dirty",
      detail: "the target has uncommitted changes; settle them before adoption (the plan itself changes nothing)",
    });
  }
  if (!git.repository) {
    // Git-independent dirty equivalence (FND-001 modelling): content that
    // is neither planned nor declared managed counts as uncommitted state.
    // The migration manifest is target-held data, not planned content: it
    // is judged by the migration contract, so it stays in this equivalence.
    if (unregisteredPaths.length > 0) {
      risks.push({
        kind: "unregistered-content",
        detail: `${unregisteredPaths.length} entr${unregisteredPaths.length === 1 ? "y" : "ies"} are neither planned nor declared managed; adoption leaves them untouched`,
      });
    }
  }
  if (conflicts.some((conflict) => conflict.kind === "symlink-on-planned-path")) {
    risks.push({
      kind: "symlink-on-planned-path",
      detail: "at least one planned path is a symbolic link; writes through links are refused",
    });
  }

  // Migration-closure facts (FND-070): nested repositories and
  // tracked-but-ignored hazards are reported, never acted upon.
  const nestedRepositories = findNestedRepositories(entries);
  if (nestedRepositories.length > 0) {
    risks.push({
      kind: "nested-repository",
      detail: `embedded repositories present: ${nestedRepositories.join(", ")}; adoption never operates inside a nested repository`,
    });
  }
  // Read-only Git evidence probe: tracked/ignore facts come from real git semantics (read-only
  // index + git's own ignore machinery), never from lexical guesses and
  // never from managed declarations impersonating tracked state. When git
  // is unavailable the facts stay not-proven — unknown, not fabricated.
  const gitFactCandidates = [
    ...entries.filter((entry) => entry.kind === "file" || entry.kind === "symlink").map((entry) => entry.path),
    ...facts.managedSet,
  ];
  const gitFacts = await probeGitFacts(rootAbs, gitFactCandidates, { allowSpawn: allowGitSpawn });
  if (gitFacts.status === "proven" && gitFacts.trackedButIgnored.length > 0) {
    risks.push({
      kind: "tracked-but-ignored",
      detail: `tracked in the git index yet matched by ignore rules: ${gitFacts.trackedButIgnored.join(", ")}; reconcile tracking and ignore state before adoption`,
    });
  }

  // Legacy exit list and temporary exceptions come from the target's own
  // migration manifest; the kit only assesses, it never deletes or renews.
  // The manifest is a formal Contract — only a contract-valid
  // manifest counts as declared; parse/schema failures are hard conflicts.
  const manifestState = await loadMigrationManifestState(rootAbs);
  const manifestDeclared = manifestState.status === "valid";
  if (manifestState.status === "parse-failed") {
    conflicts.push({
      path: MIGRATION_MANIFEST_PATH,
      kind: "migration-manifest-parse-failed",
      code: "SFC2004",
      detail: "the migration manifest is not parseable JSON; fix it before adoption can proceed",
    });
  } else if (manifestState.status === "schema-invalid") {
    conflicts.push({
      path: MIGRATION_MANIFEST_PATH,
      kind: "migration-manifest-invalid",
      code: "SFC1001",
      detail: `the migration manifest violates the migration-manifest contract: ${manifestState.problems.join("; ")}`,
    });
  }
  const migrationManifest = manifestDeclared ? manifestState.manifest : null;
  const legacyExitList = await assessLegacyExitList(rootAbs, migrationManifest?.legacyInfra ?? []);
  for (const item of legacyExitList) {
    if (item.status === "invalid") {
      conflicts.push({
        path: MIGRATION_MANIFEST_PATH,
        kind: "legacy-path-containment",
        code: "SFC2004",
        detail: `legacy path rejected by harness containment, fail-closed: ${item.path ?? "<malformed>"} (${item.invalidKind ?? "unknown"}); user paths are only ever read inside the target root`,
      });
    }
  }
  const legacyReferenceExitList = await assessLegacyReferences(rootAbs, migrationManifest?.legacyReferences ?? []);
  for (const ref of legacyReferenceExitList) {
    if (ref.status === "invalid") {
      conflicts.push({
        path: MIGRATION_MANIFEST_PATH,
        kind: "legacy-path-containment",
        code: "SFC2004",
        detail: `legacy reference path rejected by harness containment, fail-closed: ${ref.path ?? "<malformed>"} (${ref.invalidKind ?? "unknown"}); user paths are only ever read inside the target root`,
      });
    }
  }
  const exceptionFindings = [];
  const declaredExceptions = Array.isArray(migrationManifest?.exceptions) ? migrationManifest.exceptions : [];
  for (const [index, exception] of declaredExceptions.entries()) {
    for (const finding of validateException(exception, index, now)) {
      exceptionFindings.push(finding);
      if (finding.kind === "exception-incomplete") {
        conflicts.push({
          path: MIGRATION_MANIFEST_PATH,
          kind: "exception-incomplete",
          code: "SFC2004",
          detail: `temporary exception #${index} is missing required fields: ${finding.missing.join(", ")} (owner, reason, deadline and migrationTarget are all mandatory)`,
        });
      } else if (finding.kind === "exception-invalid-deadline") {
        conflicts.push({
          path: MIGRATION_MANIFEST_PATH,
          kind: "exception-invalid-deadline",
          code: "SFC2004",
          detail: `temporary exception #${index} carries an unparseable deadline: ${finding.deadline}`,
        });
      } else {
        risks.push({
          kind: "exception-expired",
          detail: `temporary exception #${index} expired at ${finding.deadline}; expired exceptions are never auto-renewed`,
        });
      }
    }
  }
  // Migration completion facts — all derived read-only from evidence on disk:
  // the adoption binding declared by the manifest, the managed-byte proof,
  // the remaining write actions, the Foundation check gate, and the four
  // verification evidence documents.
  const binding = assessAdoptionBinding(migrationManifest, inputs.profileId);
  const adoptionProof = {
    checked: skeleton.files.filter((file) => file.fileClass === "managed").length,
    matched: writeSet.filter((item) => item.fileClass === "managed" && item.action === "unchanged").length,
    missing: writeSet
      .filter((item) => item.fileClass === "managed" && item.action !== "unchanged")
      .map((item) => item.path)
      .sort(),
    mismatched: conflicts.filter((conflict) => conflict.kind === "managed-drift").map((conflict) => conflict.path).sort(),
  };
  const pendingWrites = writeSet.filter((item) => item.action !== "unchanged").length;
  let checkGreen = false;
  let checkNote = null;
  try {
    // check is diagnosis-only (read-only git probes included), so running it
    // inside the read-only plan keeps the zero-byte-change promise.
    const checkReport = await runChecks({ root: rootAbs, allowGitSpawn, profilesRoot });
    checkGreen = checkReport.ok === true;
  } catch (cause) {
    checkNote = cause?.message ?? "check gate could not run";
  }
  const verificationFacts = await assessVerificationEvidence(
    rootAbs,
    migrationManifest?.verification,
    inputs.projectId,
  );

  // Capability assessment and its relationship checks are only activated by
  // the new, paired context + non-empty uses fields.  A legacy 0.13 manifest
  // therefore keeps the old plan shape and completion semantics.
  let capabilityAssessment = null;
  let capabilityGuidance = null;
  let adoptionReminder = null;
  let capabilityMigration = { blockers: [], decisionsByUse: new Map(), byUse: new Map(), legacyByUse: new Map() };
  if (manifestDeclared && Array.isArray(migrationManifest?.capabilityUses) && migrationManifest.capabilityUses.length > 0) {
    capabilityAssessment = await buildCapabilityAssessment({
      mode: "project-assessment",
      scope: migrationManifest.capabilityUseContext.scope,
      locale: migrationManifest.capabilityUseContext.locale,
      uses: migrationManifest.capabilityUses,
      decisions: migrationManifest.capabilityDecisions,
    });
    const profileCapabilities = await readProfileCapabilities(rootAbs, {
      projectId: inputs.projectId,
      profileId: inputs.profileId,
    });
    capabilityMigration = assessCapabilityMigration({
      manifest: migrationManifest,
      assessment: capabilityAssessment,
      profileCapabilities,
    });
    for (const row of capabilityAssessment.useMatrix) {
      const blockers = capabilityMigration.byUse.get(row.useId) ?? [];
      if (blockers.length > 0) {
        row.decision = null;
        row.needsDecision = true;
      }
    }
    capabilityGuidance = buildCapabilityGuidance({
      manifest: migrationManifest,
      assessment: capabilityAssessment,
      migrationFacts: capabilityMigration,
      profileCapabilities,
    });
    adoptionReminder =
      "先查看 capabilityAssessment 的完整用途矩阵，再补齐每项 decision；Foundation 只提供迁移 guidance，consumerVerification 必须由消费者自己的测试或独立验收声明。";
  }

  const completion = evaluateMigrationCompletion({
    manifestDeclared,
    legacyExitList,
    legacyReferenceExitList,
    exceptionFindings,
    conflicts,
    binding,
    adoptionProof,
    pendingWrites,
    checkGreen,
    verificationFacts,
    capabilityBlockers: capabilityMigration.blockers,
  });

  const existingManagedDeclarations = [...facts.managedSet].sort();

  // The profile draft: pre-filled adoption declaration (D-8 minimal set)
  // plus the empty overrides example. Fields that cannot be derived
  // mechanically stay null and block readiness — never guessed.
  const profileDraft = buildProfileDraft({
    inputs,
    migrationManifest,
    writeSet,
    entries,
  });

  return {
    kind: "skill-family.adoption-plan",
    schemaVersion: 1,
    generatedBy: { tool: KIT_TOOL_NAME, version: KIT_VERSION },
    target: {
      root: ".",
      entryCount: entries.length,
      hasOwnFileRegistry: facts.hasOwnRegistry,
      existingManagedDeclarations,
    },
    project: {
      ...inputs,
      licensingProfile: skeleton.licensing.profile,
      licensingVariant: skeleton.licensing.variant,
      contractsVersion: CONTRACTS_VERSION,
    },
    git: {
      repository: git.repository,
      headCommit: git.headCommit,
      cleanState: git.cleanState,
      probe: git.probe,
    },
    gitFacts:
      gitFacts.status === "proven"
        ? {
            status: "proven",
            trackedButIgnored: gitFacts.trackedButIgnored,
            ignoredNotTracked: gitFacts.ignoredNotTracked,
          }
        : { status: "not-proven", reason: gitFacts.reason },
    writeSet,
    conflicts,
    risks,
    migration: {
      manifestDeclared,
      manifestStatus: manifestState.status,
      manifestPath: MIGRATION_MANIFEST_PATH,
      legacyExitList,
      legacyReferenceExitList,
      exceptions: { declared: declaredExceptions.length, findings: exceptionFindings },
      binding,
      adoptionProof,
      pendingWrites,
      check: { green: checkGreen, note: checkNote },
      verification: verificationFacts,
      state: completion.state,
      completion,
    },
    profileDraft,
    ...(capabilityAssessment
      ? { capabilityAssessment, capabilityGuidance, adoptionReminder }
      : {}),
    ...(baselineComparison
      ? {
          engineeringBaselineComparison: {
            baseline: {
              provider: baselineComparison.baseline.provider,
              id: baselineComparison.baseline.id,
              version: baselineComparison.baseline.version,
              digest: baselineComparison.baseline.digest,
            },
            referenceImplementation: baselineComparison.referenceImplementation,
            structuralDifferences: buildStructuralDifferences(
              baselineComparison.referenceSkeleton.files,
              entries,
              facts,
            ),
          },
        }
      : {}),
    traceability: {
      contractsVersion: CONTRACTS_VERSION,
      skeletonSource: "describeSkeletonFiles",
      licensingProfile: skeleton.licensing.profile,
      licensingVariant: skeleton.licensing.variant,
    },
    verificationPlan: [
      {
        step: 1,
        command: "sf-kit check --root <target>",
        purpose: "diagnose contracts, drift, closure, versions, doc facts, and git pre-state",
      },
      {
        step: 2,
        command: "sf-kit projection --root <target>",
        purpose: "materialize only manifest-authorized managed artifacts (never handwritten files)",
      },
      {
        step: 3,
        command: "sf-kit check --root <target>",
        purpose: "re-diagnose after projection; the kit never auto-fixes any finding",
      },
    ],
    policy:
      "strictly read-only: this plan changes nothing in the target (no files, no temp files, no git); every listed byte is computed from describeSkeletonFiles, the same source scaffold consumes; the kit never renames repositories or directories and never touches remotes — infrastructure adoption and repository renaming are separate decisions; migration completion additionally requires every legacy implementation to have exited and every declared legacy reference to be absent from its retained file (dual-track wiring alone is not completion)",
  };
}
