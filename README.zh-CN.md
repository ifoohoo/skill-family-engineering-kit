<!-- release-skill:safe-first-command -->
<!-- release-skill:external-write-boundary -->

> English version: [README.md](./README.md)

# skill-family-engineering-kit

<!-- release-skill:release-version: 0.24.0 -->

开发与 CI 阶段使用的工程工具包。**恰好四个**顶层命令，没有第五个：

<!-- release-skill:managed:start id=latest-release -->
**0.24.0** (2026-10-07)

Engineering Kit 0.24.0 在既有 `check relock` 事务中增加显式的持久工具锁登记能力，四个顶层命令仍为 `scaffold`、`adopt-plan`、`projection`、`check`。本说明记录本地锁步候选状态，不表示远端发布或真实消费者采用已完成。

**变更**

- `registrationClass` 为 API 参数，仅接受 `handwritten` 或 `trackedToolLocks`；CLI 对应参数为 `--registration-class`。默认值保持为 `handwritten`；在默认手写模式下，文件清单为空或缺省时，原自动发现行为维持不变。
- 使用 `trackedToolLocks` 时必须提供非空显式 `files` 清单，CLI 通过 `--files` 指定。每个路径必须指向目标内已存在的普通文件，不支持自动发现工具锁，也不根据文件名或内容推断工具语义。
- 若原事务中 `classes.trackedToolLocks` 缺省，则在首次写入前初始化其 `entries` 数组，并追加明确指定的路径；若已有类别非合法对象，或 `entries` 非数组类型，则在首写前拒绝操作。其他类别保持不变。
- 仅更新 `.foundation/file-registry.json` 与 `skill-family.managed-file-lock.json` 两份状态文件。工具锁内容不进入受管摘要，后续由原工具刷新内容不会因此引发受管漂移；路径、符号链接、已登记路径、状态文档及既有受管漂移的拒绝规则继续有效。中途发布失败时仍暴露原始 `publicationState`，不承诺双文件原子回滚。
- 包版本与其他三单元同步前移至 0.24.0。Contracts 规格仍为 1.20.0，未新增合同对象、Harness 机制或报告种类；0.23.1 中仅锁步前移的历史说明保持原样。

**升级说明**

三个 Foundation npm 包须精确锁定至 0.24.0 版本。新登记模式仅属本轮候选，非 0.23.0 已发布能力；实际采用以对应版本公开接口为准。完整消费者、初始化及发布资格仍待验证。
<!-- release-skill:managed:end id=latest-release -->

## 本地未发布治理检查

当前工作树在既有 `check` 命令下增加显式 `declared` 政策。版本检查只读取
`skill-family.project-manifest.json` 声明的发行单元及其文本或 JSON 版本引用；入口检查只读取
声明的物理文件。两个分支都不运行目标脚本、Skill、hook、模型，也不先跑未选择的 legacy 检查。

`runChecks` 与 `runEntryContractCheck` 仍然只读。只有既有 `runCommand("check")` 和
`checkEntriesAction` 包装入口可以创建一份 `professional-conclusion` 文件，而且调用方必须同时
给出已存在输出根与根内相对路径。写入采用独占创建，不建父目录、不覆盖现有条目。这组实现随
0.22.0 制品发布；此前已发布的 0.21.0 制品不包含它。

### Foundation 0.15.0 candidate 资格入口

本候选版本增加两个固定资格入口：`foundation.kit.plugin-verification` 接入 Qoder 与 WorkBuddy 的 native-lifecycle 分支，`foundation.kit.skill-family-directory-verification` 接入 Kimi 目录分支。Qoder 与 WorkBuddy 各有一个生产 driver，各自确定 argv 计划，共用十二个有序语义阶段；每次 spawn 前重新观察可执行文件身份。Contracts 只校验闭合阶段结构、顺序与停止传播。

`runSkillFamilyDirectoryVerification({ request, bindings })` 负责启动本地 Kimi 进程，固定使用 `-p <prompt> --output-format stream-json --skills-dir <family-root>`，投影窄环境，并把原始输出写入私有证据根。调用方提供的 observation 会被拒绝。当前没有官方 typed observation 映射，因此即使受控 fixture stream 已证明 parser 接线，结果仍保持 `indeterminate`，原因为 `official-observation-unavailable`。

消费者绑定可执行文件、目录、来源、工作负载与领域事实，由 Kit 启动有界本地进程。不得复制通用 runner、walker、native addon、Schema、Registry、Oracle、cache、状态机或 receipt 链。受控 fixture 协议是 Foundation 自有的隔离证据，不是 Qoder、WorkBuddy 或 Kimi 的厂商 grammar，也不是真实宿主资格。Harness record 模式适用于稳定隔离树；best-effort 边界不承诺事务快照、同 UID 恶意并发或 ABA 安全。

Foundation 本身不发起网络请求，但绑定的 executable 仍可能联网。Foundation 不提供 sandbox 或 egress 阻断，调用方与运行环境负责隔离。Qoder、WorkBuddy 与 Kimi 仍为 `manual/candidate`，受控 fixture 不授予真实宿主资格。

| 命令 | 用途 | 副作用 |
| --- | --- | --- |
| `scaffold` | 在空目录生成 Skill Family 项目骨架 | 只向空目标目录写入骨架文件（原子写、路径收容）；非空或冲突目标被拒绝且不被触碰 |
| `adopt-plan` | 严格只读地规划存量仓采用 | 无——不写任何文件（含临时文件）；默认可能启动一条冻结参数的只读 Git status 探测；`--no-git-spawn` 可关闭；不运行 Git 写命令；计划输出到 stdout |
| `projection` | 投影受管生成物 | 只写 manifest 授权且被目标声明为受管的路径；未授权、手写与越界路径一律拒绝（拒绝时零写入） |
| `check` | 契约/漂移/闭包/版本/文档事实/Git 前置状态诊断 | 普通诊断只读且不写文件；默认可能启动一条冻结参数的只读 Git status 探测；`--no-git-spawn` 可关闭；`check relock` 是显式受控写事务；`check qualification` 预检通过后可能启动绑定的 executable。Foundation 自身不发起网络请求，但该进程可能联网。 |

## 解决的问题

工程阶段常出现两类风险：要么骨架各生成一套、投影各写一遍，导致结构漂移；要么诊断工具顺手「自动修复」，悄悄改动调用方的仓。Kit 把工程动作收敛成四个只读或受限写入的命令，让「生成、盘点、投影、诊断」都可复现、可审计，且绝不越界自动修改。

## 核心心智模型

Kit 是「工程阶段」层，依赖 Harness 与 Contracts。它只做四件事：为新项目生成精确骨架、对存量仓做只读采用盘点、把受管事实机械投影到目标、对工程不一致做只读诊断。`report` 与 `host` 是挂接在四个命令下的子动作，不改变「四命令」的边界。所有写动作都经 Harness 的原子收容写，失败不留半成品。

## 安装和最小示例

0.23.1 是尚未正式发布的本地源码候选；0.23.0 是已发布包。候选验证先把三个包分别打入同一个临时目录，再安装这三个精确 tarball：

```sh
pack_dir="$(mktemp -d)"
(cd packages/skill-family-contracts && pnpm pack --pack-destination "$pack_dir")
(cd packages/skill-family-harness-node && pnpm pack --pack-destination "$pack_dir")
(cd packages/skill-family-engineering-kit && pnpm pack --pack-destination "$pack_dir")
mkdir "$pack_dir/consumer" && (cd "$pack_dir/consumer" && npm init -y)
(cd "$pack_dir/consumer" && npm install "$pack_dir/skill-family-contracts-0.23.1.tgz" "$pack_dir/skill-family-harness-node-0.23.1.tgz" "$pack_dir/skill-family-engineering-kit-0.23.1.tgz")
```

0.23.1 正式发布后，再使用对应的 registry 坐标：

```sh
npm install --save-dev skill-family-engineering-kit@0.23.1
npm exec --package=skill-family-engineering-kit@0.23.1 -- skill-family-kit --help
npm exec --package=skill-family-engineering-kit@0.23.1 -- skill-family-kit scaffold --root <empty-dir> --project-id my-project
npm exec --package=skill-family-engineering-kit@0.23.1 -- skill-family-kit adopt-plan --root <repo> --list-capabilities --all --scope all --locale zh-CN --uses ./uses.json
npm exec --package=skill-family-engineering-kit@0.23.1 -- skill-family-kit projection --root <repo>
npm exec --package=skill-family-engineering-kit@0.23.1 -- skill-family-kit check --root <repo>
```

以上四条命令分别覆盖生成骨架、只读盘点、受管投影与诊断；零安装形式可用 `npm exec --package=skill-family-engineering-kit@0.23.1 -- skill-family-kit --help`。

### 本地 0.24.0 候选的工程声明调用

可选 `engineering` 参数已在本地 `0.24.0` 候选中实现，正式 `0.23.0` 不支持。使用已选 SDK 前，核对其实际公共接口与三个 Foundation 包的精确锁步来源；候选验证与正式发布后采用分别报告。省略参数保持既有字节和路径；`null`、`{}`、未知字段和非法引用拒绝。无需另建声明输入文件。

`engineering` 由调用方依据真实业务入口和发行单元构造。`entries` 每项包含 `name`、`form`、`physicalRef`；`form` 仅为 `skill_md` 或 `file`，前者必须指向 `SKILL.md`。`releaseUnits` 每项包含 `id`、`versionSource`，可选 `versionMirrors`。`versionSource` 为文本或 JSON 引用对象，`versionMirrors` 为引用数组。文本版本引用使用 `path` 和 `format: "text"`；JSON 引用使用 `path`、`format: "json"` 与非空 `jsonPointer`。版本取自真实业务版本源，不取私有骨架示例包、SDK 或 Profile 版本，不因 `package.json` 存在推导 npm 分发。

下例变量由调用方提供；`engineering` 是完整已确认的声明，不是默认示例答案：

```js
import { describeSkeletonFiles, scaffoldTarget, planAdoption, runProjection } from "skill-family-engineering-kit";

const skeleton = await describeSkeletonFiles({ ...inputs, engineering });
const generated = await scaffoldTarget({ ...options, engineering });
const plan = await planAdoption({ ...options, engineering, allowGitSpawn: false });
const updated = await runProjection({ root: targetRoot, engineering });
```

这些调用用于不同目标状态，不能按示例次序对同一目标全跑。空目标由 `scaffoldTarget` 通过同一骨架生成器和原受管锁派生声明与清单摘要；只检查合同和根内路径形态，可引用业务作者稍后创建的文件，不确认文件已存在，也不代写领域内容。非空目标由 `planAdoption` 预测与 `scaffold` 相同的声明字节，保持严格只读，连临时文件也不写；`allowGitSpawn: false` 关闭原只读 Git 探测。`writeSet`、`conflicts` 和 `complete` 不授权执行，也不证明业务资格。

现有受管项目使用 `runProjection({ root: targetRoot, engineering })` 完整替换整个 `engineering`，不做深合并。完整已确认对象须保留仍需使用的旧 `entries` 和 `releaseUnits`。不能与 `manifest`、`candidateRoot` 或 `preparedProjection` 同传。目标须为现有普通根，具备有效普通 registry、项目清单和受管锁；清单与锁已由 registry 及 `managedFiles` 声明受管，清单锁条目由 Engineering Kit 拥有。其他受管文件须匹配原锁，没有缺覆盖、重复或未拥有的锁条目。每个业务入口与版本引用须指向根内现存普通文件。前提缺失只表示本更新不可执行，不自动接管任意非空项目。

合法更新只写 `skill-family.project-manifest.json` 和 `skill-family.managed-file-lock.json`，保留非 `engineering` 字段、registry 与其他文件字节、其他锁条目、生成器身份、版本、`lockVersion` 和文件 mode。清单摘要由原生成器派生，同内容幂等。结果沿用 `schemaVersion: 2` 的 `skill-family.projection-receipt`；内存候选的 `candidate.root` 与 `manifest.location` 为 `null`。原 v1/v2 和 prepared 投影保护保留，不手写清单或锁候选掩盖漂移。

三个原 CLI 命令接受 `--engineering <JSON>`：

```text
skill-family-kit scaffold --root <target> --project-id <id> --profile generic --licensing-profile <licensing-id> --engineering <JSON>
skill-family-kit adopt-plan --root <target> --project-id <id> --profile <profile-id> --licensing-profile <licensing-id> --no-git-spawn --engineering <JSON>
skill-family-kit projection --root <target> --engineering <JSON>
```

`<JSON>` 是工程对象的 JSON 字符串，不是文件路径，须以 shell 引号作为一个参数传入。`--engineering` 与 `--engineering-baseline` 独立，后者仍须与 `--compare-skeleton` 成对；能力目录查询不能混入工程声明。四个顶层命令边界保留。

事实未齐时具体报告缺项。可以只声明 `entries` 或只声明 `releaseUnits`，但未声明的另一检查分支仍为 `incomplete`。待真实业务和版本文件存在后，使用官方受管更新及既有 core、declared 版本、declared 入口检查。生成、只读计划、静态检查、正式宿主发现、真实业务、独立语义审阅与整体资格分别报告；省略参数保留旧行为，不表示声明已完成。

本地 0.24.0 候选对公开 `runCoreCheck` 作一项窄行为修复：目标真实声明 `engineering.releaseUnits` 时，版本类复用已有声明式版本读取逻辑，依据 `versionSource` 与 `versionMirrors` 检查文本或 JSON 格式的版本信息；私有工程的 `package.json` 不自动成为该业务单元的版本源或镜像，仅当被显式声明时方可参与版本认定。对于真正未声明版本、或仅包含合法 `entries` 的目标，仍沿用原有 legacy 版本检查路径。非法或重复的声明不回退为通过；声明的版本源或镜像缺失、不可读时如实失败。

核心调度机制保持不变，共用原九类循环与报告流程，保留 Contracts 规格版本一致性检查及其他八类校验。声明的来源、镜像及各祖先路径均需先通过原树枚举与 `lstat` 安全预检，包括原不展开的工具目录；仅探查声明所涉路径，不引入新的目录遍历器。符号链接、FIFO 及其他不安全读集仍按原规则拒绝访问，禁止穿过根内符号链接目录；`completed`、`mechanism` 与 0/1/2 退出码如实传播。

本次变更仅限于公开 core 在已声明版本目标上的适用性调整：公共 `runChecks` 缺省行为仍等同于显式 `policy: "legacy"`，涵盖原版本发现及 `full`/`only` 等价逻辑；显式 `policy: "declared"` 仍仅允许 `only: "version"`，维持原报告形式、不执行目标代码、不调用 Git 的边界。未新增任何公共 policy 值、API、CLI 参数、Schema 定义或包根导出，亦不在目标生成 shim 中复制检查逻辑。候选实现与局部验证不构成正式发布、业务资格或整体初始化完成的证明。

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

Profile 必须显式提供，Kit 不默认绑定具体宿主。规范宿主 ID 只能解析已登记有限 Profile 中声明的 alias。probe 默认不启动进程；只有同时给出 `--allow-host-spawn --host-executable <绝对路径>` 才执行冻结版本向量。本地 install/update 通过显式授权引用和既有受收容发布原语执行；uninstall 因没有安全的绑定删除原语而返回 `manual-recovery-required`，不删除文件。Claude/Codex 使用受信版本 driver；Kimi Code、WorkBuddy、CodeBuddy 和 DeepSeek Harness 只提供独立手动事实。Qoder 仍为 `manual`；独立的原生插件候选不授予通用 host build、plan、apply、install/update/uninstall、rollback 或真实宿主资格。adapter source 只接受已声明的文本闭包，不支持二进制投影；精确宿主支持矩阵见 [宿主能力矩阵](../../docs/reference/host-capability-matrix.md) 与已登记 Profile。

### 候选真实宿主验证 API

`runHostVerification({ request, bindings, hostsRoot })` 使用固定内置驱动执行一次受约束验证，返回经过 Contracts 校验和脱敏的四态结果。五个驱动覆盖 Kimi、WorkBuddy、Claude Code、Codex exec 和 Qoder CLI，均复用 `existing-user-state + host-managed` 登录态。`verifyHostVerificationBindings({ results, expectedCommon, expectedRequestDigestByHost })` 只组合校验 `observed` 结果，公共字段与请求摘要必须匹配调用方预期。两者都是库 API，不增加第五个 Kit 命令。

调用方保留工作负载、领域输出检查、领域 PASS/FAIL、发布新鲜度和发布状态。规范路径 `existingUserStateRoot` 仅投影到子进程环境，Foundation 自身不读取、摘要、修改或清理其中内容，也不授予手动宿主生命周期能力。0.12.0 发布前须完成五个固定驱动的真实验证，发布决定不归该 API。

`executableSha256` 只绑定启动前严格读取的字节，进程仍按路径启动；调用方须在版本观察和执行期间独占可执行文件命名空间。Foundation 保留 `session-*` 目录，调用方检查后清理独占的外层 `temporaryRoot`。

#### 0.21.0 候选：准备 Cursor 调用

`prepareHostVerification` 已随 0.21.0 发布，并在 0.22.0 中继续可用。它只为 `cursor` 准备单个已声明 Skill，使用随包 Descriptor（宿主描述符）和固定 `cursor-agent-print-v1` 驱动，不接受自定义驱动、参数、模型覆盖、凭据处理或领域验证器。原有七驱动的 `runHostVerification` 入口保持兼容。

下例变量由调用方提供，文档和夹具内容为不透明的 UTF-8 字符串或 Buffer。`skillMembers` 必须包含 `SKILL.md`，安装只覆盖声明成员。各根目录须已存在，并使用规范绝对路径；`sessionRoot` 必须为空且由调用方独占，工作区必须位于 `repositoryRoot` 内，也允许两者相等。调用方授权使用现有用户状态根，并独占可执行文件命名空间。

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

准备阶段复制输入字节、计算摘要并冻结请求与私有绑定。它在限定目录内写入文档、补齐缺失的 `.cursor/skills` 父目录，不启动进程，也不安装 Skill。执行阶段重新校验绑定，安装后的 Skill 摘要必须在任何探测前通过比较。字段错误、Schema 校验失败和机制失败分别沿用 `SFC2003`、`SFC1001`、`SFC2004`；准备过程的机制失败可能留下部分文件。

`readInvocationStream(result, "stdout" | "stderr")` 校验结果、请求绑定、准备时捕获的证据根、流摘要和字节数后返回 Buffer，不解析答案或判断领域正确性。缺少流或读取失败表示必要业务证据尚不可用，不能据此通过验收。

原四态仍为 `observed`、`rejected`、`failed`、`indeterminate`，其中 `observed` 不等于领域 PASS。只有经过校验的结果可以进入公共报告；准备对象、原始流及错误细节均须留在私有范围。

工作负载语义、候选引用与载荷的绑定、领域断言、发布新鲜度和资源清理由调用方负责。调用方须在准备前持有外层会话目录与工作区的句柄。结果确定后，先读取证据并确认没有进程继续使用目录，再清理现场。`indeterminate` 必须保留现场并完成要求的人工动作，不能用无条件清理包住整次调用。重试须创建新的目录并重新准备。本地夹具检查不构成真实宿主资格，也不证明模型经宿主发现调用了 Skill。

## 典型使用场景

- 新项目骨架：`scaffold`（不覆盖非空存量仓）。
- 存量采用盘点：`adopt-plan`（严格只读，不写文件、不自动迁移）。
- 受管投影：`projection` + Profile（不覆盖 handwritten 文件）。
- 工程诊断：普通 `check` 只读；`check relock` 执行显式受控写事务，`check qualification` 预检通过后可能启动绑定的 executable。
- 声明式治理诊断：版本检查显式选择 `policy: "declared"`，入口检查走 declared 子动作。目标只被静态读取；可选结论文件须由调用方明确授权输出位置。

## 边界机制

- `scaffold` 的目标必须是**空目录**（任何条目含点文件都算非空），或其父目录已存在的不存在路径（只创建最后一级）。全部写入经 harness 的原子收容写（`writeFileAtomic`），失败不留半成品，路径不能越出目标根。
- `adopt-plan` 结构性只读：实现中不存在任何写调用，连临时文件都不产生；计划字节与 `scaffold` 同源（`describeSkeletonFiles` 单一事实源），因此「计划即动作」。默认可能启动一条冻结参数的只读 Git status 探测；CLI 的 `--no-git-spawn`（或 API 的 `allowGitSpawn: false`）可关闭该探测。dirty 仓运行前后字节级零变化。
- `projection` 采用两阶段执行：先对每个条目做路径分类、收容预检、自投影检查、manifest 授权检查、手写保护与冲突守卫；任一条目违规则整体拒绝、零写入。覆盖既有文件必须声明精确的 `expect.sha256` 前置状态；内容相同的既有文件是幂等 no-op。写入失败时尽力还原已覆盖文件的前置字节。

  工程模式保留原始已核引用快照，在每次实际修改前和完成后重验；重复读取不能替换基线。首写前若发生拒绝，则不执行恢复写入，未尝试输出的外来字节保留。实际尝试写入失败时沿用既有错误、验证与尽力回滚，仅恢复本模式实际尝试的输出路径。不承诺整次初始化事务、恶意并发或 ABA 安全；原 v2 完整闭包回滚合同不变。
- 普通 `check` 只读且无写调用，也没有 `--fix/--apply/--repair` 模式（此类标志在入口处被拒绝）。默认可能启动一条冻结参数的只读 Git status 探测；CLI 的 `--no-git-spawn`（或 API 的 `allowGitSpawn: false`）可关闭该探测。`check relock` 执行显式受控写事务；`check qualification` 预检通过后可能启动绑定的 executable。Git 前置状态仅用文件系统事实加至多一次冻结参数矢量的只读 `git status --porcelain=2`（`--no-optional-locks` + `GIT_OPTIONAL_LOCKS=0`，不刷新索引）。
- 未发布的 declared 分支中，两个纯检查函数仍只读，也不探测 Git。只有调用方显式要求结论时，两个既有包装入口才通过独占创建产生本轮唯一新增持久副作用。

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

本包不得执行 git init、commit、push、tag、stash、分支切换、发布、删除、远端写入或发布状态复述；不实现第五个顶层命令；不做业务判断或模型调用。

Foundation 本身不发起网络请求，但绑定的 executable 仍可能联网。Foundation 不提供 sandbox 或 egress 阻断；隔离责任由调用方与运行环境承担。仓内受控 fixture 按设计不发起网络请求。

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
- 需要通用或远端宿主生命周期、自动信任、删除式 uninstall，或想用受控 fixture 取得真实宿主资格。
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
- adopt-plan 与普通 check 严格只读且不写文件；默认可能启动一条冻结参数的只读 Git status 探测，可由 `--no-git-spawn`（或 API 的 `allowGitSpawn: false`）关闭。check relock 执行显式受控写事务；check qualification 预检通过后可能启动绑定的 executable。Git 是诊断检查使用的只读白名单探测。
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

候选 `runPluginVerification({ request, bindings, hostsRoot })` 保留两个旧目标，并增加只允许本地来源的 `native-lifecycle` 分支。Qoder 与 WorkBuddy 使用不同的生产 driver，由 driver 自己拥有 argv 计划，共用恰好十二个语义阶段；每次 spawn 前重新观察可执行文件身份。Contracts 只拥有结构，宿主计划与 Oracle 归 Kit。受控 executable 协议只证明隔离接线，不是厂商 grammar。真实宿主与来源组合仍需独立资格证据。

独立入口 `runSkillFamilyDirectoryVerification({ request, bindings })` 固定 Kimi 生产 argv 与窄环境，并拒绝调用方 observation。原始 parser 通过生产进程路径验证，但受控 fixture 事件不会被提升为 `observed`；缺少官方 typed mapping 时，公共结果保持 `indeterminate` 和 manual candidate。

声明式治理分支与结论输出随 0.22.0 制品发布；此前已发布的 0.21.0 制品不包含它们。远端可用性须由对应的 release-skill 发布后证据证明。本地测试或工作树 tarball 不等于契约接入完成、迁移完成或真实宿主资格。
