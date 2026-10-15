<!-- release-skill:safe-first-command -->
<!-- release-skill:external-write-boundary -->
> 简体中文版：[README.zh-CN.md](./README.zh-CN.md)

# skill-family-engineering-kit

<!-- release-skill:release-version: 0.25.0 -->

An engineering toolkit used in development and CI. There are **exactly four** top-level commands, and no fifth:

<!-- release-skill:managed:start id=latest-release -->
**0.25.0** (2026-10-15)

Engineering Kit 0.25.0 adds the public function `runHostLoadingCheck` and the CLI sub-action `skill-family-kit check host-loading` under the existing `check` command. The four top-level commands remain `scaffold`, `adopt-plan`, `projection`, and `check`. The check covers only Codex CLI 0.154.0 project `.agents/skills`. Unknown coverage returns exit code 2. A static result does not prove install, session selection, or business execution.

**Changed**

- Add the public function `runHostLoadingCheck` and the CLI `skill-family-kit check host-loading`. The API `root` must be an absolute project working directory; the CLI resolves the current directory or a relative path to an absolute path first.
- Only `hostId=codex`, `hostVersion=0.154.0`, and `pathCategory=codex-project-skills` are calibrated, and that category's relative path must remain `.agents/skills`. The check statically reads `SKILL.md` and the optional Codex 0.154.0 skill metadata YAML under `agents/` beside `SKILL.md`. It does not start a host, model, hook, or script, and writes nothing.
- Other hosts or versions, or an unknown path category, return exit code 2. A missing skill entry, or a scope that contains only product-filtered targets, returns 1. A static pass does not prove real install, session selection, or business execution.
- The package moves to 0.25.0 with the other three units. Contracts specification remains 1.20.0. Published 0.24.1 capabilities are unchanged and are not redone.

**Upgrade Notes**

Pin the three Foundation npm packages to exactly 0.25.0 and keep the independent Plugin at that release version. Contracts specification 1.20.0 remains a separate coordinate from npm package versions. Consume the actual published version's public interfaces and sources. A static check pass does not prove real install, session selection, or business execution. This note does not replace post-publish verification.
<!-- release-skill:managed:end id=latest-release -->

## Governance Check (0.22.0)

Version 0.22.0 adds an explicit `declared` policy under the existing `check` command. Version
checking reads only the release units and text or JSON version references listed in
`skill-family.project-manifest.json`; entry checking reads only the listed physical files. Neither branch
runs target scripts, Skills, hooks, models, or unselected legacy checks.

`runChecks` and `runEntryContractCheck` remain read-only. Only the existing `runCommand("check")` and
`checkEntriesAction` wrappers may create one `professional-conclusion` file, and only when the caller
provides both an existing output root and a contained relative path. The write is exclusive: parent
directories are not created and existing entries are not overwritten. This implementation ships with the
0.22.0 artifact; the earlier published 0.21.0 artifact does not contain it.

### Foundation 0.15.0 candidate qualification entries

The candidate adds two fixed qualification entries: `foundation.kit.plugin-verification` accepts the Qoder and WorkBuddy native-lifecycle branches, and `foundation.kit.skill-family-directory-verification` accepts the Kimi branch. Qoder and WorkBuddy each use a dedicated production driver with its own argv plan and the same twelve ordered semantic stages; executable identity is re-observed before every spawn. Contracts validates only the closed stage structure, order, and stop propagation.

`runSkillFamilyDirectoryVerification({ request, bindings })` owns the local Kimi process path. It fixes `-p <prompt> --output-format stream-json --skills-dir <family-root>`, projects a narrow environment, and captures raw output under private evidence. Caller observations are rejected. Because no official typed observation mapping is available, current results remain `indeterminate` with `official-observation-unavailable`, even when a controlled fixture stream proves parser wiring.

Consumers bind the executable, directories, source, workload, and domain facts; Kit launches the bounded local process. They must not copy a generic runner, walker, native addon, schema, registry, oracle, cache, state machine, or receipt chain. Controlled fixture protocols are Foundation-owned isolation evidence, not Qoder, WorkBuddy, or Kimi vendor grammar and not real-host qualification. A stable isolated tree is sufficient for Harness record mode; its best-effort boundary does not promise a transaction snapshot, hostile same-UID concurrency, or ABA safety.

Foundation itself does not issue network requests, but a bound executable may access the network. Foundation provides no sandbox or egress blocking; callers and the execution environment own that isolation. Qoder, WorkBuddy, and Kimi remain `manual/candidate`, and controlled fixtures do not grant real-host qualification.

| Command | Purpose | Side effects |
| --- | --- | --- |
| `scaffold` | Generate a Skill Family project skeleton in an empty directory | Only writes skeleton files to the empty target directory (atomic write, path containment); non-empty or conflicting targets are rejected and not touched |
| `adopt-plan` | Strictly read-only planning of adopting an existing repo | None — writes no files (including temp files); by default it may spawn one frozen read-only Git status probe; `--no-git-spawn` disables it; no Git write commands; plan output goes to stdout |
| `projection` | Project managed artifacts | Only writes paths authorized by manifest and declared managed by the target; unauthorized, hand-written, and out-of-bounds paths are all rejected (zero writes on rejection) |
| `check` | Contract/drift/closure/version/doc-fact/Git-precondition diagnostics | Ordinary diagnostics are read-only and write no files; by default they may spawn one frozen read-only Git status probe; `--no-git-spawn` disables it; `check relock` is an explicit controlled write transaction; `check qualification` may spawn a bound executable after preflight. Foundation itself does not issue network requests, but that process may access the network. |

## Problem It Solves

The engineering stage often carries two kinds of risk: either each skeleton generates its own copy and each projection writes its own copy, causing structural drift; or diagnostic tools conveniently "auto-fix", silently mutating the caller's repo. Kit consolidates engineering actions into four read-only or restricted-write commands, making "generate, inventory, project, diagnose" reproducible, auditable, and never auto-modifying across boundaries.

## Core Mental Model

Kit is the "engineering stage" layer, depending on the Harness and Contracts. It does only four things: generate a precise skeleton for a new project, perform a read-only adoption inventory of an existing repo, mechanically project managed facts to a target, and perform read-only diagnostics on engineering inconsistencies. `report` and `host` are sub-actions hanging under the four commands and do not change the "four-command" boundary. All write actions go through the Harness's atomic contained write, leaving no half-written artifact on failure.

## Installation and Minimal Example

This package version is 0.25.0; version 0.24.1 has been formally published. To verify a working tree before formal publication, build all three tarballs into one temporary directory and install those exact files:

```sh
pack_dir="$(mktemp -d)"
(cd packages/skill-family-contracts && pnpm pack --pack-destination "$pack_dir")
(cd packages/skill-family-harness-node && pnpm pack --pack-destination "$pack_dir")
(cd packages/skill-family-engineering-kit && pnpm pack --pack-destination "$pack_dir")
mkdir "$pack_dir/consumer" && (cd "$pack_dir/consumer" && npm init -y)
(cd "$pack_dir/consumer" && npm install "$pack_dir/skill-family-contracts-0.25.0.tgz" "$pack_dir/skill-family-harness-node-0.25.0.tgz" "$pack_dir/skill-family-engineering-kit-0.25.0.tgz")
```

The registry installation below requires exact version 0.25.0 to be formally available:

```sh
npm install --save-dev skill-family-engineering-kit@0.25.0
npm exec --package=skill-family-engineering-kit@0.25.0 -- skill-family-kit --help
npm exec --package=skill-family-engineering-kit@0.25.0 -- skill-family-kit scaffold --root <empty-dir> --project-id my-project
npm exec --package=skill-family-engineering-kit@0.25.0 -- skill-family-kit adopt-plan --root <repo> --list-capabilities --all --scope all --locale en --uses ./uses.json
npm exec --package=skill-family-engineering-kit@0.25.0 -- skill-family-kit projection --root <repo>
npm exec --package=skill-family-engineering-kit@0.25.0 -- skill-family-kit check --root <repo>
```

The four commands above cover skeleton generation, read-only inventory, managed projection, and diagnostics respectively; a zero-install form is available via `npm exec --package=skill-family-engineering-kit@0.25.0 -- skill-family-kit --help`.

### Engineering declarations (available since 0.24.0)

The optional `engineering` input has been available since `0.24.0`; `0.23.0` does not support it. Use the already selected SDK only after confirming its actual public interfaces and exact lockstep source for all three Foundation packages; candidate verification and post-release adoption are separate facts. Omitting the input preserves existing bytes and paths. `null`, `{}`, unknown fields, and invalid references are rejected.

Construct `engineering` from the project's actual business entries and release units. Each `entries` member has `name`, `form`, and `physicalRef`; `form` is either `skill_md` or `file`, and `skill_md` must point to `SKILL.md`. Each `releaseUnits` member has `id` and `versionSource`, with optional `versionMirrors`. A text version reference has `path` and `format: "text"`; a JSON reference has `path`, `format: "json"`, and a non-empty `jsonPointer`. Use actual business version sources, not the private skeleton example package, SDK version, or Profile version. The presence of `package.json` does not establish npm distribution. No separate declaration input file is required.

The variables below are supplied by the caller; `engineering` is the complete confirmed declaration, rather than a default example answer:

```js
import { describeSkeletonFiles, scaffoldTarget, planAdoption, runProjection } from "skill-family-engineering-kit";

const skeleton = await describeSkeletonFiles({ ...inputs, engineering });
const generated = await scaffoldTarget({ ...options, engineering });
const plan = await planAdoption({ ...options, engineering, allowGitSpawn: false });
const updated = await runProjection({ root: targetRoot, engineering });
```

These operations are independent; they do not form a sequence to run on one target. Use `scaffoldTarget` for an empty target. It generates the declaration and its manifest hash using the same skeleton generator and existing managed lock. It validates the contract and contained path shape but does not verify that referenced files exist or write domain content. References may point to files the business author will create later. Use `planAdoption` to analyze an existing non-empty project without modifying it. It predicts the same declaration bytes as `scaffold`, remains strictly read-only, and creates no temporary files. `allowGitSpawn: false` disables the existing read-only Git probe. `writeSet`, `conflicts`, and `complete` do not authorize execution or establish business qualification.

Use `runProjection({ root: targetRoot, engineering })` only for an already managed project. It replaces the entire `engineering` object without deep-merging. Include all still-needed existing `entries` and `releaseUnits` in the complete confirmed object. It cannot be combined with `manifest`, `candidateRoot`, or `preparedProjection`. The target must be an ordinary existing root with valid ordinary registry, project manifest, and managed lock; manifest and lock must already be declared managed by both registry and `managedFiles`, and the manifest lock entry must be owned by Engineering Kit. All other managed files must match their original lock, with no missing coverage, duplicate entries, or unowned lock entries. Every business entry and version reference must point to an existing ordinary file inside the root. Missing prerequisites make this update unavailable; they do not trigger automatic takeover of an arbitrary non-empty project.

A valid update writes only `skill-family.project-manifest.json` and `skill-family.managed-file-lock.json`. It preserves non-`engineering` fields, registry and other file bytes, other lock entries, generator identity, versions, `lockVersion`, and file modes. The existing generator derives the manifest hash, and identical content is idempotent. The result remains a `skill-family.projection-receipt` with `schemaVersion: 2`; its in-memory `candidate.root` and `manifest.location` are `null`. Existing v1/v2 and prepared-projection protection remain in place; do not hand-write a manifest or lock candidate to hide drift.

The three existing CLI commands accept `--engineering <JSON>`:

```text
skill-family-kit scaffold --root <target> --project-id <id> --profile generic --licensing-profile <licensing-id> --engineering <JSON>
skill-family-kit adopt-plan --root <target> --project-id <id> --profile <profile-id> --licensing-profile <licensing-id> --no-git-spawn --engineering <JSON>
skill-family-kit projection --root <target> --engineering <JSON>
```

`<JSON>` is a JSON object string, not a file path; quote it as one shell argument. `--engineering` is separate from `--engineering-baseline`, which still requires `--compare-skeleton`. Capability catalog queries cannot include engineering declarations. The existing four-command boundary remains.

If facts are incomplete, report the missing facts. A declaration may contain only `entries` or only `releaseUnits`, but the absent declared-check branch remains `incomplete`. Once the real business and version files exist, use the official managed update and the existing core, declared version, and declared entry checks. Generation, a read-only plan, static checks, formal host discovery, real business execution, independent semantic review, and overall qualification remain separate facts. Omission preserves old behavior; it does not mean declarations are complete.

Since 0.24.0, `runCoreCheck` selects the applicable version-check path from the target declarations: when a target explicitly declares `engineering.releaseUnits`, the core reuses the existing declared reader for `versionSource` and `versionMirrors` (text or JSON), applying the same validation logic. A private `package.json` within the engineering scope is not treated as an implicit source or mirror for that business unit. It is checked for that unit only when explicitly declared. Targets with no version declaration, or only valid `entries`, continue to use the legacy version check. Invalid or duplicate declarations cannot fall back to success. Missing or unreadable declared sources or mirrors fail visibly.

The nine-class loop and report assembly are preserved, maintaining Contracts specification-version compatibility and the integrity of the other eight classes. Declared sources, mirrors, and their ancestral paths are included in the preflight check via the original tree enumeration and `lstat` safety validation, including paths inside opaque tooling directories. Only declared paths are probed; no new directory walker is introduced. Symlinks, FIFOs, and unsafe ancestor paths remain rejected under the original rules, including in-root symlinks. Completion status, mechanism failures, and exit codes 0/1/2 are propagated accurately.

Public `runChecks` defaults to `policy: "legacy"`. Its original findings and full/only equivalence remain unchanged. Explicit `policy: "declared"` still requires `only: "version"` and preserves its report structure, zero-target execution semantics, and zero-Git boundary. No new public policy value, API, CLI option, Schema definition, or package-root export is added. No checker is copied into the generated target shim. Local verification does not establish publication readiness, business qualification, or complete initialization. This update reflects only a narrow, targeted change in core behavior for targets with declared versions; standalone `runChecks` retains its documented behavior.

### Three adoption journeys

New projects can evaluate all uses before choosing stable capabilities:

```sh
npm exec -- skill-family-kit adopt-plan --list-capabilities --all --scope all --locale en --uses ./uses.json
npm exec -- skill-family-kit scaffold --root ./my-project --project-id my-project --capability <stable-id>
```

Existing projects start with a read-only plan, then record one decision for each declared use:

```sh
npm exec -- skill-family-kit adopt-plan --root ./existing-repo
npm exec -- skill-family-kit adopt-plan --root ./existing-repo --list-capabilities --scope all --locale en
```

Daily work can query one requirement without knowing a capability ID:

```sh
npm exec -- skill-family-kit adopt-plan --list-capabilities --locale en --filter "must not leave a partial file when a write fails"
```

The output distinguishes candidates (`supportedMatches`), boundaries (`boundary-found`), and no text match (`no-text-match`). A migration `complete` result covers only the migration gate. Contract integration is established by the consumer's adapter and domain tests. Real-host qualification is a separate explicit action:

```sh
npm exec -- skill-family-kit check qualification --root <consumer-repo> --capability foundation.kit.plugin-verification --request <request-json> --bindings <private-bindings-json> --native
```

The qualification command requires complete explicit inputs and can invoke the capability-specific host only after preflight; it does not turn candidate discovery or migration completion into a qualification claim.

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

### Host-loading check sub-action

```sh
npm exec -- skill-family-kit check host-loading --root <project> --host codex --host-version 0.154.0 --path-category codex-project-skills
npm exec -- skill-family-kit check host-loading --root <project> --host codex --host-version 0.154.0 --path-category codex-project-skills --activation-rules <relpath.json> --hosts-root <dir>
```

The public function is `runHostLoadingCheck`. It statically reads `SKILL.md` and the optional Codex 0.154.0 standard skill metadata YAML in `agents/` beside `SKILL.md` under the selected project root `.agents/skills`, and reports format, ignored, filtered, implicit-invocation, disabled, and uncovered observations using the calibrated Codex CLI 0.154.0 rules. Exact optional-file names and parse scope are in [`src/host-loading-check.mjs`](src/host-loading-check.mjs). It does not start a host, model, hook, or script, and writes nothing.

The API `root` must be an absolute project working directory; the CLI resolves the current directory or a relative path to an absolute path first. Only `pathCategory` `codex-project-skills` and version `0.154.0` are calibrated, and that category's relative path must remain `.agents/skills`. Other hosts or versions return exit code 2. A missing skill entry, or a scope that contains only product-filtered targets, returns 1. Callers may pass ordered name/path/enabled rules with `--activation-rules`; without rules, enabled is unknown. Same-name skills at different paths are all retained. Bad optional metadata is ignored as a whole document and is not reported as a skill load failure. `policy.products` that lists only products other than Codex is filtered from the Codex discoverable set; `[codex]` is kept. `allow_implicit_invocation=false` may still be enabled.

A static pass does not prove real install, session selection, or business execution. Consume the published package's public interfaces and sources. This check covers only the selected project's `.agents/skills`. The published package's actual sources are this unit's public closure; that package surface is separate from the check coverage.

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

The Profile must be provided explicitly; Kit does not bind a specific host by default. Canonical host IDs may resolve only aliases declared by the finite registered Profile set. Probe starts no process by default; only when both `--allow-host-spawn --host-executable <absolute-path>` are given is the frozen version vector executed. Local install and update use an explicit authorization reference plus the existing contained publication primitives; uninstall is rejected with `manual-recovery-required` because Foundation has no safe bound deletion primitive. Two registered hosts have trusted version drivers; Kimi Code, WorkBuddy, CodeBuddy, and DeepSeek Harness expose independent manual facts. Qoder remains `manual`; the separate native plugin candidate does not grant generic host build, plan, apply, install/update/uninstall, rollback, or real-host qualification. Adapter source only accepts declared text closures; binary projection is not supported; see the [host capability matrix](../../docs/reference/host-capability-matrix.md) and registered Profiles.

### Candidate real-host verification library API

`runHostVerification({ request, bindings, hostsRoot })` and `verifyHostVerificationBindings({ results, expectedCommon, expectedRequestDigestByHost })` are library APIs, not a fifth Kit command. The first runs one bounded candidate verification against caller-bound roots using a fixed built-in driver and returns a Contracts-validated, redacted four-state result. All five drivers use `existing-user-state + host-managed`; their exact identities and limitations are listed in the [host capability matrix](../../docs/reference/host-capability-matrix.md). The second API is pure and combines only `observed` results with the exact common fields and per-host request digest expected by the caller.

The API keeps consumer workload, domain output checks, domain PASS/FAIL, release freshness, and release state outside Foundation. The caller supplies a canonical `existingUserStateRoot` that is projected into the child environment but never read, digested, modified or cleaned by Foundation; it does not grant manual Profiles any build, plan, apply, install, update, or uninstall capability. Version 0.12.0 requires real-host verification of all five fixed drivers before publication; the API does not own that release decision.

`executableSha256` binds only the bytes observed by the strict preflight read; the actual process is still spawned by pathname, so the caller must exclusively control the executable namespace through probe and invocation. Foundation retains the call's `session-*` directory and never deletes it by pathname. After inspection, the caller cleans its exclusively owned outer `temporaryRoot`.

#### 0.21.0 candidate: prepare a Cursor invocation

`prepareHostVerification` was published with 0.21.0 and remains available in 0.22.0. It prepares one declared Skill for `cursor`, using the packaged Descriptor and fixed `cursor-agent-print-v1` driver. It accepts no custom driver, arguments, model override, credential handling, or domain validator. The existing seven-driver `runHostVerification` entrypoint remains compatible.

The caller supplies the following values; document and fixture content is an opaque UTF-8 string or Buffer. `skillMembers` must include `SKILL.md`; only declared members are installed. All roots must already exist as canonical absolute paths. `sessionRoot` must be empty and exclusively owned, and the workspace must be inside `repositoryRoot` (equality is allowed). The caller authorizes use of the existing user-state root and exclusively controls the executable namespace.

```js
import { prepareHostVerification, runHostVerification } from "skill-family-engineering-kit";

const prepared = await prepareHostVerification({
  hostId: "cursor", verificationSetId,
  candidate: { ref: candidateRef, manifest: candidateManifest },
  skill: { root: skillRoot, entrySkill, members: skillMembers },
  workloadDocument, fixtureFiles, // [{ path: "input.json", content: fixtureBytes }]
  workspace: { repositoryRoot, root: workspaceRoot, protectedMembers },
  platformManifest, effectivePrompt,
  executable: { root: executableRoot, relPath: "cursor-agent" },
  existingUserStateRoot, sessionRoot,
  timeoutPolicy: { schemaVersion: 1, kind: "skill-family.timeout-policy", maxSeconds: 60, killGraceSeconds: 1 },
});
const result = await runHostVerification(prepared);
const stdout = result.streams
  ? await prepared.readInvocationStream(result, "stdout")
  : null;
```

Preparation copies input bytes, computes digests, freezes the request and private bindings, and creates contained documents and missing `.cursor/skills` parents without spawning a process or installing the Skill. Execution rechecks bindings and compares the installed Skill digest before any probe. Invalid fields, Schema failures, and mechanism failures use `SFC2003`, `SFC1001`, and `SFC2004`, respectively; preparation may leave partial files on a mechanism failure.

`readInvocationStream(result, "stdout" | "stderr")` returns a Buffer only after checking the result, request binding, captured evidence root, stream digest, and byte count. It does not parse the answer or decide domain correctness. Missing streams or a read failure mean required business evidence is unavailable, not acceptance. The four states remain `observed`, `rejected`, `failed`, and `indeterminate`; `observed` is not a domain PASS. Only the validated result may enter a public report: the prepared object, raw streams, and error details stay private.

The caller owns workload semantics, candidate-to-payload binding, domain assertions, release freshness, and resource cleanup. Keep the outer session and workspace handles before preparation; after a known outcome, read the evidence and confirm no process still uses the directories before cleanup. Preserve an `indeterminate` scene for the required manual actions; do not wrap the call in unconditional cleanup. A retry needs fresh roots and a new prepared object. These local fixture checks do not qualify a real host or prove model-driven Skill discovery.

## Typical Use Cases

- New project skeleton: `scaffold` (does not overwrite a non-empty existing repo).
- Existing-repo adoption inventory: `adopt-plan` (strictly read-only, no file writes, no auto-migration).
- Managed projection: `projection` + Profile (does not overwrite handwritten files).
- Engineering diagnostics: ordinary `check` is read-only; `check relock` is an explicit controlled write transaction, and `check qualification` may spawn a bound executable after preflight.
- Declared governance diagnostics: select `policy: "declared"` with version-only checking, or use the declared entry sub-action. The target is inspected statically; an optional conclusion file requires explicit output authorization.

## Boundary Mechanisms

- `scaffold`'s target must be an **empty directory** (any entry including dotfiles counts as non-empty), or a non-existent path whose parent directory exists (only the last level is created). All writes go through the harness's atomic contained write (`writeFileAtomic`), leaving no half-written artifact on failure, and paths cannot escape the target root.
- `adopt-plan` is structurally read-only: there is no write call in the implementation, not even a temp file; the plan bytes share the same source as `scaffold` (single source of truth `describeSkeletonFiles`), hence "the plan is the action". By default it may spawn one frozen read-only Git status probe; the CLI `--no-git-spawn` (or API `allowGitSpawn: false`) disables that probe. A dirty repo has zero byte-level change before and after running.
- `projection` uses two-phase execution: first, for each entry, it performs path classification, containment pre-check, self-projection check, manifest authorization check, hand-written protection, and conflict guard; if any entry violates, the whole is rejected with zero writes. Overwriting an existing file must declare the precise `expect.sha256` precondition; an existing file with identical content is an idempotent no-op. On write failure it best-effort restores the pre-write bytes of already-overwritten files.

  Engineering mode retains the originally verified reference snapshots and rechecks them before each actual mutation and after completion; repeated reads cannot replace the baseline. A rejection before the first write performs no restoration writes, and foreign bytes on an output never attempted by this mode are preserved. If an actual output write is attempted and fails, the existing error, verification, and best-effort rollback path restores only outputs this mode actually attempted. This does not promise a transaction for the whole initialization, hostile concurrency, or ABA safety; the existing v2 complete-closure rollback contract remains unchanged.
- Ordinary `check` is read-only and has no write calls or `--fix/--apply/--repair` modes (such flags are rejected at the entry point). By default it may spawn one frozen read-only Git status probe; the CLI `--no-git-spawn` (or API `allowGitSpawn: false`) disables that probe. `check relock` is the explicit controlled write transaction; `check qualification` may spawn a bound executable after preflight. Git precondition state uses only filesystem facts plus at most one read-only `git status --porcelain=2` with a frozen parameter vector (`--no-optional-locks` + `GIT_OPTIONAL_LOCKS=0`, no index refresh).
- In the declared branch, the two pure check functions remain read-only and do not probe Git. An explicitly requested conclusion is the only added persistent effect and is performed by the two existing wrappers through exclusive creation.

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

This package must not perform git init, commit, push, tag, stash, branch switch, publish, delete, remote write, or publish-state recital; it does not implement a fifth top-level command; it does no business judgments or model calls.

Foundation itself does not issue network requests, but the bound executable may access the network. Foundation provides no sandbox or egress blocking; callers and the execution environment own that isolation. Repository-controlled fixtures are designed not to issue network requests.

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
- You need generic or remote host lifecycle, automatic trust confirmation, deleting uninstall, or real-host qualification from a controlled fixture.
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
- adopt-plan and ordinary check are strictly read-only and write no files; by default they may spawn one frozen read-only Git status probe, disabled by `--no-git-spawn` (or API `allowGitSpawn: false`). check relock is an explicit controlled write transaction; check qualification may spawn a bound executable after preflight. Git is a read-only whitelisted probe for diagnostic checks.
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

## Complete Plugin Candidate

The candidate `runPluginVerification({ request, bindings, hostsRoot })` preserves the two legacy goals and adds a local-only `native-lifecycle` branch. Qoder and WorkBuddy use separate production drivers with driver-owned argv plans, exactly twelve semantic stages, and executable identity re-observation before every spawn. Contracts owns only structure; Kit owns the host plan and Oracle. The controlled executable protocol proves isolation wiring and is not vendor grammar. Each actual host/source combination still needs qualification evidence.

The separate `runSkillFamilyDirectoryVerification({ request, bindings })` entry fixes the Kimi production argv and narrow environment and rejects caller observation. Its raw parser is exercised through the production process path, but no controlled fixture event is promoted to `observed`; without an official typed mapping, the public result remains `indeterminate` and a manual candidate.

The declared governance branch and conclusion output ship with the 0.22.0 artifact; the earlier published 0.21.0 artifact does not contain them. Remote availability must be established by the corresponding release-skill post-release evidence. Local tests or working-tree tarballs do not prove contract integration, migration completion, or real-host qualification.
