# Changelog

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
