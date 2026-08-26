# Changelog

<!-- release-skill:changelog:start version=0.12.0 locale=en baseline=sha256:6000579dc8b473dbeda1832274d971df0c4f3a62a90c973184dd70e59ffc8602 -->
## [0.12.0] - 2026-08-26

Engineering Kit 0.12.0 extends bounded real-host verification from two to five fixed built-in drivers.

### Added

- Extends runHostVerification with three fixed built-in drivers while retaining the Kimi and WorkBuddy raw-byte behavior.

### Changed

- Uses the classic plugin-root/skills/skill-id layout for the plugin-directory driver and validates complete JSONL event streams before accepting execution.
- Keeps output meaning with consumers and applies strict text decoding only to the three new text-protocol drivers.
- Registers Qoder as manual for host support and descriptor maturity, while its real-host verification capability remains candidate.

### Fixed

- Rejects malformed protocol tails, invalid UTF-8 in text-protocol drivers, and version suffixes outside each driver's fixed format before they can support a successful public result.

### Upgrade Notes

Pin all three Foundation packages to 0.12.0. Existing runHostVerification and verifyHostVerificationBindings entrypoints and request identities remain unchanged. Reuse the host's existing login state; Foundation does not isolate authentication, freeze model identity, disable host tools, or decide domain PASS/FAIL. Qoder verification grants no build, plan, apply, install, update, uninstall, or rollback capability. The executable digest is a preflight observation and member snapshots cover only the declared members at the two observed times.
<!-- release-skill:changelog:end version=0.12.0 locale=en -->


<!-- release-skill:changelog:start version=0.11.0 locale=en baseline=sha256:108e261312b0838af53184710453fe19f369a9ea10ac5d1fc3e829e919d0f99d -->
## [0.11.0] - 2026-08-25

Engineering Kit 0.11.0 adds a candidate real-host verification API and ships the registered host Profile closure.

### Added

- Adds runHostVerification for one fresh, bounded Kimi or WorkBuddy invocation reusing the caller's existing login state, and verifyHostVerificationBindings for pure result composition.
- Recomputes closure and stream digests from raw bytes and keeps private evidence outside the public result.
- Ships the registered host Profile closure through bundledHostProfilesRoot().

### Changed

- Manual Profiles retain their lifecycle restrictions; host verification does not grant build, plan, apply, install, update, uninstall, or rollback support.

### Upgrade Notes

The 0.11.0 host-verification API is candidate-only. It does not own domain PASS/FAIL, release state, or automatic login, and it claims no authentication isolation, unchanged credentials, fixed model identity, or disabled host tool capability. executableSha256 is a point-in-time preflight observation, not proof of the executed image; the caller exclusively controls that namespace. Foundation retains session directories, and the caller cleans its outer temporaryRoot after inspection.
<!-- release-skill:changelog:end version=0.11.0 locale=en -->


<!-- release-skill:changelog:start version=0.10.0 locale=en baseline=sha256:fc575df3b8c5f7a0d819090ce9637f8cdc654c277892fe3f14149d5cc1746b24 -->
## [0.10.0] - 2026-08-24

Engineering Kit 0.10.0 adds responsibility-specific canonical entrypoints, a bounded host lifecycle slice, and a thin read-only peer adapter verification entry.

### Added

- Adds skill-family-engineering-kit/quickstart-profile, /adoption, and /skill-naming canonical exports.
- Adds finite Profile alias resolution, independent manual probe facts for non-driver hosts, and explicit local install/update plans; uninstall remains a manual-recovery refusal.
- Adds `verifyHostPeers` as a thin wrapper over Harness peer verification; the Kit retains four top-level commands and does not write peer directories.

### Changed

- Keeps the historical Quickstart candidate export as a same-source migration alias and preserves the four-command Kit boundary.
- Compiles one canonical Quickstart and batch Schema set while mapping historical and canonical IDs to the same standalone validators.

### Upgrade Notes

Update all three exact pins to 0.10.0 and migrate imports and Schema IDs once to canonical identities. A later maturity-label promotion adds no separate Bundle rebuild requirement; package-identity, source-digest, and provenance changes continue to follow the existing projection contract.
<!-- release-skill:changelog:end version=0.10.0 locale=en -->


<!-- release-skill:changelog:start version=0.9.0 locale=en baseline=sha256:6419bbdc8d469e6dd7f9fda5995e5465cc6bf98724371f9f4aa9293a7e0d9f14 -->
## [0.9.0] - 2026-08-24

Engineering Kit 0.9.0 projects the stable filesystem schemas, bound-read Harness closure, and candidate ordered batch validation into the existing Quickstart Bundle.

### Added

- Projects the three stable filesystem schemas and two candidate batch schemas from Contracts authorities.
- Projects the stable bound-read entry and its exact native prebuild closure without adding a Kit command.

### Changed

- Keeps the four top-level Kit commands and Profile SPI candidate boundary unchanged.

### Upgrade Notes

Pin all three Foundation packages to exactly 0.9.0 and rebuild managed Bundles. Batch validation is available only through the existing candidate Bundle and mechanisms CLI.
<!-- release-skill:changelog:end version=0.9.0 locale=en -->


<!-- release-skill:changelog:start version=0.8.4 locale=en baseline=sha256:0f6ad4e641ae6ef85ea323e458aa6263aa6d87280e704ac1324742f83016d779 -->
## [0.8.4] - 2026-08-24

Lockstep Foundation 0.8.4 update documents validated external source authority without changing Kit commands or Profile SPI.

### Changed

- Moves the package version to 0.8.4 together with Contracts and Harness.
- Documents that consumers validate a source-authority receipt through Contracts before passing the returned coordinates through the existing sourceRepository and sourceBaseCommit fields.
- Keeps the four stable top-level Kit commands, builder, Profile SPI, and public exports unchanged.

### Upgrade Notes

Pin all three Foundation packages to exactly 0.8.4. A provider Profile descriptor upgrading from 0.8.3 and Contracts 1.7.0 must mechanically update its base.contractsVersion field to 1.8.0. Existing functions and Schema shapes, Profile SPI v3, and the four Kit commands require no migration; source-authority consumers only add the Contracts validation step before invoking the existing builder surface.
<!-- release-skill:changelog:end version=0.8.4 locale=en -->


<!-- release-skill:changelog:start version=0.8.3 locale=en baseline=sha256:93875982c9f941309d63e40d5758b0fe7b20d74242f71934c3fd3cd90fe6ba52 -->
## [0.8.3] - 2026-08-23

Lockstep patch release whose managed Bundle carries the bounded Harness containment fix.

### Changed

- Moves the package version to 0.8.3 together with Contracts and Harness; the four stable top-level Kit commands and Profile SPI remain unchanged.
- Rebuilding a managed Bundle projects the updated Harness paths module, including its single ENOENT anchor recomputation and unchanged fail-closed boundaries.

### Upgrade Notes

Consumers must pin Contracts, Harness, and Engineering Kit to exactly 0.8.3 and rebuild the managed Bundle. No Kit API or Profile SPI migration is required.
<!-- release-skill:changelog:end version=0.8.3 locale=en -->


<!-- release-skill:changelog:start version=0.8.2 locale=en baseline=sha256:cebfcfd816f8fd5824135d2681f443e5b226d65096bb6f6a9360f6b3bba34fc1 -->
## [0.8.2] - 2026-08-23

Managed offline Bundles now carry the strict-read source required by the fixed candidate mechanism bridge.

### Added

- Projects strict-read.mjs into the managed Bundle and maps its closure, errors, and paths dependencies to sibling runtime modules.
- Records the real strict-read.mjs source in Foundation provenance and verifies the read-file-strict bridge in an offline runner.

### Changed

- Moves the package version to 0.8.2 together with Contracts and Harness; the four stable top-level Kit commands remain unchanged.

### Upgrade Notes

Consumers must pin Contracts, Harness, and Engineering Kit to exactly 0.8.2 and rebuild the managed Bundle. Existing Bundles do not gain read-file-strict by changing a worktree reference.
<!-- release-skill:changelog:end version=0.8.2 locale=en -->


<!-- release-skill:changelog:start version=0.8.1 locale=en baseline=sha256:e22f9a90f4275671e77a23aeee6ee036ab5c4c5a041a9ed9a144d055ce886da5 -->
## [0.8.1] - 2026-08-22

Engineering Kit now preserves its own package version when a host bundles it into a single-file adapter.

### Changed

- Moves Contracts, Harness, and Engineering Kit together to version 0.8.1; the Contracts 1.7.0 and Profile SPI v3 surfaces remain unchanged.

### Fixed

- Replaces the runtime import.meta.url package-manifest lookup with a static JSON import, so source and installed-package execution still read the Kit manifest while esbuild inlines the same version into a host bundle.
- Adds a regression test that bundles Engineering Kit as a third-party dependency into one host entry file, runs it outside the package tree, and verifies the reported version against the package manifest.

### Upgrade Notes

Host adapters that bundle Engineering Kit must pin 0.8.1. Source and ordinary installed-package consumers keep the existing API and require no migration.
<!-- release-skill:changelog:end version=0.8.1 locale=en -->


<!-- release-skill:changelog:start version=0.8.0 locale=en baseline=sha256:47377b52339e57d0087ffdff72ba04f88d8dd290f5a6e472fc67eb9a801007db -->
## [0.8.0] - 2026-08-21

Profile SPI v3 adds direct verification for scaffolded Project Profiles while descriptor verification remains stable.

### Added

- Adds verifyProjectProfile({ projectRoot, profileRelPath? }) for skill-family.project-profile declarations.
- Keeps verifyProfile descriptor-only and reuses Contracts-owned adoption and overrides field definitions.
- Adds SPE1008 PROJECT_PROFILE_INVALID; SPE1006 and SPE1007 retain their existing meanings.

### Upgrade Notes

Project-root consumers must pin engineering-kit 0.8.0 and call verifyProjectProfile. Descriptor consumers continue to call verifyProfile; 0.7.0 remains available.
<!-- release-skill:changelog:end version=0.8.0 locale=en -->


<!-- release-skill:changelog:start version=0.7.0 locale=en baseline=sha256:ed1c59e7cee6e7280d2569e554b07d3b3513f4f3318bf30e374e2d480320f2b7 -->
## [0.7.0] - 2026-08-21

This release exports the public canonical projection closure builder buildProjectionClosure (FG-4), so callers construct compileProjectionPlan-ready plan closures through one public entry instead of re-implementing the Kit-private ordering, serialization, and digest algorithms.

### Added

- Adds the public skill-family-engineering-kit/profile-spi subpath. It projects the three Profile SPI JSON resources together with the Contracts canonical profile-descriptor.schema.json, and exports schema loaders, verifyProfile, adoption-pin verification, and tightening-only override checks. The data-only verifier fails closed on missing pins and symlink/path escapes and never executes Profile entrypoints.
- Adds buildProjectionClosure - a pure public builder accepting an array of {path, sha256, mode} members (an explicit type file is also accepted) and returning the canonical plan closure {digestAlgorithm sha256, digest, resourceCount, resources} that compileProjectionPlan accepts verbatim as previousOwnedClosure or externalCandidateClosure; an empty array yields the legal empty closure.
- The builder shares one normalization and digest source of truth with the compiler closure re-verification - deterministic path.localeCompare ordering, duplicate-path and portable-collision refusal, and the sha256(JSON.stringify(normalizedResources)) byte contract; every refusal fails closed in the existing projection plan input invalid domain (SFC2004 invalid-manifest).

### Changed

- Keeps the compileProjectionPlan input contract unchanged and the four top-level commands (scaffold, adopt-plan, projection, check) unchanged; every 0.6.0 input still compiles to byte-identical plans. The package version moves in lockstep with the Foundation line while the contracts machine contract stays at 1.6.0.

### Upgrade Notes

Version 0.7.0 is the projection closure builder line. Callers that previously assembled plan closures locally must import buildProjectionClosure and pin exactly 0.7.0. A plan closure ({path, type, sha256, mode} members) is not the harness computeResourceClosure resource closure ({path, role, exists, sha256} members) - the two shapes and purposes differ and are not interchangeable.
<!-- release-skill:changelog:end version=0.7.0 locale=en -->


<!-- release-skill:changelog:start version=0.6.0 locale=en baseline=sha256:e84a44b51d513c123ce3c5e91c9e50374c6e899aa021adabe8e44c3ad86eb2b2 -->
## [0.6.0] - 2026-08-21

This release extends the check command with the entry contract gate and the controlled relock transaction sub-actions, adds external frozen authority projection bindings (FG-3), and carries the nine-class check diagnostics (audit remediation C2).

### Added

- Adds the check entries sub-action - runEntryContractCheck and checkEntriesAction run the shared entry contract gate (SFA-ENTRY-003/004/005/007 and SFA-CONTEXT-001/002) over skill-family.entry-contract.json and SKILL.md bytes; diagnosis only, zero writes.
- Adds the check relock sub-action - runRelock and relockAction are the one controlled exception to the no-write rule - a fail-closed transaction writing exactly the two contained state documents (.foundation/file-registry.json and skill-family.managed-file-lock.json), with drift validation before the first write and zero writes on any refusal.
- Adds external frozen authority projection bindings (FG-3) - PROJECTION_AUTHORITY_BINDING_KINDS freezes external-root and caller-bytes; external-root re-reads each authority source from a separate frozen directory through the strict no-follow reader, and caller-bytes binds caller-provided base64 authority bytes to declared sha256 digests with no authority filesystem access at all, keeping the target root free of forged local authority facts.

### Changed

- Extends check diagnostics to nine classes (adds version single-source consistency, public boundary validation, and platform subset declaration validation); COMMAND_SIDE_EFFECTS now documents the entries and relock sub-action semantics.
- Keeps the four top-level commands (scaffold, adopt-plan, projection, check) unchanged; entries and relock are check sub-actions, not new commands.

### Upgrade Notes

Version 0.6.0 is the Kit gate completion line. Projections whose authority does not live in the target root must declare an authorityBinding of kind external-root or caller-bytes and pin exactly 0.6.0.
<!-- release-skill:changelog:end version=0.6.0 locale=en -->


<!-- release-skill:changelog:start version=0.5.0 locale=en baseline=sha256:f83b9c3442e5391149531b198be25131cf45728ff945d4ffc531342996e4e6f3 -->
## [0.5.0] - 2026-08-16

This release keeps the stable four-command Kit surface unchanged and strengthens the offline-consumer verification gates to cover the complete third-party production closure of the three Foundation packages.

### Added

- Strengthens the offline-consumer verification gates: the third-party closure derivation in candidate-profile-bundle and tarball-source-binding tests is extended from a single-package closure to the complete production closure of the three Foundation packages (identity-deduplicated, npm: alias-aware, range-scoped override selectors, byte identity against the real store directory of pnpm), so the harness runtime-dependency review decision (FND-ADR-011) is continuously verified against the real installed bytes.

### Changed

- Keeps the stable scaffold, adopt-plan, projection, and check commands unchanged.
- Carries forward the 0.4.0 adoption CLI candidate and the Quickstart Profile v2 offline bundle; no Kit surface or candidate entry point is added or removed in 0.5.0.

### Upgrade Notes

Version 0.5.0 is released on npm and the public mirror. The Kit public surface is unchanged from 0.4.0; pin the package to exactly 0.5.0 for the new contract-spec 1.5.0 line.
<!-- release-skill:changelog:end version=0.5.0 locale=en -->


<!-- release-skill:changelog:start version=0.4.0 locale=en baseline=sha256:b75bcca6a62cddc63d0a8d88faf268415aec803bcf00e04aacd797907d1ea6e8 -->
## [0.4.0] - 2026-08-16

This release adds the candidate adoption CLI and adoption mechanisms to the Engineering Kit while preserving the stable four-command surface and the 0.3.0 offline bundle.

### Added

- Adds the adoption-cli candidate, a stdin/stdout CLI that assesses adoption bindings, legacy exit lists, and legacy references through the migration manifest, and verifies managed-bundle identity and harness surface inventory.
- Adds the adoption-mechanisms candidate module as the shared implementation behind the adoption CLI.

### Changed

- Keeps the stable scaffold, adopt-plan, projection, and check commands unchanged.
- Carries forward the 0.3.0 Quickstart Profile v2 offline bundle (standalone validators selected by schema $id, full provenance recording) and the candidate plugin skill naming checker.

### Upgrade Notes

Version 0.4.0 is released on npm and the public mirror. The adoption CLI is a candidate entry point; invoke it through its explicit candidate subpath and pin the package to exactly 0.4.0.
<!-- release-skill:changelog:end version=0.4.0 locale=en -->


<!-- release-skill:changelog:start version=0.3.0 locale=en baseline=sha256:4c017d6121ff888f90ad9a4ef958b4fee3e25c8d1b69be61cc1ba1f79d527163 -->
## [0.3.0] - 2026-08-12

This source candidate builds a deterministic Quickstart Profile v2 bundle that runs offline without Foundation packages, node_modules, or runtime Ajv.

### Added

- Accepts explicit consumer schema files and source identity, then generates standalone validators selected by schema $id.
- Records complete source and payload provenance, package-manager identity, and the licenses for third-party code that enters the bundle.
- Adds a candidate plugin skill naming checker (policy JSON plus build-time CLI) that scans a plugin skills root and reports per-rule PASS/FAIL for the prefixed-name, description-signal, and routing-scope rules.

### Changed

- Replaces the incompatible 0.2.1 dependency-closure bundle; consumers that still require v1 must remain pinned to exactly 0.2.1.
- Projects the Contracts and Harness runtime mechanically while preserving the stable four-command Kit surface.

### Upgrade Notes

Version 0.3.0 is a local, unpublished source candidate. Regenerate managed bundles from frozen inputs and pin the builder to exactly 0.3.0 when adopting v2.
<!-- release-skill:changelog:end version=0.3.0 locale=en -->


<!-- release-skill:changelog:start version=0.2.1 locale=en baseline=sha256:3457c97a9a2f25fd233a1947dcd9c88fb40279e90ae5b437bea1f7660ac6ce60 -->
## [0.2.1] - 2026-08-10

This release adds a candidate Quickstart Profile projection bundle while preserving the Kit's four-command boundary and adds bilingual package release documentation.

### Added

- Adds a candidate builder and CLI for a deterministic, self-contained Quickstart Profile projection bundle with source-closure and bundle digests.
- Adds complete English and Simplified Chinese package documentation, including an agent quick-reference section.

### Changed

- Manages the current README and CHANGELOG release sections from one bilingual, versioned notes source.
- Distributes the project NOTICE separately from the existing third-party notices and license closure.

### Upgrade Notes

The candidate bundle remains under the existing projection authorization boundary. It does not add a fifth top-level Kit command or replace THIRD_PARTY_NOTICES.
<!-- release-skill:changelog:end version=0.2.1 locale=en -->
