<!-- release-skill:safe-first-command -->
<!-- release-skill:external-write-boundary -->
> 简体中文版：[README.zh-CN.md](./README.zh-CN.md)

# skill-family-engineering-kit

<!-- release-skill:release-version: 0.39.0 -->

An engineering toolkit used in development and CI. There are **exactly four** top-level commands, and no fifth:

<!-- release-skill:managed:start id=latest-release -->
**0.39.0** (2026-11-06)

Adds explicit exact runtime-artifact registration through the existing relock APIs and CLI, with future-path support, source separation checks and byte-preserving repeats. Adds CC-BY-NC-SA-4.0 legal text, per-author NOTICE attribution and explicit unknown copyright years through existing custom licensing profiles. Existing MIT, Apache and default registration behavior is retained.

**Changed**

- Adds explicit exact runtime-artifact registration through the existing relock APIs and CLI, with future-path support, source separation checks and byte-preserving repeats. Adds CC-BY-NC-SA-4.0 legal text, per-author NOTICE attribution and explicit unknown copyright years through existing custom licensing profiles. Existing MIT, Apache and default registration behavior is retained.

**Upgrade Notes**

Adopt all four 0.39.0 release units together and verify new entries in the exact published package. Existing default registration, MIT and Apache behavior is retained.
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

Before the formal publication of version 0.39.0, authorized development verification may use a local source candidate. This validation is conditional and does not imply current registry availability. The following steps demonstrate how to package and test the candidate locally using tarballs, ensuring no accidental selection of older releases such as the previously published 0.38.0.

```sh
pack_dir="$(mktemp -d)"
(cd packages/skill-family-contracts && pnpm pack --pack-destination "$pack_dir")
(cd packages/skill-family-harness-node && pnpm pack --pack-destination "$pack_dir")
(cd packages/skill-family-engineering-kit && pnpm pack --pack-destination "$pack_dir")
mkdir "$pack_dir/consumer" && (cd "$pack_dir/consumer" && npm init -y)
(cd "$pack_dir/consumer" && npm install "$pack_dir/skill-family-contracts-0.39.0.tgz" "$pack_dir/skill-family-harness-node-0.39.0.tgz" "$pack_dir/skill-family-engineering-kit-0.39.0.tgz")
```

This approach validates the working-tree candidate in a fresh consumer project. Third-party dependencies may still be downloaded from the registry.

Only after version 0.39.0 is formally available in the public registry do the following installation and execution examples apply:

```sh
npm install --save-dev skill-family-engineering-kit@0.39.0
npm exec --package=skill-family-engineering-kit@0.39.0 -- skill-family-kit --help
npm exec --package=skill-family-engineering-kit@0.39.0 -- skill-family-kit scaffold --root <empty-dir> --project-id my-project
npm exec --package=skill-family-engineering-kit@0.39.0 -- skill-family-kit adopt-plan --root <repo> --list-capabilities --all --scope all --locale en --uses ./uses.json
npm exec --package=skill-family-engineering-kit@0.39.0 -- skill-family-kit projection --root <repo>
npm exec --package=skill-family-engineering-kit@0.39.0 -- skill-family-kit check --root <repo>
```

These commands demonstrate help output, skeleton generation, read-only inventory listing, managed-fact projection, and diagnostics for engineering inconsistencies. Once the exact registry version is published, the help command can be invoked without pre-installing the Kit in the target project: `npm exec --package=skill-family-engineering-kit@0.39.0 -- skill-family-kit --help`.

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

Use `runProjection({ root: targetRoot, engineering })` only for an already managed project. It replaces the entire `engineering` object without deep-merging. Include all still-needed existing `entries` and `releaseUnits` in the complete confirmed object. It cannot be combined with `manifest`, `candidateRoot`, or `preparedProjection`. The target must be an ordinary existing root with valid ordinary registry, project manifest, and managed lock; manifest and lock must already be declared managed by both registry and `managedFiles`, and the manifest lock entry must be owned by Engineering Kit. All other managed files must match their original lock, with no missing coverage, duplicate entries, or unowned lock entries. Every business entry and version reference must point to an existing ordinary file inside the root. When the registry already lists the lock as kit-managed and `managedFiles` omits only that path, this update adds the path and rewrites the manifest and lock together. Missing prerequisites, including a lock the registry does not declare, make this update unavailable; they do not trigger automatic takeover of an arbitrary non-empty project.

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

#### Version and scope

Version 0.25.0 provides the Codex CLI 0.154.0 check. The 0.26.0 source candidate extends the same entry to seven additional hosts; formal availability depends on that version's release verification. The 0.25.0 published package does not support the added hosts.

#### Calling the check

The public function is `runHostLoadingCheck({ root, hostId, hostVersion, pathCategory, activationRules, hostsRoot })`. These are the corresponding CLI calls; the third requires a version containing the seven-host extension:

```sh
npm exec -- skill-family-kit check host-loading --root <project> --host codex --host-version 0.154.0 --path-category codex-project-skills
npm exec -- skill-family-kit check host-loading --root <project> --host codex --host-version 0.154.0 --path-category codex-project-skills --activation-rules <relpath.json> --hosts-root <dir>
npm exec -- skill-family-kit check host-loading --root <project> --host kimi-code --host-version 2.2.0 --path-category kimi-code-project-skills
```

The API `root` must be an absolute project directory. The CLI first resolves the current directory or a relative path. `--host`, `--host-version`, and `--path-category` select an exact supported combination. Omitting `hostsRoot` uses the bundled Profile data; a custom root cannot change the calibrated version, category, or relative directory combination.

For Codex, `--activation-rules` takes a project-relative JSON file containing ordered rules. Each rule selects either `name` or `path`, and includes a boolean `enabled`. For the seven added hosts, the API accepts only an omitted or `null` `activationRules`; every non-null value, including `[]`, returns `2`. Omit this CLI option for those hosts.

The internal `NATIVE_HOSTS` table in [src/host-loading-native.mjs](src/host-loading-native.mjs) lists the added hosts' exact versions, categories, and relative directories. It is not a package-root public export. The Kimi example uses `.kimi-code/skills`. Codex keeps its existing constants in [src/host-loading-check.mjs](src/host-loading-check.mjs) and the `.agents/skills` container.

#### Reading the report

The check starts no host, model, hook, or script, makes no network requests, and writes nothing. It covers one explicit project skill container, not the user's global skills, ancestor projects, or the entire plugin environment. Directory and file symlinks in the seven-host extension remain uncovered and return `2`; the check does not read through them.

Codex keeps its existing behavior:

- Same-name skills at different paths are all retained.
- Invalid optional standard skill metadata YAML under `agents/` beside `SKILL.md` is ignored as a whole document, not reported as a skill load failure.
- A nonempty `policy.products` containing only products other than Codex is filtered. A list containing `codex` is kept; an empty list does not trigger this filter.
- `allow_implicit_invocation=false` records implicit invocation being disabled, independently of `enabled`. Without explicit activation rules, `enabled` remains unknown.

For the seven added hosts, each skill's base `enabled`, `disabled`, `implicitInvocation`, `interface`, and `shortDescription` fields remain `null`. Host-specific observations appear in `skills[].observations`, with `field`, `value`, `basis`, and `sourceId`. A `native-observed` basis means that native evidence was used to calibrate the rule; it does not mean this check ran the native host. `sourceId` refers to `coverage.ruleSources`, whose entries contain `id`, `version`, `source`, and `sha256`.

Only Cursor CLI `2026.09.10-fd3934a`'s `modelMetadata.*` observations use `source-reviewed-unexecuted`, meaning source-reviewed but not calibrated by a native run. Its menu and completion surfaces have native calibration evidence. Codex continues to use `officialTag` and `officialCommit`; these fields are not invented for other hosts.

| Exit code | Meaning |
| --- | --- |
| `0` | The requested scope is covered and has no established blocker. |
| `1` | An established blocker, or an existing project with a missing skill container or no discoverable entry. A Codex scope containing only product-filtered targets also returns `1`. |
| `2` | An unknown version or shape, non-equivalent coverage, invalid selector, or a missing/non-directory project root. |

Uncovered items take precedence and produce `2`, while known `findings` remain in the report. Read `findings`, `uncovered`, and `limitations` together. Name-collision handling follows each host's rules; an uncovered competition does not imply a winner.

A static `0` does not prove enablement, installation, update, session selection, actual invocation, or business success. The published package's source and public closure are separate from the scope of this check. Use the actual published version's interfaces and sources.

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

## Skill Text Binding and Native Projection Checks

### Skill Text Binding Check (`runSkillSurfaceBindingCheck`)

The caller invokes the independent read-only API `runSkillSurfaceBindingCheck`, with input `{root, bindings}`, where `root` is a non-empty string representing the project root directory path, and `bindings` is a non-empty array. Each entry in `bindings` requires `naturalSkill`, `parameterDeclaration`, `commonMethod`, and `parameterName`. All fields must be present, and no additional keys are accepted.

**Request JSON Structure Example**

The example illustrates the request format. Actual coordinates are derived from existing source files.

```json
{
  "bindings": [{
    "naturalSkill": {"ref": "SKILL.md", "protocolRef": {"line": 4, "column": 11, "length": 10}},
    "parameterDeclaration": {"ref": "methods.md", "parameterLiteral": {"line": 3, "column": 7, "length": 12}},
    "commonMethod": {
      "ref": "methods.md",
      "methodId": {"line": 1, "column": 3, "length": 12},
      "methodValue": {"line": 1, "column": 10, "length": 5},
      "implementationRef": {"line": 2, "column": 8, "length": 8}
    },
    "parameterName": "method"
  }]
}
```

**Field Requirements**

- `root` is a non-empty string, representing the project root directory. Can be absolute or relative.
- `bindings` is a non-empty array. Each item requires the following fields.
  - `naturalSkill.ref` is a path string pointing to the actual Skill Markdown file.
  - `parameterDeclaration.ref` is a path string pointing to the parameter declaration file.
  - `commonMethod.ref` is a path string pointing to the common method definition file.
  - `parameterName` is a string matching the regular expression `^[A-Za-z_$][A-Za-z0-9_$]*$`, representing the parameter name.
- All span objects (`protocolRef`, `parameterLiteral`, `methodId`, `methodValue`, `implementationRef`) must have `line`, `column`, and `length` values as positive safe integers. Coordinates are one-based UTF-16 code units within one physical line, with no splitting of surrogate pairs.
- `methodId` and `methodValue` must be on the same line, and the `methodValue` span must be strictly contained within the `methodId` span.
- `parameterDeclaration.ref` and `commonMethod.ref` must resolve to the same actual file path.
- `parameterName` and `methodValue` are not compared against each other.

**Four Actual Comparison Relationships**

The API strictly reads actual Skill and Markdown content, extracting raw values from initial YAML and selected text spans. Parameters support only direct `key=value` syntax, with the key matching `parameterName`. Local values must match `^[A-Za-z_][A-Za-z0-9_-]*$`. The full method identity is a single-line unquoted value.

1. The actual Skill `name` (from initial YAML) compared to the value of the common `methodId`.
2. The actual `parameterLiteral` is compared with the string formed from `parameterName`, an equals sign, and the actual local value read from the common `methodValue` span.
3. The actual contained file identity resolved from the `implementationRef` span is compared with the identity of `naturalSkill.ref`.
4. The actual contained file identity resolved from the `protocolRef` span is compared with the identity of `commonMethod.ref`.

**scope.checked Identifiers**

- `binding:N:method-identity`
- `binding:N:parameter-declaration`
- `binding:N:implementation-reference`
- `binding:N:protocol-reference`

File references and selected path literals are direct local relative paths within root. Target files must be strictly readable. Missing or unreadable files result in binding deficiency.

---

### Native Projection Check (`runNativeProjectionCheck`)

The caller invokes the independent read-only API `runNativeProjectionCheck`, with input `{root, bindings}`, where `root` is a non-empty string representing the project root directory, and `bindings` is a non-empty array.

**Request JSON Structure Example**

The example illustrates the request format. Actual coordinates are derived from existing source files.

```json
{
  "bindings": [{
    "commonManifestRef": "common/manifest.json",
    "commonSkillIndex": 0,
    "platformManifestRef": "adapters/codex/manifest.json",
    "mappingIndex": 0,
    "resources": [{"commonRef": "common/rules.bin", "platformRef": "adapters/codex/rules.bin"}]
  }]
}
```

**Field Requirements**

- `root` is a non-empty string, representing the project root directory.
- `bindings` is a non-empty array. Each item requires the following fields.
  - `commonManifestRef` is a non-empty string, pointing to the common manifest file path.
  - `commonSkillIndex` is a non-negative safe integer, indicating the Skill index in the common manifest.
  - `platformManifestRef` is a non-empty string, pointing to the platform manifest file path.
  - `mappingIndex` is a non-negative safe integer, indicating the mapping index in the platform manifest.
  - `resources` is an array that may be empty, but each item must have both `commonRef` and `platformRef` as non-empty strings, representing file path pairs.

**Four Identity Source Chains**

1. The platform `source` actual file path compared to the selected common manifest file path.
2. The platform `physicalName` compared to the platform Skill’s `name`.
3. The platform `logicalName` compared to the selected common `logicalName`.
4. The common `logicalName` compared to the common Skill’s `name`.

**Actual Skill Comparison**

- The common `sourceRoot` is resolved relative to `root`, then used to locate the actual Skill via `skills[index].source`. When `sourceRoot` is exactly `.`, the resolved `root` is used as the base directory.
- The platform Skill (Markdown) is located at the platform manifest directory plus `logicalMappings[index].path`.
- Both actual Skill files are strictly decoded as UTF-8. The unique direct single-line YAML `name` scalar range is located, supporting `plain`, `single-quote`, and `double-quote` formats.
- Only the `name` scalar ranges are replaced with a fixed value. All other bytes are compared in full.
- `skillNormalization` retains the actual `name`, original byte range, and `normalizedSha256`.

- Aliases, merges, duplicate keys, unknown tags, indirect or multi-line `name`, non-unique ranges, or invalid UTF-8 make the binding insufficient.

**Resource Comparison**

- Each pair of `commonRef` and `platformRef` files is compared by their complete raw bytes, allowing binary content.
- Each resource pair is compared separately from the Skill files. Every comparison in a binding still depends on that binding’s valid read closure.
- The dual paths only indicate positional correspondence. Additional content adaptation rules are not included in the closed input. Known content, permission, and protocol byte differences are treated as actual findings. Domain meaning is determined by the caller.

**scope.checked Identifiers**

- `binding:N:native-identity:1` through `binding:N:native-identity:4`, corresponding to the four identity relationships above.
- `binding:N:skill-content`, indicating the result of the full file byte comparison for the Skill.
- `"binding:" + N + ":resource:" + M + ":bytes"`, where `M` is the resource pair index, indicating the byte comparison result for that resource pair.

### Results, CLI and Proof Reading

**Request Error Conditions**

- Structural or type mismatches, unknown fields, empty or duplicate bindings, invalid span values, an invalid containment relationship between the methodId and methodValue spans, duplicate resource pairs, or the same platform resource selected with conflicting common resources.

**Binding Deficiency Conditions**

- Actual text out of bounds, unsupported direct text or path subsets, key mismatch, failure of common file premise, missing/unreadable/ambiguous files, strict UTF-8 failure, or closure drift.

These conditions invalidate every comparison in the dependent binding. Stable independent bindings remain, and unexpected errors propagate.

**Known Finding Conditions**

- After premise validity, direct values or content do not match.

**Five Result Aggregations**

- `complete/ENGINEERING_CLEAR` means all checks completed with no findings.
- `complete/ENGINEERING_FINDINGS` means all checks completed with findings.
- `partial/ENGINEERING_FINDINGS` means stable findings and deficiencies coexist.
- `partial/ENGINEERING_CHECK_INCOMPLETE` means some comparisons completed with no findings but still has deficiencies.
- `not-performed/ENGINEERING_CHECK_INCOMPLETE` means no completed comparisons available.

**CLI Invocation Commands**

```text
skill-family-kit check skill-surface-bindings --root <dir> --selection <rel> --json
skill-family-kit check native-projections --root <dir> --selection <rel> --json
```

**Selection Receipt**

- The selected file is located within the root and contains only `bindings`. No ambiguous JSON parsing is allowed. The closure includes a read receipt.

- CLI exit codes have the following meanings.
  - `0` means complete with no findings.
  - `1` means findings or deficiencies present.
  - `2` means invalid request or unhandled mechanism error.

**Real API Original and Reader**

Returns the original `skill-family.professional-conclusion`. `provider.entry` is the actual API name, `subject.ref` is the resolved actual root directory, and `details` retains the selection, read receipt, location, actual values or file identities, comparisons, and closure. Static read-only observation is limited to this byte set. No atomic snapshots are provided.

- The host maintains the original return exclusively, then passes it to `readProfessionalProof({proofRoot,proof})` or `check proof` for interpretation.
- For the read conclusions, `complete/ENGINEERING_CLEAR` is interpreted as `pass`. Findings or incompleteness are interpreted as `not_pass`. If the proof is unreadable or uninterpretable, it is `unavailable`.
- Do not use `proof-create` to manually fill mechanical results.
- The `reader` does not rescan or audit the author.
- When selecting other ranges, original files are preserved separately. Professional conclusions only cover actual `scope`.
- Domain-level adaptation, violations, and full selection interpretation are the caller’s responsibility.

<!-- agent-quick-reference:start -->
## Fixed File Reference Check

Call the public API `runStaticReferenceCheck({root, references})` to perform a read-only validation of selected fixed file references. The request must include an explicit non-empty `root` directory and a non-empty `references` array. Each reference must contain exactly `sourceRef`, `line`, `literal`, and `baseDir`, with all three path fields as non-empty strings and `line` as a positive safe integer starting from 1. Duplicate entries or unknown keys are rejected with `SFC2003` error. Each reference is processed independently, without requiring full set support. The caller must ensure actual invocation, explicit resolution of the base, and inclusion of all necessary references.

### Supported Path Forms

- **Standard relative paths** such as `utils/helper.js`, including single `./` prefix, e.g., `./utils/helper.js`.
- **New raw literal form**: Begins with one or more consecutive `../`, followed by one or more path segments separated by `/`. Each segment contains only ASCII letters, digits, dots, underscores, and hyphens, and must not be `.` or `..`. Valid file names include `index.mjs` and `variable.js`.

### Examples of Valid References

- `baseDir=scripts`, `literal=../runtime/index.mjs` → `targetRef=runtime/index.mjs`
- `baseDir=nested/scripts`, `literal=../../runtime/index.mjs` → `targetRef=runtime/index.mjs`

### Unsupported Path Forms

- `nested/scripts/../../runtime/index.mjs` (intermediate `../` sequences)
- `./../file`, `.././file`, `../`, empty suffix
- Paths containing variables, globs, whitespace, non-ASCII characters, backslashes, absolute paths, URIs, dynamic syntax, or module resolution patterns

### Processing Flow

1. Copy and validate the request.
2. Resolve the `root` directory.
3. Use `readFileStrict` to read the file at `sourceRef`.
4. Bind `literal` to the specified `line`, ensuring it is within bounds and appears only once.
5. Apply strict lexical validation.
6. If `baseDir` is not `.` , call `resolveContained` to verify the actual base directory.
7. Derive `targetRef` using `path.posix.join(baseDir, literal)`. This operation applies POSIX lexical normalization but preserves the original `literal` unchanged.
8. The resulting `targetRef` may extend beyond `baseDir`, but must remain strictly within `root`. Relative `..` that would escape `root` are retained in the target path and rejected by the Harness.
9. Use `readFileStrict` to read the target file and enforce strict root containment.

### Receipts and Closure

- Preserve real `ref`, `sha256`, and `bytes` receipts for both source and target.
- Retain original `details.references` and `closure`.
- Use `computeResourceClosure` to compute summary for complete items. Repeated reads or closure drift invalidate dependencies; independent stable items are preserved. If the entire closure fails, `closure=null`.
- Unknown program exceptions are propagated directly, not converted to insufficient.

### Aggregated Results and Errors

- Each reference returns `checked` or `insufficient`.
- All `checked` → `complete/ENGINEERING_CLEAR`
- At least one `checked` with any insufficient → `partial/ENGINEERING_CHECK_INCOMPLETE`
- No `checked` → `not-performed/ENGINEERING_CHECK_INCOMPLETE`
- `not-performed` is not a per-item status and does not imply no call was made.
- Insufficiency reasons include missing, unreadable, ambiguous, unsupported, or out-of-bounds conditions. Retain `reason` and any existing `cause`.

### Reader and Caller Semantics

- Save the actual returned conclusion and read it through `readProfessionalProof({proofRoot,proof})`. Compare source receipt digests against the caller’s frozen target. The reader retains its original interpretation scope.
- Local results reflect only the completion state at observation time. Semantic correctness, permissions, and business integrity are the caller’s responsibility.
- Observations are non-atomic snapshots.
- Actual execution does not write, run target code, start processes, or connect to networks.

### Example Request

```json
{
  "root": "/project",
  "references": [
    {
      "sourceRef": "tools/run.mjs",
      "line": 1,
      "literal": "../runtime/index.mjs",
      "baseDir": "tools"
    }
  ]
}
```

### Version and Dependencies

- This revision is version 0.38.0 (development candidate); the current stable release is 0.37.0.
- Public consumption is based on the exact published version installed.
- `runStaticReferenceCheck` already exists; this update only expands the allowed `literal` subset.
- No new API, CLI, exports, patterns, fields, proof formats, Schema, dependencies, or Harness algorithms are introduced.
- The other two new APIs from original 038 remain independent; this unit does not involve them and adds no execution dependencies.
- No dedicated fixed-reference CLI exists. Skills call the package-root API and public reader directly.

### Fixed Schema Declaration and Use Link Check (runFixedSchemaUseCheck)

This section is intended for callers with foundational knowledge of JSON and Python. A Schema is a JSON contract defining object structure, with `$id` as the full type identity and `schemaVersion` as the required data version specified in the contract. The correspondence between the selected Markdown declaration and the actual Schema can be independently verified; optional Python implementation checks further validate the order between actual Schema adoption and business interpretation.

This scope uses the package-root API `runFixedSchemaUseCheck({root, bindings})`. `root` must be a non-empty string indicating an approved root directory, and `bindings` must be a non-empty array. Unknown keys, duplicate selections, or invalid coordinates are rejected via SFC2003. Input is synchronously deeply copied before asynchronous reading. All paths are read through existing strict root containment, with no execution of target Python code.

`declaration` must contain `ref`, `unit`, `schemaPath`, `schemaId`, and `schemaVersion`. `ref` is the actual Markdown path; the other four are `{line, column, length}` positive safe integers using 1-based UTF-16 code-unit positioning. A physical `unit` contains three sub-segments, each unique and with complete literal boundaries, without splitting surrogate pairs. Different `unit`s must not overlap, and the same `unit` may be associated with different implementations. The three spans select the actual root-contained Schema path, the full `$id`, and the literal `schemaVersion=N`, respectively. The caller is responsible for the declaration’s actual business meaning, public availability, applicability, and selection completeness.

Supports real, standard, self-contained 2020-12 JSON Schema, requiring root `type=object`, non-empty direct `$id`, `required` containing `schemaVersion`, and `properties.schemaVersion.const` as a positive safe integer. Parsing validity is verified via the public `Contracts` compilation entry point, rejecting asynchronous and external references, but allowing self-contained `#` references. A compiled cache entry differing from the current Schema content is insufficient. Callers must preserve cached validators and their schemas without mutation in the same process. Declaration comparison checks only the full `$id` and version number, without inferring from URN suffixes or requiring additional identity formats in the target.

Each binding requires `declaration` and may omit `implementation`. When supplied, `implementation` must contain `ref`, `dataLoad`, and `validation`. `ref` is the actual Python path; the other two are `{line, column}` positive safe integers selecting the unique starting point of actual direct assignment or validation statements. The full strict Python CST must be error-free, with a single top-level `main` having no parameters and the selected nodes directly in the same `try` Body. `dataLoad` is restricted to `dataLocal=json.loads(Path(args.input).read_text())`, where `args.input` denotes the caller’s actual direct argument name. `validation` is restricted to `jsonschema.Draft202012Validator(schemaLocal).validate(dataLocal)`. `schemaLocal` is derived from `schemaLocal=json.loads((root / "contracts/input.json").read_text())`, with `root` originating from `main` via `Path(__file__).resolve().parent.parent`. Variable names and example paths are illustrative; direct binding, import, and absence of write operations, aliases, or dynamic escapes must hold under limited premises.

JSON syntax decoding of data may occur before Schema loading. Each must complete prior to actual validation, and direct reading of `dataLocal["schemaVersion"]` at the header may precede validation. Direct reading of other business fields in the actual Schema `properties`, or embedding the entire data in the result, constitutes business interpretation. Classified business interpretation occurring before corresponding actual validation constitutes a finding. Using a different, already parsed Schema with distinct identity/version in the actual validator also constitutes a finding. Different local names loading the same actual file are permitted. Branching, looping, aliasing, rebinding, indirect calls, other compatible strategies, or paths/uses not classifiable result in only optional implementation insufficiency, with zero implementation comparison. This check does not prove general multi-version compatibility, arbitrary control flow, environment library authenticity, lossless transformation, or execution success.

The declaration independently compares the full identity and fixed version. Optional implementation checks three additional aspects: actual Schema file, same data binding, and validation preceding business interpretation. Returns the original `professional-conclusion`, with `provider.entry` set to `runFixedSchemaUseCheck`. `details.bindings` contains independent `declaration` and optional `implementation` per item, preserving `selection`, actual values, resource receipts, `comparisons`, `status`, `reason`, and respective `closure`. `scope.checked` lists only truly completed comparisons. Closures are based on actual dependencies, with overlapping shared resources and closure summaries cross-verified. Python missing, unsupported, or drifted only removes implementation; shared Schema drift removes actual dependency sub-checks. Full closure failure removes the participating item; unknown exceptions propagate. Observations are not atomic snapshots.

All completed with no findings yields `complete/ENGINEERING_CLEAR`. All completed with findings yields `complete/ENGINEERING_FINDINGS`. Comparison preserved but insufficient yields `partial`. A known finding yields `ENGINEERING_FINDINGS` even when another subcheck is insufficient. Otherwise the incomplete code is `ENGINEERING_CHECK_INCOMPLETE`. No comparison yields `not-performed/ENGINEERING_CHECK_INCOMPLETE`. Not selecting `implementation` does not constitute insufficiency. `readProfessionalProof` reads only the actual selected scope; domain applicability and full audit conclusion are the caller’s responsibility.

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

## Windows support and boundaries

Foundation 0.28.0 targets Windows 11 x64, local NTFS and ordinary users, with Contracts 1.21.0 and 56 registered objects. The three fixed-set-generation objects remain candidate, and other maturity registrations are unchanged. The official `skill-family-contracts@0.27.1` retains `contractsVersion=1.20.0` and 53 objects. Exact remote availability requires formal release evidence; this scope statement does not establish real-host qualification.

The four commands in `skill-family-engineering-kit` remain unchanged. Prebuilt `win32-x64` binaries are loaded without local compilation. Launch via the npm `bin/npm-cli.js` or pnpm `bin/pnpm.cjs` script, with exact version matching required. Real host qualification requires additional driver, version, authentication, and business evidence—local test results do not imply approval. See [API reference](https://ifoohoo.github.io/skill-family-engineering-kit/reference/api/harness/).

## Peer adapter professional conclusions

The runPeerAdapterCheck entry is introduced in version 0.36.0 and is not present in the published 0.35.0 release. An unpublished source candidate is used solely for authorized development verification and does not constitute formal publication. Formal consumption relies on the exact published version actually installed and its public API exports. This API produces a real mechanical professional conclusion for the joint consistency of peer adapter closures, based on a fixed-anchor, N−1 verification pattern. It is **not** a semantic review, nor does it validate Audit or SOURCE rules, execute targets or generators, verify platform metadata, or prove installation, loading, business execution, or release. These responsibilities remain separate.

The public API is:

`runPeerAdapterCheck({root, request, peerRoots})` from the `skill-family-engineering-kit` package root.

- `root` is a directory string representing the subject project root. It is resolved via the existing directory resolver into `subject.ref`, but is **not** treated as a peer root. No tree scanning is performed on `root`.
- `request` follows the existing `adapter-peer-verification-request` contract and explicitly selects 2 to 16 peers. The entire request, including nested mappings, is fully copied before the first `await`.
- `peerRoots` maps each unique `peerId` to a **canonical absolute path** representing the real, authoritative root of that peer under the existing filesystem binding contract. The caller owns authorization, selection completeness, and actual source/adapter relationships.

The API performs three phases in sequence:

1. **Pre-observation**: For each `peerRoot` in `peerRoots`, a single `createFilesystemRootBinding` and `observeFilesystemTree` call is made. This captures the binding and the full member list with `path`, `type`, `sha256`, `bytes`, and the relevant `statMode` or `permissionObservation` fields. No `contentBase64` or file content is copied. These observations are neither an atomic snapshot nor a historical baseline.
2. **N−1 anchored verification**: The peer IDs are sorted. The first peer is fixed as the anchor. For each of the remaining `N−1` peers, a single call to the original `verifyPeerAdapterDirectories` is made, using the anchor and the current peer. This is not a full pairwise comparison. A source conflict may short-circuit the call before mapping equality is compared; do not claim every internal comparison ran. A pair without its required pre-observations is not called and remains insufficient.
3. **Post-observation**: For each `peerRoot` that passed pre-observation, a second `observeFilesystemTree` is performed. This captures the final state for comparison with the pre-observation.

The actual successful manifest is only valid if it aligns with the observed pre-observation state and original bytes. Unavailable or changed observations, or a manifest mismatch, withdraw that pair from `checked` and invalidate its finding attribution. Keep the actual old call result or error available for diagnosis.

Only a **real, same-call SFC2004** with:
- `details.kind = "closure-conflict"`,
- `details.peerId` belonging to the current pair,
- and input, root, and observation data that correspond to the same call,
is considered a valid finding. Do not infer the conflict subtype by parsing message text. A schema-valid but incomplete, dangling, or missing mapping, a missing peer directory, or an unsafe, unreadable, or unsupported peer root is insufficient, not a closure finding.

The `outcome.completion` and `outcome.code` are independent fields, with exactly five conditions:

1. Every required pair validly completed, no finding: `completion` = `complete`; `code` = `ENGINEERING_CLEAR`.
2. Every required pair validly completed, a finding exists: `completion` = `complete`; `code` = `ENGINEERING_FINDINGS`.
3. A valid finding exists, another required pair is insufficient: `completion` = `partial`; `code` = `ENGINEERING_FINDINGS`.
4. No finding, not all required pairs completed, at least one valid completed pair: `completion` = `partial`; `code` = `ENGINEERING_CHECK_INCOMPLETE`.
5. No valid completed pair: `completion` = `not-performed`; `code` = `ENGINEERING_CHECK_INCOMPLETE`. Failed calls may already have occurred.

`scope.checked` contains only valid completed pairs: `pair:<anchor>:<peer>:equivalence`. Invalid global request structure, unknown fields, duplicate peer IDs, root key mismatch, or malformed root coordinates throw `SFC2003` before checking. They do not return `not-performed` or any professional conclusion. Unknown runtime errors propagate. External process termination does not promise an output file.

The returned `details` object retains:
- The original `selection` (request and peerRoots),
- Pre- and post-observation results,
- The actual result or exception from each `verifyPeerAdapterDirectories` call,
- The original `code`, `message`, and `details` from each call,
- The reason for `insufficient` cases.

The host saves the **original API return** exclusively in its authorized evidence directory and passes the saved proof to `readProfessionalProof`. The reader does not rerun the check or authenticate its author. No `proof-create` call may be used to fabricate a mechanical result. Combined semantic or other mechanical scopes retain their own originals.

The original `verifyPeerAdapterDirectories` and `verifyHostPeers` APIs, their verified result schema, fail-closed behavior, and reader algorithm remain unchanged. This API does not execute targets or generators, decide Audit or SOURCE rules, check independent common resources or platform metadata, or prove installation, loading, business execution, or release.

## Exact runtime artifacts and third-party licensing

For initial onboarding and later adoption, read the actual release configuration and the provider's generated-path declarations. Classify runtime artifacts, editable configuration and persistent tool locks separately. Use exact ignore entries such as `/.release-skill/runs/` only for adopted outputs. Keep `.release-skill/project.yaml` and `.release-skill/testing/requirements.json` as source, and persistent graph locks under `trackedToolLocks`. Maintain `.gitignore` through its existing source. Registering artifacts does not edit `.gitignore` or create output directories.

For an unregistered non-empty target, pass confirmed patterns through `check register-existing --artifacts`. For a target with valid registration and an undrifted lock, use `skill-family-kit check relock --root <target> --registration-class artifacts --files /.release-skill/runs/`, or the existing `runRelock` / `relockAction` APIs with `registrationClass: "artifacts"` and a non-empty `files` array. This mode accepts root-anchored literal files or directories ending in `/`, including future paths. It preserves other classes and lock metadata. Exact repeats validate drift, return `registered: []`, leave bytes and `lockVersion` unchanged and omit publication receipts. Escapes, symlinks, source/tool-lock overlap, uncertain separation from handwritten globs and managed drift are refused before writing. Partial publication failures retain their existing error and publication state.

Use the existing `--profiles-root` mechanism for confirmed original authors and adaptation contributors, preserving the `author` and `contributor` roles. CC-BY-NC-SA-4.0 requires `noticeRequired: true`. An unverified copyright year is explicitly `null`; MIT and Apache retain integer years. The complete CC legal text is preserved in LICENSE, and NOTICE retains each declared name, role and license reference. Contributors are not inferred to be copyright holders. Preserve existing source links, historical attribution and modification notices for human review. Identity checking reads the standard text and declared attribution without assessing legal applicability or fetching links. Confirm the new entry in the exact published SDK before adoption.
