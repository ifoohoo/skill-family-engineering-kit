import path from "node:path";
import { CONTRACTS_VERSION } from "skill-family-contracts";
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
  validateException,
  VERIFICATION_EVIDENCE_KINDS,
} from "./migration.mjs";
import {
  describeSkeletonFiles,
  KIT_TOOL_NAME,
  KIT_VERSION,
  normalizeSkeletonInputs,
} from "./skeleton.mjs";
import {
  listTargetEntries,
  loadTargetFacts,
  matchAnyGlob,
  normalizeRelPath,
  resolveTargetRoot,
} from "./workspace.mjs";

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

/**
 * The ten-field per-repository adoption hand-off draft.
 *
 * adopt-plan must carry enough structured data to draft the planner's
 * ten-field hand-off. Fields that cannot be derived mechanically from
 * read-only evidence are marked INCOMPLETE and block the draft — the kit
 * never guesses. The draft binds the target file-set digest and the
 * Foundation plan digest; rendering is a separate read-only planner task
 * that only ever writes the planner-side draft, never the consumer repo.
 */
export const HANDOFF_FIELDS = Object.freeze([
  "project-identity",
  "repository-state",
  "foundation-binding",
  "write-set-policy",
  "legacy-exits",
  "business-logic-to-keep",
  "plan-summary",
  "verification-entries",
  "legacy-removal-recovery",
  "authorization-status",
]);

export function buildHandoffDraft({
  projectId,
  rootAbs,
  agentsFiles,
  git,
  gitFacts,
  unregisteredPaths,
  nestedRepositories,
  inputs,
  migrationManifest,
  writeSet,
  conflicts,
  risks,
  legacyExitList,
  legacyReferenceExitList,
  verificationFacts,
  migrationState,
  entries,
}) {
  const fields = [];
  const push = (id, name, status, value) => fields.push({ id, name, status, value });

  // 1. Project identity, absolute path, project-level AGENTS files.
  push(1, HANDOFF_FIELDS[0], "derived", {
    projectId,
    root: rootAbs,
    agentsFiles: agentsFiles ?? [],
  });

  // 2. dirty / untracked / nested-repository state — facts or not-proven,
  // never fabricated.
  push(2, HANDOFF_FIELDS[1], "derived", {
    repository: git.repository,
    headCommit: git.headCommit,
    cleanState: git.cleanState,
    dirty: git.cleanState === false,
    unregisteredContent: git.repository ? null : unregisteredPaths ?? [],
    nestedRepositories: nestedRepositories ?? [],
    trackedButIgnored: gitFacts?.status === "proven" ? gitFacts.trackedButIgnored : null,
    gitFactsStatus: gitFacts?.status ?? "not-proven",
  });

  // 3. Profile plus exact Foundation versions and digests: only the
  // manifest-declared binding counts; an undeclared binding is INCOMPLETE.
  const declaredPackages = Array.isArray(migrationManifest?.foundationPackages)
    ? migrationManifest.foundationPackages
    : null;
  push(3, HANDOFF_FIELDS[2], declaredPackages && declaredPackages.length > 0 ? "derived" : "INCOMPLETE", {
    plannedProfile: inputs.profileId,
    contractsVersion: CONTRACTS_VERSION,
    foundationPackages: declaredPackages,
  });

  // 4. Allowed and forbidden write sets.
  const creates = writeSet.filter((item) => item.action !== "unchanged").map((item) => item.path).sort();
  push(4, HANDOFF_FIELDS[3], "derived", {
    allowed: creates,
    unchanged: writeSet.length - creates.length,
    forbidden:
      "nothing outside the listed write set is ever written; the kit never renames, deletes, rewrites handwritten files, or touches remotes; legacy removal is a human-performed exit step",
  });

  // 5. The validator/builder/docs-pipeline/git-preflight slated for exit.
  //    Includes both whole-file exits (legacyInfra) and reference-level
  //    exits (legacyReferences) for retained files.
  push(5, HANDOFF_FIELDS[4], "derived", {
    exits: legacyExitList.map((item) => ({ path: item.path, replacedBy: item.replacedBy, status: item.status })),
    referenceExits: (legacyReferenceExitList ?? []).map((ref) => ({
      path: ref.path,
      text: ref.text,
      replacedBy: ref.replacedBy,
      status: ref.status,
      occurrenceCount: ref.occurrenceCount,
    })),
  });

  // 6. Business logic that must be kept: never derivable from repo facts.
  push(6, HANDOFF_FIELDS[5], "INCOMPLETE", {
    reason: "business-logic boundaries cannot be derived mechanically; a human owner must enumerate them before any hand-off starts",
  });

  // 7. adopt-plan summary.
  push(7, HANDOFF_FIELDS[6], "derived", {
    writeSetCreates: creates.length,
    writeSetUnchanged: writeSet.length - creates.length,
    conflicts: conflicts.length,
    risks: risks.length,
    migrationState,
  });

  // 8. Unit / integration / consumer / independent-audit entries: derived
  // only when every evidence kind is proven. assessVerificationEvidence
  // always returns one status-bearing fact per kind (undeclared/missing/
  // invalid-path/unreadable/identity-mismatch/proven), so presence alone
  // proves nothing — fail-closed, never guessed (FC-12).
  const evidenceByKind = new Map((verificationFacts ?? []).map((fact) => [fact.kind, fact]));
  const missingEvidence = VERIFICATION_EVIDENCE_KINDS.filter((kind) => evidenceByKind.get(kind)?.status !== "proven");
  push(8, HANDOFF_FIELDS[7], missingEvidence.length === 0 ? "derived" : "INCOMPLETE", {
    entries: (verificationFacts ?? []).map((fact) => ({ kind: fact.kind, path: fact.path ?? null, status: fact.status })),
    missing: missingEvidence,
  });

  // 9. How removed legacy implementations can be recovered: never
  // derivable mechanically (depends on the target's own history/backups).
  push(9, HANDOFF_FIELDS[8], "INCOMPLETE", {
    reason: "recovery paths for removed legacy implementations depend on the target's own history and backups; the kit never guesses them",
  });

  // 10. commit/push/tag/publish authorization: a fixed policy fact —
  // adoption planning authorizes none of them.
  push(10, HANDOFF_FIELDS[9], "derived", {
    commit: false,
    push: false,
    tag: false,
    publish: false,
    note: "adoption authorizes no git write, tag, or release; each requires explicit per-task user authorization",
  });

  const incompleteFields = fields.filter((field) => field.status === "INCOMPLETE").map((field) => field.name);

  // Binding digests: the target file-set summary and the Foundation plan.
  const targetSetDigest = digestBytes(
    Buffer.from(entries.map((entry) => `${entry.path}:${entry.kind}`).sort().join("\n"), "utf8"),
  );
  const foundationPlanDigest = digestBytes(
    Buffer.from(writeSet.map((item) => `${item.path}:${item.action}:${item.sha256}`).sort().join("\n"), "utf8"),
  );

  return {
    kind: "skill-family.handoff-draft",
    schemaVersion: 1,
    fields,
    incompleteFields,
    ready: incompleteFields.length === 0,
    binding: { targetSetDigest, foundationPlanDigest },
  };
}

/**
 * Plans the adoption of the skeleton into root.
 * Options: { root, projectId, projectName, profileId, licensingProfile, licensingProfileData, profilesRoot, allowGitSpawn, now }.
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
  allowGitSpawn = true,
  now = Date.now(),
} = {}) {
  const rootAbs = await resolveTargetRoot(root ?? ".");
  const entries = await listTargetEntries(rootAbs);
  const facts = await loadTargetFacts(rootAbs);
  const git = await probeGitState(rootAbs, { allowSpawn: allowGitSpawn });

  const inputs = normalizeSkeletonInputs({
    projectId,
    projectName,
    profileId,
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
  });

  const existingManagedDeclarations = [...facts.managedSet].sort();

  // The ten-field hand-off draft. Fields that cannot be derived
  // mechanically stay INCOMPLETE and block readiness — never guessed.
  const agentsFiles = entries
    .filter((entry) => entry.kind === "file" && (entry.path === "AGENTS.md" || entry.path === "CLAUDE.md"))
    .map((entry) => entry.path)
    .sort();
  const handoffDraft = buildHandoffDraft({
    projectId: inputs.projectId,
    rootAbs,
    agentsFiles,
    git,
    gitFacts,
    unregisteredPaths,
    nestedRepositories,
    inputs,
    migrationManifest,
    writeSet,
    conflicts,
    risks,
    legacyExitList,
    legacyReferenceExitList,
    verificationFacts,
    migrationState: completion.state,
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
    handoffDraft,
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
