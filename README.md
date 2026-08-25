<!-- release-skill:safe-first-command -->
<!-- release-skill:external-write-boundary -->
> 简体中文版：[README.zh-CN.md](./README.zh-CN.md)

# skill-family-engineering-kit

<!-- release-skill:release-version: 0.11.0 -->

An engineering toolkit used in development and CI. There are **exactly four** top-level commands, and no fifth:

<!-- release-skill:managed:start id=latest-release -->
**0.11.0** (2026-08-25)

Engineering Kit 0.11.0 adds a candidate real-host verification API and ships the registered host Profile closure.

**Added**

- Adds runHostVerification for one fresh, bounded Kimi or WorkBuddy invocation reusing the caller's existing login state, and verifyHostVerificationBindings for pure result composition.
- Recomputes closure and stream digests from raw bytes and keeps private evidence outside the public result.
- Ships the registered host Profile closure through bundledHostProfilesRoot().

**Changed**

- Manual Profiles retain their lifecycle restrictions; host verification does not grant build, plan, apply, install, update, uninstall, or rollback support.

**Upgrade Notes**

The 0.11.0 host-verification API is candidate-only. It does not own domain PASS/FAIL, release state, or automatic login, and it claims no authentication isolation, unchanged credentials, fixed model identity, or disabled host tool capability. executableSha256 is a point-in-time preflight observation, not proof of the executed image; the caller exclusively controls that namespace. Foundation retains session directories, and the caller cleans its outer temporaryRoot after inspection.
<!-- release-skill:managed:end id=latest-release -->

| Command | Purpose | Side effects |
| --- | --- | --- |
| `scaffold` | Generate a Skill Family project skeleton in an empty directory | Only writes skeleton files to the empty target directory (atomic write, path containment); non-empty or conflicting targets are rejected and not touched |
| `adopt-plan` | Strictly read-only planning of adopting an existing repo | None — writes no files (including temp files), runs no git write commands; plan output goes to stdout |
| `projection` | Project managed artifacts | Only writes paths authorized by manifest and declared managed by the target; unauthorized, hand-written, and out-of-bounds paths are all rejected (zero writes on rejection) |
| `check` | Contract/drift/closure/version/doc-fact/Git-precondition diagnostics | None — only diagnoses, never auto-fixes; git is read-only probe only |

## Problem It Solves

The engineering stage often carries two kinds of risk: either each skeleton generates its own copy and each projection writes its own copy, causing structural drift; or diagnostic tools conveniently "auto-fix", silently mutating the caller's repo. Kit consolidates engineering actions into four read-only or restricted-write commands, making "generate, inventory, project, diagnose" reproducible, auditable, and never auto-modifying across boundaries.

## Core Mental Model

Kit is the "engineering stage" layer, depending on the Harness and Contracts. It does only four things: generate a precise skeleton for a new project, perform a read-only adoption inventory of an existing repo, mechanically project managed facts to a target, and perform read-only diagnostics on engineering inconsistencies. `report` and `host` are sub-actions hanging under the four commands and do not change the "four-command" boundary. All write actions go through the Harness's atomic contained write, leaving no half-written artifact on failure.

## Installation and Minimal Example

```sh
npm install --save-dev skill-family-engineering-kit@0.11.0
npm exec -- skill-family-kit --help
npm exec -- skill-family-kit scaffold --root <empty-dir> --project-id my-project
npm exec -- skill-family-kit adopt-plan --root <repo>
npm exec -- skill-family-kit projection --root <repo>
npm exec -- skill-family-kit check --root <repo>
```

The four commands above cover skeleton generation, read-only inventory, managed projection, and diagnostics respectively; a zero-install form is available via `npm exec --package=skill-family-engineering-kit@0.11.0 -- skill-family-kit --help`.

### Public Profile SPI

The `skill-family-engineering-kit/profile-spi` subpath exposes the stable Profile SPI v3 data surface. It exports `verifyProfile`, `verifyProjectProfile`, `verifyAdoptionDigests`, `assessOverridesPolicy`, `loadSpiDefinition`, `loadExtendedDescriptorSchema`, `loadProjectProfileSchema`, and `loadRuleBaselineCatalog`. Contracts `profile-adoption-declaration` owns the adoption and overrides field shapes; the SPI `profile-adoption.schema.json` path remains only as a compatibility forwarding path.

The package carries three SPI JSON resources and the Contracts canonical `profile-descriptor.schema.json`. `profiles/spi` is the only handwritten source; projen mechanically projects those resources and the module into this subpath. The projection changes only the two public package imports and the local schema URL.

`verifyProfile({ profileRoot })` is read-only and data-only for Profile descriptors. `verifyProjectProfile({ projectRoot, profileRelPath? })` is the corresponding entry for a project root declaration. Both refuse invalid input with stable result codes, never execute Profile-provided files, and leave Profile domain meaning to the caller.

When a provider Profile descriptor moves from Foundation 0.9.0 and Contracts 1.9.0 to Foundation 0.10.0, update its `base.contractsVersion` field mechanically to `1.10.0`. The four Kit commands and Profile SPI retain their existing shapes.

### Report sub-action

```sh
npm exec -- skill-family-kit projection report --root <repo> --model <report-model.json> --result <operation-result.json> --out <report.md> --binding <binding.json>
npm exec -- skill-family-kit check report --root <repo> --report <report.md> --model <report-model.json> --result <operation-result.json> --binding <binding.json>
```

The caller must first construct a valid report model; Kit does not derive facts from open business `outputs`. All fact text is escaped literally, and the full errors of a failed result must appear in both the model and the neutral report.

### Candidate Quickstart projection bundle

Use the candidate subpath to build a deterministic Quickstart Profile v2 projection from explicit consumer schemas and frozen source identity:

```js
import { parseSourceAuthorityReceipt } from "skill-family-contracts";
import {
  buildQuickstartProfileProjection,
  QUICKSTART_PROFILE_TARGET_PREFIX,
} from "skill-family-engineering-kit/quickstart-profile";

const authority = parseSourceAuthorityReceipt(receipt, actualSubjects);
if (!authority.valid) throw new Error(authority.errorCode);

const projection = await buildQuickstartProfileProjection({
  ...projectionInputs,
  ...authority.data,
});
```

The caller obtains `receipt` and `actualSubjects` outside Kit. Contracts validates their exact binding before the existing builder receives `sourceRepository` and `sourceBaseCommit`; Kit does not parse release plans or discover source authority. The generated Bundle selects standalone validators by schema `$id` and runs offline without Foundation packages, `node_modules`, or runtime Ajv. Its provenance binds Foundation sources, consumer schemas, payload bytes, tool versions, and the licenses of code that actually enters the Bundle.

Pass the returned `manifest` to the stable `runProjection` API; the helper does not write files or add a fifth top-level command. The capability remains **candidate**, so pin all three packages exactly. Version 0.10.0 adds the canonical path above; the historical `/candidate/quickstart-profile` path remains a same-source migration alias. Adoption and skill naming now also have the canonical `skill-family-engineering-kit/adoption` and `skill-family-engineering-kit/skill-naming` paths. A later stable promotion will not require a second migration. Integrations that still require the v1 dependency-closure Bundle must stay pinned to exactly `0.2.1`.

### Host sub-action

```sh
npm exec -- skill-family-kit adopt-plan host-describe --host <id> --hosts-root <dir>
npm exec -- skill-family-kit adopt-plan host-probe --host <id> --hosts-root <dir>
npm exec -- skill-family-kit scaffold host-build --root <workspace> --host <id> --path-category <id> --input <relpath> --out <relpath> --hosts-root <dir>
npm exec -- skill-family-kit adopt-plan host-plan --root <workspace> --host <id> --path-category <id> --build-manifest <relpath> --probe-facts <relpath> --hosts-root <dir>
```

The Profile must be provided explicitly; Kit does not bind a specific host by default. Canonical host IDs may resolve only aliases declared by the finite registered Profile set. Probe starts no process by default; only when both `--allow-host-spawn --host-executable <absolute-path>` are given is the frozen version vector executed. Local install and update use an explicit authorization reference plus the existing contained publication primitives; uninstall is rejected with `manual-recovery-required` because Foundation has no safe bound deletion primitive. Two registered hosts have trusted version drivers; Kimi Code, WorkBuddy, CodeBuddy, and DeepSeek Harness expose independent manual facts; Qoder is `unsupported`. Adapter source only accepts declared text closures; binary projection is not supported; see the [host capability matrix](../../docs/reference/host-capability-matrix.md) and registered Profiles.

### Candidate real-host verification library API

`runHostVerification({ request, bindings, hostsRoot })` and `verifyHostVerificationBindings({ results, expectedCommon, expectedRequestDigestByHost })` are library APIs, not a fifth Kit command. The first runs one bounded candidate verification against caller-bound roots using an admitted built-in driver (`kimi-code-print-v1` or `workbuddy-codebuddy-print-v1`, both bound to `existing-user-state + host-managed`) and returns a Contracts-validated, redacted four-state result. The second is pure and combines only `observed` results with the exact common fields and per-host request digest expected by the caller.

The API keeps consumer workload, domain output checks, domain PASS/FAIL, release freshness, and release state outside Foundation. The caller supplies a canonical `existingUserStateRoot` that is projected into the child environment but never read, digested, modified or cleaned by Foundation; it does not grant manual Profiles any build, plan, apply, install, update, or uninstall capability. The Kimi and WorkBuddy real-host publication gates remain a hard publication requirement for 0.11.0.

`executableSha256` binds only the bytes observed by the strict preflight read; the actual process is still spawned by pathname, so the caller must exclusively control the executable namespace through probe and invocation. Foundation retains the call's `session-*` directory and never deletes it by pathname. After inspection, the caller cleans its exclusively owned outer `temporaryRoot`.

## Typical Use Cases

- New project skeleton: `scaffold` (does not overwrite a non-empty existing repo).
- Existing-repo adoption inventory: `adopt-plan` (strictly read-only, no file writes, no auto-migration).
- Managed projection: `projection` + Profile (does not overwrite handwritten files).
- Engineering diagnostics: `check` (diagnosis only, no fix, `--only` narrows scope).

## Boundary Mechanisms

- `scaffold`'s target must be an **empty directory** (any entry including dotfiles counts as non-empty), or a non-existent path whose parent directory exists (only the last level is created). All writes go through the harness's atomic contained write (`writeFileAtomic`), leaving no half-written artifact on failure, and paths cannot escape the target root.
- `adopt-plan` is structurally read-only: there is no write call in the implementation, not even a temp file; the plan bytes share the same source as `scaffold` (single source of truth `describeSkeletonFiles`), hence "the plan is the action". A dirty repo has zero byte-level change before and after running.
- `projection` uses two-phase execution: first, for each entry, it performs path classification, containment pre-check, self-projection check, manifest authorization check, hand-written protection, and conflict guard; if any entry violates, the whole is rejected with zero writes. Overwriting an existing file must declare the precise `expect.sha256` precondition; an existing file with identical content is an idempotent no-op. On write failure it best-effort restores the pre-write bytes of already-overwritten files.
- `check` is diagnosis only: no write calls, no `--fix/--apply/--repair` modes (such flags are rejected at the entry point). Git precondition state uses only filesystem facts plus at most one read-only `git status --porcelain=2` with a frozen parameter vector (`--no-optional-locks` + `GIT_OPTIONAL_LOCKS=0`, no index refresh).

## Error Codes and Exit Codes

Error codes reuse the contracts frozen SFC\* system; no new codes are added:

- `SFC2002` (UNKNOWN_OPERATION) — the entry receives a command name outside the four-command vocabulary;
- `SFC2003` (INVALID_PARAMS) — option/argument value violation, or requesting a non-existent mutation mode like `--fix`;
- `SFC2004` (EXECUTION_FAILED) — runtime failure, with `details.kind` as a stable kit-level kind (e.g., `target-not-empty`, `unauthorized-path`, `handwritten-overwrite`, `conflict-drift`); containment kinds thrown by the harness (`path-traversal`, `symlink-escape`, etc.) pass through unchanged;
- `SFC1001` (SCHEMA_VALIDATION_FAILED) — a contract document found by `check` failed the registered Schema.

Process exit codes: `0` success / no findings; `1` check has findings; `2` rejection / usage / mechanism error.

## Target Workspace Document Conventions

- `skill-family.project-manifest.json` — the contracts project-manifest instance (project identity and managedFiles declaration);
- `skill-family.managed-file-lock.json` — the contracts managed-file-lock instance (managed path and content-hash lock);
- `skill-family.projection.json` — the projection authorization manifest (kit-level document).

`projection` only writes paths that satisfy both conditions: listed by the manifest, and declared managed by the target's own registry (file-registry / project-manifest managedFiles / managed-file-lock). Paths matching hand-written patterns are never written, even if a managed declaration exists, they are rejected.

## Prohibited Items

This package must not perform git init, commit, push, tag, stash, branch switch, publish, delete, remote write, or publish-state recital; it does not implement a fifth top-level command; it does no business judgments, model calls, or remote networking.

## Troubleshooting

`check`'s exit code 1 means findings, exit code 2 means usage or mechanism error. If it fails, confirm the target repo exists and `skill-family.project-manifest.json` is well-formed; when path overrun or hand-written protection triggers, the command rejects the write and reports `SFC2004`.

## Further Documentation

- Architecture boundaries and routing: [Architecture](https://ifoohoo.github.io/skill-family-engineering-kit/architecture/), [Agent architecture routing](https://ifoohoo.github.io/skill-family-engineering-kit/agents/architecture-routing/)
- Capability catalog: [capability-catalog.json](https://ifoohoo.github.io/skill-family-engineering-kit/agents/capability-catalog.json)
- Adoption and migration: [Migration guide](https://ifoohoo.github.io/skill-family-engineering-kit/migration/)
- Side-effect matrix: [Failure and side-effect matrix](https://ifoohoo.github.io/skill-family-engineering-kit/reference/failure-and-side-effect-matrix/)

<!-- agent-quick-reference:start -->
## Agent Quick Reference

### Use when

- You need to generate a new project skeleton, perform a read-only adoption inventory of an existing repo, managed projection, or engineering diagnostics.
- You need to produce report text from a rendered model, or perform tiered checks on a report.
- You need a deterministic, self-contained projection manifest for an exact-version Quickstart candidate trial.

### Do not use when

- You need auto-fix (`check` does not fix), or auto-migration (`adopt-plan` writes no files).
- You need remote host publication, automatic trust confirmation, uninstall deletion, or a full Qoder driver (explicitly unsupported).
- You need a stable Quickstart API or expect the candidate helper to bypass `runProjection` authorization.

### Capability selection

- `foundation.kit.scaffold`: generate a precise skeleton in an empty directory, atomic + contained.
- `foundation.kit.adopt-plan`: strictly read-only inventory and completion determination of an existing repo.
- `foundation.kit.projection`: managed projection, write only after full validation, zero writes on failure.
- `foundation.kit.check`: nine check classes, diagnosis only, no fix.
- `foundation.kit.report`: projection/check report sub-action orchestration.
- `foundation.kit.git-probe`: read-only whitelisted Git status probe.
- `foundation.kit.host`: describe/build/probe/plan plus authorized, digest-bound local install/update through `applyHostPlan`; Kit CLI apply, generic or remote apply, and deleting uninstall remain rejected.
- `verifyHostPeers` is a thin read-only host entry over Harness peer adapter verification; it does not write peer directories or add a fifth command.
- `foundation.kit.licensing`: Profile authorization-data loading and generation.
- `foundation.kit.identity-check`: identity-drift and Profile-consistency checks.
- `foundation.kit.cli`: four-command dispatch and mutation-flag entry rejection.
- `foundation.kit.quickstart-profile-candidate`: exact-version deterministic Quickstart projection-manifest bundle.

### Required inputs

- Target root (scaffold needs an empty directory; adopt-plan/projection/check need an accessible repo).
- Profile identifier (host sub-action must be provided explicitly).

### Outputs and evidence

- Skeleton files, adoption classification / completion determination, projected files, findings list, report text.
- Evidence: `packages/skill-family-engineering-kit/test/scaffold.test.mjs`, `adopt-plan.test.mjs`, `projection.test.mjs`, `check.test.mjs`, `host.test.mjs`, `git-probe.test.mjs`.

### Side effects

- scaffold/projection/host-build write files to the contained target (atomic + contained).
- adopt-plan and check are strictly read-only; git is read-only whitelisted probe only.
- `FORBIDDEN_SIDE_EFFECTS` includes git-init/commit/push/tag, publish, remote-write.

### Failure semantics

- Stable error codes such as `SFC2002/2003/2004/1001`; exit codes 0/1/2.
- check findings exit code 1, mechanism/usage error exit code 2.

### Architectural invariants

- The top-level commands are fixed at 4, not expanded; `REFUSED_MUTATION_FLAGS` is rejected at the CLI entry.
- Diagnosis only, no fix; projection only, no overwrite of handwritten.

### Route elsewhere when

- Remote publish: route to release-skill.
- remote host publication, automatic trust confirmation, and uninstall deletion: explicitly unsupported; local install/update are limited to the registered plan API.
- Business state machine / migration execution: stays with the caller or a later version.

### Machine-readable sources

- Public capability catalog: [`capability-catalog.json`](https://ifoohoo.github.io/skill-family-engineering-kit/agents/capability-catalog.json) (`foundation.kit.*` entries).
- Package-local source: `src/*.mjs`.
- Package-local candidate source: `candidate/*`; canonical public imports: `skill-family-engineering-kit/quickstart-profile`, `/adoption`, and `/skill-naming`; historical migration alias: `skill-family-engineering-kit/candidate/quickstart-profile`.
<!-- agent-quick-reference:end -->
