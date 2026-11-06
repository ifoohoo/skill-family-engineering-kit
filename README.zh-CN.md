<!-- release-skill:safe-first-command -->
<!-- release-skill:external-write-boundary -->

> English version: [README.md](./README.md)

# skill-family-engineering-kit

<!-- release-skill:release-version: 0.38.0 -->

开发与 CI 阶段使用的工程工具包。**恰好四个**顶层命令，没有第五个：

<!-- release-skill:managed:start id=latest-release -->
**0.38.0** (2026-11-06)

本版 Kit 新增 `check skill-surface-bindings` 与 `check native-projections` 两个 CLI 子动作及对应公共 API，同时扩展 `runStaticReferenceCheck` 支持以 `../` 开头的有限路径前缀，确保固定文件引用在严格根收容下安全核对。新增 `runFixedSchemaUseCheck` 包根 API，用于独立核对 Markdown 声明中 $id 与 schemaVersion=N 和实际采用的 2020-12 Schema 必需版本，可选验证 Python 实现中实际采用的 Schema 文件、同一数据绑定与验证早于业务解释的关系。

**变更**

- 新增 `check skill-surface-bindings` 与 `check native-projections` CLI 子动作及对应公共 API `runSkillSurfaceBindingCheck` 与 `runNativeProjectionCheck`，分别用于验证技能表面绑定与原生投影的一致性。技能表面绑定比较身份、参数赋值、实现路径、协议路径四组直接声明。
- 原生投影检查复用四组原生身份比较，完整 Skill 文件比较时仅将每个唯一直接单行 YAML name 标量的原始字节区间替换为统一标记，其余全部字节原样参与比对；显式指定的 commonRef 与 platformRef 之间资源对进行独立全字节完整比对，支持二进制内容。
- 任何直接值、正文、权限、协议或资源字节不一致均视为发现项。绑定缺失、不支持、歧义、不可读或漂移将导致相关绑定不足且不参与比较，稳定独立绑定予以保留。领域含义由调用方 LLM 解释，机械状态与实际 scope 取 API 原始返回。
- 既有 `runStaticReferenceCheck` API 扩展支持 `literal` 字段以一个或多个连续 `../` 开头，后接由 `/` 分隔的合法普通文件段，段内仅含 ASCII 字母、数字、点、下划线、连字符，且不为 `.` 或 `..`。目标路径必须严格留在 `root` 内，通过 `path.posix.join(baseDir,literal)` 派生 `targetRef`，`join` 执行 POSIX 词法规范化但保留原始 `literal`。所有读取、闭包与安全政策保持不变，该路径使用既有包根 API。
- 新增 `runFixedSchemaUseCheck` 包根 API，独立核对 Markdown 声明中 $id 与 schemaVersion=N 和实际采用的 2020-12 Schema 必需版本。可选验证 Python 实现中数据加载与验证是否早于业务解释，仅在有限直接链路可分类时进行比较。JSON 解码与直接版本头读取可先行，不构成业务解释。无法分类时仅实现不足，声明仍保留。结果为 `professional-conclusion`，由 `readProfessionalProof` 按实际 scope 读取，领域适用与完整审计由调用方核收。

**升级说明**

四单元同步采用 0.38.0 版本，旧调用无需迁移。正式消费应以精确已发布载荷与导出包为准，开发观察阶段保持自身对象身份。`runSkillSurfaceBindingCheck` 与 `runNativeProjectionCheck` 分别验证技能表面绑定与原生投影，结果由宿主保存 `professional-conclusion`，调用方通过 `readProfessionalProof` 按实际 scope 读取。`runFixedSchemaUseCheck` 仅在显式调用时生效，Plugin 应在 foundation-engineering-check 中显式选择范围并调用该 API 及公共 reader，不凭手填结果通过。
<!-- release-skill:managed:end id=latest-release -->

## 治理检查（0.22.0）

0.22.0 在既有 `check` 命令下增加显式 `declared` 政策。版本检查只读取
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

在正式发布前，若需对本地 0.38.0 源码候选进行已授权的开发验证，可使用以下方式。

为确保本地验证使用与工作树一致的 0.38.0 版本，避免误用已发布的旧版 0.37.0，可执行以下命令打包并构建本地验证环境：

```sh
pack_dir="$(mktemp -d)"
(cd packages/skill-family-contracts && pnpm pack --pack-destination "$pack_dir")
(cd packages/skill-family-harness-node && pnpm pack --pack-destination "$pack_dir")
(cd packages/skill-family-engineering-kit && pnpm pack --pack-destination "$pack_dir")
mkdir "$pack_dir/consumer" && (cd "$pack_dir/consumer" && npm init -y)
(cd "$pack_dir/consumer" && npm install "$pack_dir/skill-family-contracts-0.38.0.tgz" "$pack_dir/skill-family-harness-node-0.38.0.tgz" "$pack_dir/skill-family-engineering-kit-0.38.0.tgz")
```

当精确版本 0.38.0 已在公共 registry 中正式可用时，可直接通过以下命令进行安装与执行：

```sh
npm install --save-dev skill-family-engineering-kit@0.38.0
npm exec --package=skill-family-engineering-kit@0.38.0 -- skill-family-kit --help
npm exec --package=skill-family-engineering-kit@0.38.0 -- skill-family-kit scaffold --root <empty-dir> --project-id my-project
npm exec --package=skill-family-engineering-kit@0.38.0 -- skill-family-kit adopt-plan --root <repo> --list-capabilities --all --scope all --locale zh-CN --uses ./uses.json
npm exec --package=skill-family-engineering-kit@0.38.0 -- skill-family-kit projection --root <repo>
npm exec --package=skill-family-engineering-kit@0.38.0 -- skill-family-kit check --root <repo>
```

上述命令依次实现：查看工具帮助信息、生成项目骨架、执行只读盘点以识别项目能力与配置、生成受管事实投影、执行诊断检查以发现工程配置中的不一致项。在 0.38.0 正式可用后，也可不预先安装 Kit，直接使用 `npm exec --package=skill-family-engineering-kit@0.38.0 -- skill-family-kit --help` 查看帮助。

### 工程声明调用（自 0.24.0 提供）

可选 `engineering` 参数自 `0.24.0` 提供，`0.23.0` 不支持。使用已选 SDK 前，核对其实际公共接口与三个 Foundation 包的精确锁步来源；候选验证与正式发布后采用分别报告。省略参数保持既有字节和路径；`null`、`{}`、未知字段和非法引用拒绝。无需另建声明输入文件。

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

现有受管项目使用 `runProjection({ root: targetRoot, engineering })` 完整替换整个 `engineering`，不做深合并。完整已确认对象须保留仍需使用的旧 `entries` 和 `releaseUnits`。不能与 `manifest`、`candidateRoot` 或 `preparedProjection` 同传。目标须为现有普通根，具备有效普通 registry、项目清单和受管锁；清单与锁已由 registry 及 `managedFiles` 声明受管，清单锁条目由 Engineering Kit 拥有。其他受管文件须匹配原锁，没有缺覆盖、重复或未拥有的锁条目。每个业务入口与版本引用须指向根内现存普通文件。登记表已把锁列为 kitManaged，且 `managedFiles` 只缺这一路径时，同一次更新会补入该路径并同时重写清单和受管锁。前提缺失，包括登记表没有声明该锁，只表示本更新不可执行，不自动接管任意非空项目。

合法更新只写 `skill-family.project-manifest.json` 和 `skill-family.managed-file-lock.json`，保留非 `engineering` 字段、registry 与其他文件字节、其他锁条目、生成器身份、版本、`lockVersion` 和文件 mode。清单摘要由原生成器派生，同内容幂等。结果沿用 `schemaVersion: 2` 的 `skill-family.projection-receipt`；内存候选的 `candidate.root` 与 `manifest.location` 为 `null`。原 v1/v2 和 prepared 投影保护保留，不手写清单或锁候选掩盖漂移。

三个原 CLI 命令接受 `--engineering <JSON>`：

```text
skill-family-kit scaffold --root <target> --project-id <id> --profile generic --licensing-profile <licensing-id> --engineering <JSON>
skill-family-kit adopt-plan --root <target> --project-id <id> --profile <profile-id> --licensing-profile <licensing-id> --no-git-spawn --engineering <JSON>
skill-family-kit projection --root <target> --engineering <JSON>
```

`<JSON>` 是工程对象的 JSON 字符串，不是文件路径，须以 shell 引号作为一个参数传入。`--engineering` 与 `--engineering-baseline` 独立，后者仍须与 `--compare-skeleton` 成对；能力目录查询不能混入工程声明。四个顶层命令边界保留。

事实未齐时具体报告缺项。可以只声明 `entries` 或只声明 `releaseUnits`，但未声明的另一检查分支仍为 `incomplete`。待真实业务和版本文件存在后，使用官方受管更新及既有 core、declared 版本、declared 入口检查。生成、只读计划、静态检查、正式宿主发现、真实业务、独立语义审阅与整体资格分别报告；省略参数保留旧行为，不表示声明已完成。

自 0.24.0 起，公开 `runCoreCheck` 的版本检查按目标声明选择适用路径：目标真实声明 `engineering.releaseUnits` 时，版本类复用已有声明式版本读取逻辑，依据 `versionSource` 与 `versionMirrors` 检查文本或 JSON 格式的版本信息；私有工程的 `package.json` 不自动成为该业务单元的版本源或镜像，仅当被显式声明时方可参与版本认定。对于真正未声明版本、或仅包含合法 `entries` 的目标，仍沿用原有 legacy 版本检查路径。非法或重复的声明不回退为通过；声明的版本源或镜像缺失、不可读时如实失败。

核心调度机制保持不变，共用原九类循环与报告流程，保留 Contracts 规格版本一致性检查及其他八类校验。声明的来源、镜像及各祖先路径均需先通过原树枚举与 `lstat` 安全预检，包括原不展开的工具目录；仅探查声明所涉路径，不引入新的目录遍历器。符号链接、FIFO 及其他不安全读集仍按原规则拒绝访问，禁止穿过根内符号链接目录；`completed`、`mechanism` 与 0/1/2 退出码如实传播。

该调整仅涉及公开 core 对已声明版本目标的检查：公共 `runChecks` 缺省行为仍等同于显式 `policy: "legacy"`，涵盖原版本发现及 `full`/`only` 等价逻辑；显式 `policy: "declared"` 仍仅允许 `only: "version"`，维持原报告形式、不执行目标代码、不调用 Git 的边界。未新增任何公共 policy 值、API、CLI 参数、Schema 定义或包根导出，亦不在目标生成 shim 中复制检查逻辑。局部验证不构成正式发布、业务资格或整体初始化完成的证明。

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

### 宿主加载检查子动作

#### 版本边界与能力范围

- **0.25.0** 版本已支持对 Codex 0.154.0 的宿主加载检查。
- **0.26.0** 源码候选版本在相同入口中新增对七宿主的检查能力，但该功能**仍处于候选状态**，正式可用性需以该版本的实际发布验证为准。**请勿使用 0.25.0 发布包运行新增宿主检查**。

#### CLI 命令与参数说明

公共函数为 `runHostLoadingCheck({ root, hostId, hostVersion, pathCategory, activationRules, hostsRoot })`。以下是对应 CLI 调用；第三条需要包含七宿主增量的版本：

```sh
npm exec -- skill-family-kit check host-loading --root <project> --host codex --host-version 0.154.0 --path-category codex-project-skills
npm exec -- skill-family-kit check host-loading --root <project> --host codex --host-version 0.154.0 --path-category codex-project-skills --activation-rules <relpath.json> --hosts-root <dir>
npm exec -- skill-family-kit check host-loading --root <project> --host kimi-code --host-version 2.2.0 --path-category kimi-code-project-skills
```

- `root`：必须为绝对项目目录路径；CLI 会先解析当前目录或相对路径。
- `host`：宿主标识符，如 `codex` 或 `kimi-code`。
- `host-version`：对应宿主版本号，如 `0.154.0` 或 `2.2.0`。
- `path-category`：宿主技能容器的相对目录类别，例如 `codex-project-skills` 或 `kimi-code-project-skills`。
- `--activation-rules`：CLI 接收项目根内相对 JSON 文件路径，其内容为有序规则数组，每项选择 `name` 或 `path` 之一，并带 `enabled` 布尔值。只有 Codex 支持这些规则。新增七宿主的 API 参数 `activationRules` 仅允许省略或 `null`，包括 `[]` 在内的任何非 `null` 值都返回 `2`；CLI 应省略该选项。
- `hosts-root`：可选，指定自定义宿主配置根目录；省略时使用包内默认 Profile。**指定后不得修改已校准的精确版本、类别与相对目录组合**。

#### 宿主选择器与实现依据

新增七宿主的精确选择器定义于公开源码中：

[src/host-loading-native.mjs](src/host-loading-native.mjs) 中的 `NATIVE_HOSTS` 内部表。

该表为内部实现结构，不是包根公共导出；它列出新增七宿主支持的精确版本、类别与相对目录组合。Kimi 示例使用 `.kimi-code/skills`。

Codex 的选择器仍沿用 [src/host-loading-check.mjs](src/host-loading-check.mjs) 中的常量合同，容器为 `.agents/skills`。

#### 检查行为与限制

- **不启动宿主、模型、hook 或脚本**。
- **不联网、不写入文件、不修改任何状态**。
- **仅静态分析项目容器内指定路径下的技能结构**。
- **检查范围不涵盖用户全局技能、祖先项目或插件全环境**。
- **新增七宿主的目录或文件符号链接保留为未覆盖，返回退出码 2，不越界读取**。
- **仅检查一个显式指定的项目容器**，不推断启用、安装、更新、会话选择或真实业务触发的成功性。

#### Codex 保留行为

- 同名不同路径的技能全部保留，不合并或覆盖。
- `SKILL.md` 旁 `agents/` 目录下的标准可选技能元信息 YAML，若存在错误则整份忽略，不导致加载失败。
- `policy.products` 非空且只列出 Codex 以外产品时才过滤；包含 `codex` 时保留，空列表不触发产品过滤。
- `allow_implicit_invocation=false` 记录隐式调用关闭，不代表 `enabled=false`；缺少显式启用规则时，`enabled` 仍未知。
- `activationRules` 仅 Codex 支持传入有序数组，每项为 `name` 或 `path` 二选一，加 `enabled` 布尔值。

#### 新增七宿主行为

- 所有技能的基础字段 `enabled`、`disabled`、`implicitInvocation`、`interface`、`shortDescription` 均为 `null`。
- 原生行为差异通过 `skills[].observations` 数组表达，每项包含：
  - `field`：被观察的字段名
  - `value`：观察到的值
  - `basis`：观察依据，`native-observed` 表示该规则曾用原生事实校准，不表示本次检查启动过宿主
  - `sourceId`：来源标识，对应 `coverage.ruleSources` 中的记录
- `coverage.ruleSources` 记录每条规则的：
  - `id`
  - `version`
  - `source`
  - `sha256`
- **仅 Cursor CLI 版本 `2026.09.10-fd3934a` 的 `modelMetadata.*` 字段标记为 `source-reviewed-unexecuted`**，表示“源码核实、未作原生运行校准”。
- Cursor 的菜单与补全面已有原生校准，**不能将此例外推广为整个宿主无原生证据**。
- Codex 继续使用 `officialTag` 和 `officialCommit`，**不虚构给其他宿主**。

#### 退出码与结果解读

| 退出码 | 含义 |
|--------|------|
| `0` | 请求范围完整，且无已证实阻断 |
| `1` | 存在已证实阻断，或项目存在但缺技能容器、没有可发现入口；Codex 只有被产品过滤的目标也返回 `1` |
| `2` | 未知版本/形态、非等价覆盖、非法选择器，或项目根不存在/非目录 |

- **有未覆盖项时优先返回 2，但不丢弃已知的 `findings`**。
- **报告需综合 `findings`、`uncovered`、`limitations` 三部分，不可仅依赖退出码判断**。
- **同名规则按宿主独立处理，未覆盖时不猜胜者**。

#### 重要说明

- 本检查为静态分析，**不证明宿主已启用、已安装、已更新、会话中被选择或业务流程成功**。
- 发布包来源与检查范围是两个独立判断，消费正式包时需依据实际接口与来源。


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
- declared 分支中的两个纯检查函数保持只读，也不探测 Git。只有调用方显式要求结论时，两个既有包装入口才通过独占创建产生本轮唯一新增持久副作用。

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

## Skill 文本声明与原生投影检查

### Skill文本声明检查（runSkillSurfaceBindingCheck）

调用方选用独立只读API `runSkillSurfaceBindingCheck`，输入为 `{root, bindings}`，其中 `root` 为非空字符串，表示项目根目录路径。`bindings` 为非空数组，每项包含四个字段，所有字段必须同时存在，闭字段不接受额外键。

**请求 JSON 结构示例**

示例只展示请求形态，实际坐标从现存原件取得。

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

**字段要求**

- `root`，非空字符串，表示项目根目录，可使用绝对或相对目录路径。
- `bindings`，非空数组，每项必须同时包含 naturalSkill、parameterDeclaration、commonMethod 三个对象与 parameterName 字符串。
  - `naturalSkill.ref`，路径字符串，指向实际Skill Markdown文件。
  - `parameterDeclaration.ref`，路径字符串，指向参数声明文件。
  - `commonMethod.ref`，路径字符串，指向共同方法定义文件。
  - `parameterName`，字符串，符合正则 `^[A-Za-z_$][A-Za-z0-9_$]*$`，表示参数名。
- 所有片段对象（`protocolRef`, `parameterLiteral`, `methodId`, `methodValue`, `implementationRef`）的 `line`、`column`、`length` 必须为正安全整数，按1起始的UTF-16码元坐标取单物理行原文，不切开代理对。
- `methodId` 与 `methodValue` 必须同行，且 `methodValue` 为 `methodId` 的严格子片段。
- `parameterDeclaration.ref` 与 `commonMethod.ref` 必须解析为同一实际文件路径。
- `parameterName` 为键，`methodValue` 为局部方法值，两者不互相比较。

**四组实际比较关系**

API 严格读取实际 Skill 和 Markdown，从初始 YAML 与所选文本片段取得原始值。参数只支持直接 `key=value`，其中 key 必须与 `parameterName` 相同。局部值符合 `^[A-Za-z_][A-Za-z0-9_-]*$`，共同完整方法身份是单行未包裹值。

1. 实际Skill的 `name`（从初始YAML取）对共同 `methodId` 的值。
2. 实际 `parameterLiteral` 与由 `parameterName`、等号和共同原件 `methodValue` 片段实际局部名拼成的值比较。
3. 共同 `implementationRef` 片段中的路径字面量所指实际文件身份对 `naturalSkill.ref` 指向的真实文件路径。
4. Skill `protocolRef` 片段中的路径字面量所指实际文件身份对 `commonMethod.ref` 指向的真实文件路径。

**scope.checked 标识**

- `binding:N:method-identity`
- `binding:N:parameter-declaration`
- `binding:N:implementation-reference`
- `binding:N:protocol-reference`

各文件引用与所选路径字面量均为根内直接本地相对路径，目标文件必须严格读取，缺失或不可读时，相关绑定记为不足。

---

### 原生投影检查（runNativeProjectionCheck）

调用方选用独立只读API `runNativeProjectionCheck`，输入为 `{root, bindings}`，其中 `root` 为非空字符串，`bindings` 为非空数组。

**请求 JSON 结构示例**

示例只展示请求形态，实际坐标从现存原件取得。

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

**字段要求**

- `root`，非空字符串，表示项目根目录。
- `bindings`，非空数组，每项必须同时包含下列字段。
  - `commonManifestRef`，非空字符串，指向共同清单文件路径。
  - `commonSkillIndex`，非负安全整数，表示共同清单中Skill索引。
  - `platformManifestRef`，非空字符串，指向平台清单文件路径。
  - `mappingIndex`，非负安全整数，表示平台映射索引。
  - `resources`，可为空数组，但每项中 `commonRef` 与 `platformRef` 均为非空字符串，表示资源文件路径对。

前四字段沿用 `runNativeEntryBindingCheck` 的选择合同，文件引用为根内相对路径。

**四身份来源链**

1. 平台 `source` 真实文件路径对所选共同清单文件路径。
2. 平台 `physicalName` 对平台Skill的 `name`。
3. 平台 `logicalName` 对所选共同 `logicalName`。
4. 共同 `logicalName` 对共同Skill的 `name`。

**实际Skill比较**

- 共同 `sourceRoot` 相对于 root，再与 `skills[index].source` 共同定位实际 Skill。`sourceRoot` 严格为 `.` 时采用已解析 root 作为目录基准。
- 平台清单目录 + `logicalMappings[index].path` 定位平台Skill（Markdown）。
- 严格解码两份实际Skill为UTF-8，定位各自唯一直接单行YAML `name` 标量原始范围，支持 `plain`、`single-quote`、`double-quote`。
- 仅将两边 `name` 标量范围替换为同一固定值，其余全部字节进行完整比较。
- `skillNormalization` 保留实际 `name`、原始字节范围、`normalizedSha256`。
- 若存在别名、合并、重复键、未知标签、间接/多行 `name`、不唯一范围或非法UTF-8，导致绑定不足。

**资源比较**

- 每对 `resources` 中的 `commonRef` 与 `platformRef` 文件，比较其完整原始字节，允许二进制。
- 比较独立于Skill字节比较，不交叉比较。
- 双路径仅表示位置对应。额外正文适配规则不在闭合输入中，已知正文、权限与协议字节差异仍作为实际发现，领域含义由调用方判断。

**scope.checked 标识**

- `binding:N:native-identity:1` 至 `binding:N:native-identity:4`，分别对应上述四身份关系。
- `binding:N:skill-content`，表示Skill整文件字节比较结果。
- `"binding:" + N + ":resource:" + M + ":bytes"`，`M` 为资源对序号，表示该资源文件对的字节比较结果。

### 结果、CLI 与证明读取

**请求错误条件**

- 结构/类型/未知字段、空或重复绑定、非法片段数值、`methodValue` 内含位置关系、重复资源对、同平台资源对应冲突共同文件。

**绑定不足条件**

- 实际文本越界、直接文本/路径子集不支持、键不匹配、同文件前提不成立、缺失/不可读/歧义、严格UTF-8失败、闭包漂移。

**已知发现条件**

- 前提成立后，直接值或内容不等。

**五种结果聚合**

- `complete/ENGINEERING_CLEAR`，所有完成且无发现。
- `complete/ENGINEERING_FINDINGS`，所有完成但有发现。
- `partial/ENGINEERING_FINDINGS`，有稳定发现与不足并存。
- `partial/ENGINEERING_CHECK_INCOMPLETE`，完成无发现但仍有不足。
- `not-performed/ENGINEERING_CHECK_INCOMPLETE`，无完成可归属比较。

**CLI调用命令**

```text
skill-family-kit check skill-surface-bindings --root <dir> --selection <rel> --json
skill-family-kit check native-projections --root <dir> --selection <rel> --json
```

**选择回执**

- 选择文件位于根内，仅含 `bindings`，无歧义JSON读取回执加入闭包。
- CLI 退出码按下列含义解释。
  - `0`，完整无发现。
  - `1`，发现或不足。
  - `2`，非法请求或未处理机制错误。

**真实 API 原件与 reader**

返回原 `skill-family.professional-conclusion`，`provider.entry` 为实际 API 名，`subject.ref` 为解析后的实际根目录，`details` 保留选集、读取回执、位置与实际值或文件身份、比较及闭包。静态读取观察限本次字节，不能提供原子快照。

- 宿主独占保存真实原返回，再交原 `readProfessionalProof({proofRoot,proof})` 或 `check proof` 解释。
- 对上述已读取结论，reader 将 `complete/ENGINEERING_CLEAR` 解释为 `pass`，发现或不完整解释为 `not_pass`。证明不可读或不可解释时为 `unavailable`。
- 不能用 `proof-create` 手填机械结果。
- `reader` 不重扫或鉴作者。
- 合选其他范围时原件分别保留，专业结论只承接实际 `scope`。
- 领域允许适配/违规与全选集解释由调用方负责。

<!-- agent-quick-reference:start -->
## 固定文件引用检查

调用公开 API `runStaticReferenceCheck({root, references})` 可只读核对选定的实际固定文件引用。请求必须包含显式非空 `root` 目录，以及非空 `references` 数组。每项引用恰含 `sourceRef`、`line`、`literal`、`baseDir`，其中三个路径字段为非空字符串，`line` 为从 1 开始的安全整数。重复项或未知键将被拒绝，抛出 `SFC2003` 错误。每个引用独立处理，不依赖全集支持。调用方需确认真实调用、显式解析基准与全部必要选集。

### 支持的路径形态

- **普通相对路径** 如 `utils/helper.js`，也支持单个 `./` 前缀，如 `./utils/helper.js`。
- **新增 raw literal** 以一个或多个连续 `../` 开头，后接一个或多个由 `/` 分隔的普通文件段。各段仅允许 ASCII 字母、数字、点、下划线、连字符，且不能为 `.` 或 `..`。`index.mjs` 和 `variable.js` 均为合法文件名。
- 合法示例包括以下两种。
  - `baseDir=scripts`，`literal=../runtime/index.mjs` → `targetRef=runtime/index.mjs`
  - `baseDir=nested/scripts`，`literal=../../runtime/index.mjs` → `targetRef=runtime/index.mjs`

### 不支持的路径形态

- `nested/scripts/../../runtime/index.mjs`（中间 `../` 形态）
- `./../file`、`.././file`、`../`、空后缀
- 包含变量、glob、空白、非 ASCII 字符、反斜杠、绝对路径、URI、动态或模块搜索语法

### 处理流程

1. 复制并验证请求
2. 解析 `root`
3. 使用 `readFileStrict` 读取 `sourceRef`
4. 在指定 `line` 上绑定 `literal`，确保有边界且仅一次
5. 校验有限词法
6. 若 `baseDir` 非 `.`，则调用 `resolveContained` 核实实际基准
7. 使用 `path.posix.join(baseDir, literal)` 派生 `targetRef`，该操作执行 POSIX 词法规范化，但保留原始 `literal` 不变
8. `join` 后目标坐标可能越出 `baseDir`，但必须严格位于 `root` 内。越出 `root` 的相对 `..` 仍保留在目标坐标，由 Harness 拒绝
9. 使用 `readFileStrict` 读取目标文件，执行严格根收容检查

### 回执与闭包

- 保留来源与目标的真实 `ref`、`sha256`、`bytes` 回执
- 保留原始 `details.references` 与 `closure`
- 可完成项使用 `computeResourceClosure` 核摘要。重复读取或闭包漂移将撤销依赖项，独立稳定项保留；整体闭包失败时，`closure=null`
- 未知程序异常直接传播，不吞为不足

### 返回聚合与错误

- 每项返回 `checked` 或 `insufficient`
- 全部 `checked` → `complete/ENGINEERING_CLEAR`
- 至少一项 `checked` 但存在不足 → `partial/ENGINEERING_CHECK_INCOMPLETE`
- 无 `checked` → `not-performed/ENGINEERING_CHECK_INCOMPLETE`
- `not-performed` 非逐项状态，也不等同于未调用
- 不足原因包括缺失、不可读、歧义、不支持、越界，保留 `reason` 与已有 `cause`（若有）

### 读取器与调用方语义

- 宿主保存实际返回，再由 `readProfessionalProof({proofRoot,proof})` 读取。核对来源回执摘要与调用方冻结目标，读取器沿用原解释范围
- 局部结果仅反映观察时刻的完成情况，语义、权限、业务完整性由调用方负责
- 观察非原子快照
- 实际执行不写入、不运行目标代码、不启动进程或联网

### 示例请求

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

### 版本与依赖

- 本修订版本为 0.38.0（开发候选），当前正式版为 0.37.0
- 公开消费以实际安装的精确发布版为准
- `runStaticReferenceCheck` 已存在，本次仅扩大 `literal` 子集
- 无新 API、CLI、导出、模式、字段、证明格式、Schema、依赖或 Harness 算法
- 原 038 的另两项新 API 保持独立，本单元不涉及，不增加执行依赖
- 无专用固定引用 CLI，Skill 直接调用包根 API 与公共 reader

### 固定Schema声明与采用链路检查（runFixedSchemaUseCheck）

本节面向具备JSON与Python基础的调用方。Schema是定义对象结构的JSON契约，$id为完整类型标识，schemaVersion为契约要求的数据版本。选定的Markdown声明与实际Schema的对应关系可独立核对；可选的Python实现检查进一步验证实际采用的Schema与业务解释的先后顺序。

公开调用仅支持 `runFixedSchemaUseCheck({root, bindings})` 包根API。`root` 必须为非空字符串，表示获准根目录；`bindings` 必须为非空数组。未知键、重复选集或非法坐标将被SFC2003拒绝。输入在异步读取前进行同步深复制。所有路径均通过现有严格根收容机制读取，不执行目标Python代码。

`declaration` 必须包含 `ref`、`unit`、`schemaPath`、`schemaId`、`schemaVersion`。`ref` 为实际Markdown路径，其余四项均为 `{line, column, length}` 形式的正安全整数，按从1开始的UTF-16码元定位。一个物理行 `unit` 包含三个子片段，子片段需唯一且具有完整字面边界，不拆分代理对。不同 `unit` 之间不得交叉重叠，同一 `unit` 可关联不同实现。三个子片段分别选中实际根目录内的Schema路径、完整 `$id` 和 `schemaVersion=N` 原文。调用方负责声明的真实业务含义、公开性、适用性及选集完整性。

支持真实、普通、自包含的2020-12 JSON Schema，要求根 `type=object`，非空直接 `$id`，`required` 包含 `schemaVersion`，`properties.schemaVersion.const` 为正安全整数。通过调用 `Contracts` 公开编译入口核验解析性，拒绝异步与外部引用，允许自包含 `#` 引用。当读取编译缓存与当前Schema全文不符时，判定为不足。调用方须保持同进程中已编译验证器及其Schema不被改写。声明比较仅核验完整 `$id` 及版本数值，不依据URN后缀推断，也不要求目标增设其他身份格式。

每项必需 `declaration`，可以省略 `implementation`。提供后，`implementation` 必须包含 `ref`、`dataLoad`、`validation`。`ref` 为实际Python路径，后两者为 `{line, column}` 形式的正安全整数，用于选择真实直接赋值或验证语句的唯一起点。完整Python具体语法树（CST）须经严格解析且无错误，所选两节点须是唯一无参数顶层 `main` 中同一 `try` 语句体的直接节点。`dataLoad` 限定为 `dataLocal=json.loads(Path(args.input).read_text())`，其中 `args.input` 表示调用方实际直接参数名。`validation` 限定为 `jsonschema.Draft202012Validator(schemaLocal).validate(dataLocal)`。`schemaLocal` 从实际 `schemaLocal=json.loads((root / "contracts/input.json").read_text())` 派生，`root` 实际源于 `main` 内先行唯一 `Path(__file__).resolve().parent.parent`。变量名与示例路径仅为示例，相关直接绑定、导入及无写入/别名/动态逃逸等有限前提须成立。

数据JSON语法解码可早于Schema加载。两者须各自在实际验证前完成，直接读取 `dataLocal["schemaVersion"]` 头部识别也可先行。直接读取实际Schema `properties` 中其他业务字段，或把整个数据嵌入结果，属于业务解释。已分类的业务解释早于对应实际验证构成发现。实际验证器使用另一已解析且身份/版本不同的Schema也构成发现。不同局部名加载同一实际文件可通过。分支、循环、别名、重绑定、间接调用、其他兼容策略、未知用途或路径无法分类时，仅可选实现不足，零实现比较。该检查不证明一般多版本兼容、任意控制流、环境库真实性、转换无损或执行成功。

仅选择声明核对两项关系，可选实现另核对实际Schema文件、同一数据绑定及验证早于业务解释三项。返回原 `professional-conclusion`，`provider.entry` 为 `runFixedSchemaUseCheck`，`details.bindings` 每项内含独立 `declaration` 和可选 `implementation`，保存 `selection`、实际值、资源回执、`comparisons`、`status`、`reason` 及各自 `closure`。`scope.checked` 仅列出真实完成比较。闭包基于各自实际依赖，重叠共享资源的原始读取及闭包摘要交叉核对。Python单独缺失/不支持/漂移仅撤实现；共享Schema漂移撤实际依赖子检查。全闭包失败撤参与项，未知异常传播。观察不是原子快照。

全部完成无发现为 `complete/ENGINEERING_CLEAR`，全部完成有发现为 `complete/ENGINEERING_FINDINGS`。保留比较但有不足为 `partial`，已知发现优先 `ENGINEERING_FINDINGS`，否则 `ENGINEERING_CHECK_INCOMPLETE`。无比较为 `not-performed/ENGINEERING_CHECK_INCOMPLETE`。未选择 `implementation` 不构成不足。`readProfessionalProof` 仅读取上述实际选定范围，领域适用和完整审计结论由调用方核收。

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

## Windows 支持与使用边界

Foundation 0.28.0 面向 Windows 11 x64、本地 NTFS 与普通用户，采用 Contracts 1.21.0、56 个登记对象。三个固定世代对象保持 candidate，其他成熟度维持原登记。官方 npm 包 `skill-family-contracts@0.27.1` 仍承载 `contractsVersion=1.20.0` 与 53 个对象。精确版本的远端可用性须由正式发布凭据核实，本节范围说明不证明真实宿主资格。

`skill-family-engineering-kit` 四命令保持不变，安装闭包内预构建 `win32-x64` 二进制，无需本地编译器。启动需使用 npm 的 `bin/npm-cli.js` 或 pnpm 的 `bin/pnpm.cjs`，版本必须精确匹配。真实宿主资格需额外提供 driver、版本、认证与业务证据，本地自测结果不构成通过。详见 [API 文档](https://ifoohoo.github.io/skill-family-engineering-kit/reference/api/harness/)。
