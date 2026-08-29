<!-- release-skill:safe-first-command -->
<!-- release-skill:external-write-boundary -->

> English version: [README.md](./README.md)

# skill-family-engineering-kit

<!-- release-skill:release-version: 0.14.0 -->

开发与 CI 阶段使用的工程工具包。**恰好四个**顶层命令，没有第五个：

<!-- release-skill:managed:start id=latest-release -->
**0.14.0** (2026-08-28)

Engineering Kit 0.14.0 增加能力发现、迁移指引、消费者契约测试接线和显式资格检查入口。

**新增**

- 通过 `adopt-plan` 与 `list-capabilities` CLI 模式增加只读能力评估。
- 增加消费者契约测试脚手架指引，以及生成真实宿主证据的显式资格检查命令。

**变更**

- 明确区分候选发现、迁移完成、契约接入完成和真实宿主资格四种结论。

**升级说明**

三个 Foundation 包须一起精确锁定到 0.14.0。能力评估和迁移规划不写文件；契约向量与正式测试替身只证明接线；资格检查仍由消费者显式负责。
<!-- release-skill:managed:end id=latest-release -->

| 命令 | 用途 | 副作用 |
| --- | --- | --- |
| `scaffold` | 在空目录生成 Skill Family 项目骨架 | 只向空目标目录写入骨架文件（原子写、路径收容）；非空或冲突目标被拒绝且不被触碰 |
| `adopt-plan` | 严格只读地规划存量仓采用 | 无——不写任何文件（含临时文件），不运行 git 写命令；计划输出到 stdout |
| `projection` | 投影受管生成物 | 只写 manifest 授权且被目标声明为受管的路径；未授权、手写与越界路径一律拒绝（拒绝时零写入） |
| `check` | 契约/漂移/闭包/版本/文档事实/Git 前置状态诊断 | 无——只诊断、绝不自动修复；git 仅只读探测 |

## 解决的问题

工程阶段常出现两类风险：要么骨架各生成一套、投影各写一遍，导致结构漂移；要么诊断工具顺手「自动修复」，悄悄改动调用方的仓。Kit 把工程动作收敛成四个只读或受限写入的命令，让「生成、盘点、投影、诊断」都可复现、可审计，且绝不越界自动修改。

## 核心心智模型

Kit 是「工程阶段」层，依赖 Harness 与 Contracts。它只做四件事：为新项目生成精确骨架、对存量仓做只读采用盘点、把受管事实机械投影到目标、对工程不一致做只读诊断。`report` 与 `host` 是挂接在四个命令下的子动作，不改变「四命令」的边界。所有写动作都经 Harness 的原子收容写，失败不留半成品。

## 安装和最小示例

0.14.0 是本地候选版本。候选验证先把三个包分别打入同一个临时目录，再安装这三个精确 tarball：

```sh
pack_dir="$(mktemp -d)"
(cd packages/skill-family-contracts && pnpm pack --pack-destination "$pack_dir")
(cd packages/skill-family-harness-node && pnpm pack --pack-destination "$pack_dir")
(cd packages/skill-family-engineering-kit && pnpm pack --pack-destination "$pack_dir")
mkdir "$pack_dir/consumer" && (cd "$pack_dir/consumer" && npm init -y)
(cd "$pack_dir/consumer" && npm install "$pack_dir/skill-family-contracts-0.14.0.tgz" "$pack_dir/skill-family-harness-node-0.14.0.tgz" "$pack_dir/skill-family-engineering-kit-0.14.0.tgz")
```

发布后再使用 registry 坐标：

```sh
npm install --save-dev skill-family-engineering-kit@0.14.0
npm exec --package=skill-family-engineering-kit@0.14.0 -- skill-family-kit --help
npm exec --package=skill-family-engineering-kit@0.14.0 -- skill-family-kit scaffold --root <empty-dir> --project-id my-project
npm exec --package=skill-family-engineering-kit@0.14.0 -- skill-family-kit adopt-plan --root <repo> --list-capabilities --all --scope all --locale zh-CN --uses ./uses.json
npm exec --package=skill-family-engineering-kit@0.14.0 -- skill-family-kit projection --root <repo>
npm exec --package=skill-family-engineering-kit@0.14.0 -- skill-family-kit check --root <repo>
```

以上四条命令分别覆盖生成骨架、只读盘点、受管投影与诊断；零安装形式可用 `npm exec --package=skill-family-engineering-kit@0.14.0 -- skill-family-kit --help`。

### 三条采用旅程

新项目可以先评估全部用途，再选择稳定能力：

```sh
npm exec -- skill-family-kit adopt-plan --list-capabilities --all --scope all --locale zh-CN --uses ./uses.json
npm exec -- skill-family-kit scaffold --root ./my-project --project-id my-project --capability <stable-id>
```

存量项目先运行只读计划，再为每个已声明用途记录一项 decision：

```sh
npm exec -- skill-family-kit adopt-plan --root ./existing-repo
npm exec -- skill-family-kit adopt-plan --root ./existing-repo --list-capabilities --scope all --locale zh-CN
```

日常工作不必先知道 capability ID，可以直接查询单项需求：

```sh
npm exec -- skill-family-kit adopt-plan --list-capabilities --locale zh-CN --filter "写文件失败时不能留下残缺文件"
```

输出会区分候选（`supportedMatches`）、边界（`boundary-found`）和无文本命中（`no-text-match`）。迁移 `complete` 只覆盖迁移门禁；契约接入完成由消费者的适配器和领域测试证明。真实宿主资格是独立的显式动作：

```sh
npm exec -- skill-family-kit check qualification --root <consumer-repo> --capability foundation.kit.plugin-verification --request <request-json> --bindings <private-bindings-json> --native
```

资格命令要求完整的显式输入，预检通过后才可能调用能力特定宿主；候选发现或迁移完成不会自动变成资格结论。

### 公共 Profile SPI

`skill-family-engineering-kit/profile-spi` 子路径提供稳定的 Profile SPI v3 数据表面，导出 `verifyProfile`、`verifyProjectProfile`、`verifyAdoptionDigests`、`assessOverridesPolicy`、`loadSpiDefinition`、`loadExtendedDescriptorSchema`、`loadProjectProfileSchema` 与 `loadRuleBaselineCatalog`。adoption 与 overrides 的字段形状由 Contracts `profile-adoption-declaration` 唯一拥有；SPI 的 `profile-adoption.schema.json` 路径仅保留为兼容转发表。

包内携带三个 SPI JSON 资源与 Contracts canonical `profile-descriptor.schema.json`。`profiles/spi` 是唯一手写真源；projen 将这些资源和模块机械投影到该子路径。投影只修改两个公共包导入和一个本地 Schema URL。

`verifyProfile({ profileRoot })` 只读处理 Profile descriptor；项目根声明使用对应的 `verifyProjectProfile({ projectRoot, profileRelPath? })`。两个入口遇到无效输入都以稳定结果码失败关闭，不会执行 Profile 提供的文件；Profile 的领域含义仍由调用方负责。

provider Profile descriptor 从 Foundation 0.9.0 与 Contracts 1.9.0 升级到 Foundation 0.10.0 时，须把自身的 `base.contractsVersion` 字段更新为 `1.10.0`。Kit 四个顶层命令与 Profile SPI 的形状保持不变。

### 报告子动作

```sh
npm exec -- skill-family-kit projection report --root <repo> --model <report-model.json> --result <operation-result.json> --out <report.md> --binding <binding.json>
npm exec -- skill-family-kit check report --root <repo> --report <report.md> --model <report-model.json> --result <operation-result.json> --binding <binding.json>
```

调用方必须先构造合法 report model；Kit 不从开放的业务 `outputs` 推导事实。所有事实文本按字面转义，失败结果的完整 errors 必须出现在 model 和中性报告中。

### Candidate Quickstart 投影包

需要从显式消费者 Schema 与冻结来源身份生成确定性的 Quickstart Profile v2 投影时，使用 candidate 子路径：

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

`receipt` 与 `actualSubjects` 由调用方在 Kit 外取得。Contracts 先精确核对两者，既有 builder 再接收返回的 `sourceRepository` 与 `sourceBaseCommit`；Kit 不解析发布计划，也不发现来源权威。生成的 Bundle 按 Schema `$id` 选择 standalone validator，离线运行时不依赖 Foundation 包、`node_modules` 或 Ajv。provenance 绑定 Foundation 来源、消费者 Schema、payload 字节、工具版本，以及实际进入 Bundle 的代码许可证。

以上辅助函数不写文件，也不增加第五个顶层命令。调用方需要把返回的 `manifest` 交给稳定的 `runProjection` API。该能力仍是 **candidate**，必须精确锁定三个包。0.10.0 新增上面的规范入口；历史 `/candidate/quickstart-profile` 入口作为同源迁移别名继续可用。adoption 与 skill naming 也分别提供 `skill-family-engineering-kit/adoption` 和 `skill-family-engineering-kit/skill-naming` 规范入口。消费者迁移一次后，未来晋升 stable 不再二次迁移。仍依赖 v1 依赖闭包 Bundle 的接入必须继续精确锁定 `0.2.1`。

### 宿主子动作

```sh
npm exec -- skill-family-kit adopt-plan host-describe --host <id> --hosts-root <dir>
npm exec -- skill-family-kit adopt-plan host-probe --host <id> --hosts-root <dir>
npm exec -- skill-family-kit scaffold host-build --root <workspace> --host <id> --path-category <id> --input <relpath> --out <relpath> --hosts-root <dir>
npm exec -- skill-family-kit adopt-plan host-plan --root <workspace> --host <id> --path-category <id> --build-manifest <relpath> --probe-facts <relpath> --hosts-root <dir>
```

Profile 必须显式提供，Kit 不默认绑定具体宿主。规范宿主 ID 只能解析已登记有限 Profile 中声明的 alias。probe 默认不启动进程；只有同时给出 `--allow-host-spawn --host-executable <绝对路径>` 才执行冻结版本向量。本地 install/update 通过显式授权引用和既有受收容发布原语执行；uninstall 因没有安全的绑定删除原语而返回 `manual-recovery-required`，不删除文件。Claude/Codex 使用受信版本 driver；Kimi Code、WorkBuddy、CodeBuddy 和 DeepSeek Harness 只提供独立手动事实。Qoder 自 0.12.0 起为 `manual`，候选真实验证不授予生命周期能力。adapter source 只接受已声明的文本闭包，不支持二进制投影；精确宿主支持矩阵见 [宿主能力矩阵](../../docs/reference/host-capability-matrix.md) 与已登记 Profile。

### 候选真实宿主验证 API

`runHostVerification({ request, bindings, hostsRoot })` 使用固定内置驱动执行一次受约束验证，返回经过 Contracts 校验和脱敏的四态结果。五个驱动覆盖 Kimi、WorkBuddy、Claude Code、Codex exec 和 Qoder CLI，均复用 `existing-user-state + host-managed` 登录态。`verifyHostVerificationBindings({ results, expectedCommon, expectedRequestDigestByHost })` 只组合校验 `observed` 结果，公共字段与请求摘要必须匹配调用方预期。两者都是库 API，不增加第五个 Kit 命令。

调用方保留工作负载、领域输出检查、领域 PASS/FAIL、发布新鲜度和发布状态。规范路径 `existingUserStateRoot` 仅投影到子进程环境，Foundation 自身不读取、摘要、修改或清理其中内容，也不授予手动宿主生命周期能力。0.12.0 发布前须完成五个固定驱动的真实验证，发布决定不归该 API。

`executableSha256` 只绑定启动前严格读取的字节，进程仍按路径启动；调用方须在版本观察和执行期间独占可执行文件命名空间。Foundation 保留 `session-*` 目录，调用方检查后清理独占的外层 `temporaryRoot`。

## 典型使用场景

- 新项目骨架：`scaffold`（不覆盖非空存量仓）。
- 存量采用盘点：`adopt-plan`（严格只读，不写文件、不自动迁移）。
- 受管投影：`projection` + Profile（不覆盖 handwritten 文件）。
- 工程诊断：`check`（只诊断不修复，`--only` 缩小范围）。

## 边界机制

- `scaffold` 的目标必须是**空目录**（任何条目含点文件都算非空），或其父目录已存在的不存在路径（只创建最后一级）。全部写入经 harness 的原子收容写（`writeFileAtomic`），失败不留半成品，路径不能越出目标根。
- `adopt-plan` 结构性只读：实现中不存在任何写调用，连临时文件都不产生；计划字节与 `scaffold` 同源（`describeSkeletonFiles` 单一事实源），因此「计划即动作」。dirty 仓运行前后字节级零变化。
- `projection` 采用两阶段执行：先对每个条目做路径分类、收容预检、自投影检查、manifest 授权检查、手写保护与冲突守卫；任一条目违规则整体拒绝、零写入。覆盖既有文件必须声明精确的 `expect.sha256` 前置状态；内容相同的既有文件是幂等 no-op。写入失败时尽力还原已覆盖文件的前置字节。
- `check` 只诊断：无写调用、无 `--fix/--apply/--repair` 模式（此类标志在入口处被拒绝）。Git 前置状态仅用文件系统事实加至多一次冻结参数矢量的只读 `git status --porcelain=2`（`--no-optional-locks` + `GIT_OPTIONAL_LOCKS=0`，不刷新索引）。

## 错误码与退出码

错误码复用 contracts 冻结的 SFC\* 体系，不新增码：

- `SFC2002`（UNKNOWN_OPERATION）——入口收到四命令词表之外的命令名；
- `SFC2003`（INVALID_PARAMS）——选项/参数值违规，或请求 `--fix` 等不存在的变更模式；
- `SFC2004`（EXECUTION_FAILED）——执行期失败，`details.kind` 为稳定的 kit 级 kind（如 `target-not-empty`、`unauthorized-path`、`handwritten-overwrite`、`conflict-drift`）；harness 抛出的收容类 kind（`path-traversal`、`symlink-escape` 等）原样透传；
- `SFC1001`（SCHEMA_VALIDATION_FAILED）——`check` 发现的合同文档未通过注册 Schema。

进程退出码：`0` 成功/无发现；`1` check 有发现；`2` 拒绝/用法/机制错误。

## 目标工作区文档约定

- `skill-family.project-manifest.json` —— contracts 的 project-manifest 实例（项目身份与 managedFiles 声明）；
- `skill-family.managed-file-lock.json` —— contracts 的 managed-file-lock 实例（受管路径与内容哈希锁定）；
- `skill-family.projection.json` —— projection 的授权 manifest（kit 级文档）。

projection 只写同时满足两个条件的路径：manifest 列出，且目标自身的登记（file-registry / project-manifest managedFiles / managed-file-lock）声明为受管。匹配手写模式的路径永不写入，即使有受管声明也拒绝。

## 禁止项

本包不得执行 git init、commit、push、tag、stash、分支切换、发布、删除、远端写入或发布状态复述；不实现第五个顶层命令；不做业务判断、模型调用、远程网络。

## 故障诊断

`check` 退出码 1 表示有发现，退出码 2 表示用法或机制错误。如失败，确认目标仓库存在且 `skill-family.project-manifest.json` 形状合法；路径越界或手写保护触发时命令会拒绝写入并报告 `SFC2004`。

## 深入文档入口

- 架构边界与路由：[架构说明](https://ifoohoo.github.io/skill-family-engineering-kit/architecture/)、[智能体架构路由](https://ifoohoo.github.io/skill-family-engineering-kit/agents/architecture-routing/)
- 能力目录：[capability-catalog.json](https://ifoohoo.github.io/skill-family-engineering-kit/agents/capability-catalog.json)
- 采用与迁移：[迁移指南](https://ifoohoo.github.io/skill-family-engineering-kit/migration/)
- 副作用矩阵：[失败与副作用矩阵](https://ifoohoo.github.io/skill-family-engineering-kit/reference/failure-and-side-effect-matrix/)

<!-- agent-quick-reference:start -->
## Agent Quick Reference

### Use when

- 需要生成新项目骨架、对存量仓做只读采用盘点、受管投影或工程诊断。
- 需要从已渲染 model 产出报告文本，或对报告做分级检查。
- 需要为锁定精确版本的 Quickstart candidate 试验生成确定、自包含的投影 manifest。

### Do not use when

- 需要自动修复（`check` 不修复）、自动迁移（`adopt-plan` 不写文件）。
- 需要远端宿主发布、自动信任、删除式 uninstall 或 Qoder 完整 driver（明确 unsupported）。
- 需要稳定 Quickstart API，或希望 candidate 辅助函数绕过 `runProjection` 授权。

### Capability selection

- `foundation.kit.scaffold`：空目录生成精确骨架，原子 + 收容。
- `foundation.kit.adopt-plan`：存量仓严格只读盘点与完成判定。
- `foundation.kit.projection`：受管投影，全校验后才写，失败零写。
- `foundation.kit.check`：九类检查只诊断不修复。
- `foundation.kit.report`：projection/check report 子动作编排。
- `foundation.kit.git-probe`：只读白名单 Git 状态探测。
- `foundation.kit.host`：有限身份解析、describe/build/probe/plan，以及受授权的本地 install/update；删除式 uninstall 和远端 apply 稳定拒绝。
- `verifyHostPeers` 是 Harness 同级适配器验证的薄只读宿主入口，不写入 peer 目录，也不增加第五个顶层命令。
- `foundation.kit.licensing`：Profile 授权数据加载与生成。
- `foundation.kit.identity-check`：身份漂移与 Profile 一致性检查。
- `foundation.kit.cli`：四命令分派与变更旗标入口拒绝。
- `foundation.kit.quickstart-profile-candidate`：锁定精确版本后构建确定的 Quickstart 投影 manifest 包。

### Required inputs

- 目标根（scaffold 需空目录；adopt-plan/projection/check 需可访问仓）。
- Profile 标识（host 子动作必须显式提供）。

### Outputs and evidence

- 骨架文件、采用分类/完成判定、投影文件、发现清单、报告文本。
- 证据：`packages/skill-family-engineering-kit/test/scaffold.test.mjs`、`adopt-plan.test.mjs`、`projection.test.mjs`、`check.test.mjs`、`host.test.mjs`、`git-probe.test.mjs`。

### Side effects

- scaffold/projection/host-build 在受收容目标写文件（原子 + 收容）。
- adopt-plan 与 check 严格只读，git 仅只读白名单探测。
- `FORBIDDEN_SIDE_EFFECTS` 含 git-init/commit/push/tag、publish、remote-write。

### Failure semantics

- `SFC2002/2003/2004/1001` 等稳定错误码；退出码 0/1/2。
- check 发现退出码 1，机制/用法错误退出码 2。

### Architectural invariants

- 顶层命令固定 4 个，不扩张；`REFUSED_MUTATION_FLAGS` 在 CLI 入口即拒。
- 只诊断不修复，只投影不覆盖 handwritten。

### Route elsewhere when

- 远端发布：转 release-skill。
- 远端 host apply、自动信任与删除式 uninstall：明确 unsupported；本地 install/update 仅限已登记计划。
- 业务状态机/迁移执行：留在调用方或后续版本。

### Machine-readable sources

- 公开能力目录：[`capability-catalog.json`](https://ifoohoo.github.io/skill-family-engineering-kit/agents/capability-catalog.json)（`foundation.kit.*` 条目）。
- 包内源：`src/*.mjs`。
- 包内 Candidate 源：`candidate/*`；规范公共导入：`skill-family-engineering-kit/quickstart-profile`、`/adoption` 与 `/skill-naming`；历史迁移别名：`skill-family-engineering-kit/candidate/quickstart-profile`。
<!-- agent-quick-reference:end -->

## 完整插件候选能力

新增候选 runPluginVerification({ request, bindings, hostsRoot })，保留完整插件布局并分别报告安装、发现与调用事实。真实宿主与来源组合仍需独立资格证据。

0.14.0 为本地源码候选，尚未发布。消费本地已验证的三包 tarball；版本标记、单元测试或安装成功都不等于契约接入完成、迁移完成或真实宿主资格。
