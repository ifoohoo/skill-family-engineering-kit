<!-- release-skill:safe-first-command -->
<!-- release-skill:external-write-boundary -->

> English version: [README.md](./README.md)

# skill-family-engineering-kit

<!-- release-skill:release-version: 0.8.3 -->

开发与 CI 阶段使用的工程工具包。**恰好四个**顶层命令，没有第五个：

<!-- release-skill:managed:start id=latest-release -->
**0.8.3** (2026-08-23)

随 Foundation 0.8.3 锁步升版；受管 Bundle 携带 Harness 的有界路径收容修复。

**变更**

- 包版本与 Contracts、Harness 一同升至 0.8.3；Kit 的四个稳定顶层命令与 Profile SPI 均保持不变。
- 重建受管 Bundle 会投影更新后的 Harness paths 模块，包括仅一次 ENOENT 锚点重求和保持不变的失败关闭边界。

**升级说明**

消费者必须把 Contracts、Harness 和 Engineering Kit 精确锁定到 0.8.3，再重建受管 Bundle；无需迁移 Kit API 或 Profile SPI。
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

```sh
npm install --save-dev skill-family-engineering-kit@0.8.3
npm exec -- skill-family-kit --help
npm exec -- skill-family-kit scaffold --root <empty-dir> --project-id my-project
npm exec -- skill-family-kit adopt-plan --root <repo>
npm exec -- skill-family-kit projection --root <repo>
npm exec -- skill-family-kit check --root <repo>
```

以上四条命令分别覆盖生成骨架、只读盘点、受管投影与诊断；零安装形式可用 `npm exec --package=skill-family-engineering-kit@0.8.3 -- skill-family-kit --help`。

### 公共 Profile SPI

`skill-family-engineering-kit/profile-spi` 子路径提供稳定的 Profile SPI v3 数据表面，导出 `verifyProfile`、`verifyProjectProfile`、`verifyAdoptionDigests`、`assessOverridesPolicy`、`loadSpiDefinition`、`loadExtendedDescriptorSchema`、`loadProjectProfileSchema` 与 `loadRuleBaselineCatalog`。adoption 与 overrides 的字段形状由 Contracts `profile-adoption-declaration` 唯一拥有；SPI 的 `profile-adoption.schema.json` 路径仅保留为兼容转发表。

包内携带三个 SPI JSON 资源与 Contracts canonical `profile-descriptor.schema.json`。`profiles/spi` 是唯一手写真源；projen 将这些资源和模块机械投影到该子路径。投影只修改两个公共包导入和一个本地 Schema URL。

`verifyProfile({ profileRoot })` 只读处理 Profile descriptor；项目根声明使用对应的 `verifyProjectProfile({ projectRoot, profileRelPath? })`。两个入口遇到无效输入都以稳定结果码失败关闭，不会执行 Profile 提供的文件；Profile 的领域含义仍由调用方负责。

### 报告子动作

```sh
npm exec -- skill-family-kit projection report --root <repo> --model <report-model.json> --result <operation-result.json> --out <report.md> --binding <binding.json>
npm exec -- skill-family-kit check report --root <repo> --report <report.md> --model <report-model.json> --result <operation-result.json> --binding <binding.json>
```

调用方必须先构造合法 report model；Kit 不从开放的业务 `outputs` 推导事实。所有事实文本按字面转义，失败结果的完整 errors 必须出现在 model 和中性报告中。

### Candidate Quickstart 投影包

需要从显式消费者 Schema 与冻结来源身份生成确定性的 Quickstart Profile v2 投影时，使用 candidate 子路径：

```js
import {
  buildQuickstartProfileProjection,
  QUICKSTART_PROFILE_TARGET_PREFIX,
} from "skill-family-engineering-kit/candidate/quickstart-profile";
```

生成的 Bundle 按 Schema `$id` 选择 standalone validator，离线运行时不依赖 Foundation 包、`node_modules` 或 Ajv。provenance 绑定 Foundation 来源、消费者 Schema、payload 字节、工具版本，以及实际进入 Bundle 的代码许可证。

以上辅助函数不写文件，也不增加第五个顶层命令。调用方需要把返回的 `manifest` 交给稳定的 `runProjection` API。该子路径公开但**不稳定**；使用 v2 时应精确锁定 `0.4.0`，仍依赖 v1 依赖闭包 Bundle 的接入必须继续精确锁定 `0.2.1`。

### 宿主子动作

```sh
npm exec -- skill-family-kit adopt-plan host-describe --host <id> --hosts-root <dir>
npm exec -- skill-family-kit adopt-plan host-probe --host <id> --hosts-root <dir>
npm exec -- skill-family-kit scaffold host-build --root <workspace> --host <id> --path-category <id> --input <relpath> --out <relpath> --hosts-root <dir>
npm exec -- skill-family-kit adopt-plan host-plan --root <workspace> --host <id> --path-category <id> --build-manifest <relpath> --probe-facts <relpath> --hosts-root <dir>
```

Profile 必须显式提供，Kit 不默认绑定具体宿主。probe 默认不启动进程；只有同时给出 `--allow-host-spawn --host-executable <绝对路径>` 才执行冻结版本向量。`host-apply` 稳定拒绝，未实现安装、更新或卸载。Codex 的技能目标路径固定为 `.agents/skills`；其他受支持宿主只按已登记 Profile 提供；Qoder 为 `unsupported`，本版只参考其结构，不提供完整 driver，也不声称已在 Qoder 运行。adapter source 只接受已声明的文本闭包，不支持二进制投影；精确宿主支持矩阵见本版本 CHANGELOG 与已登记 Profile。

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
- 需要 host apply/install/update/uninstall 或 Qoder 完整 driver（明确 unsupported）。
- 需要稳定 Quickstart API，或希望 candidate 辅助函数绕过 `runProjection` 授权。

### Capability selection

- `foundation.kit.scaffold`：空目录生成精确骨架，原子 + 收容。
- `foundation.kit.adopt-plan`：存量仓严格只读盘点与完成判定。
- `foundation.kit.projection`：受管投影，全校验后才写，失败零写。
- `foundation.kit.check`：九类检查只诊断不修复。
- `foundation.kit.report`：projection/check report 子动作编排。
- `foundation.kit.git-probe`：只读白名单 Git 状态探测。
- `foundation.kit.host`：describe/build/probe/plan，apply 稳定拒绝。
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
- host apply/install/update/uninstall：明确 unsupported。
- 业务状态机/迁移执行：留在调用方或后续版本。

### Machine-readable sources

- 公开能力目录：[`capability-catalog.json`](https://ifoohoo.github.io/skill-family-engineering-kit/agents/capability-catalog.json)（`foundation.kit.*` 条目）。
- 包内源：`src/*.mjs`。
- 包内 Candidate 源：`candidate/*`；公共导入：`skill-family-engineering-kit/candidate/quickstart-profile`。
<!-- agent-quick-reference:end -->
