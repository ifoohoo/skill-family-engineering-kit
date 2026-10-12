# 变更日志

<!-- release-skill:changelog:start version=0.24.1 locale=zh-CN baseline=sha256:0d0b6cccd46c69014e89efa21677ef015ccd3085f0fd07e8021b364b1c1f47e6 -->
## [0.24.1] - 2026-10-12

Engineering Kit 0.24.1 仅随 Foundation 文档补丁按既有四单元合同锁步前移，没有新增能力、API、Schema、协议或机制。

### 变更

- 仅更新包版本和相应受管版本派生；现有能力、参数与失败边界保持不变。

### 升级说明

三个 Foundation npm 包须精确锁定同版，独立插件与三包保持相同发布版本。Contracts 规格仍为 1.20.0，与 npm 包版本分别处理；消费以实际发布版本的公开接口和来源为准，本说明不替代发布后验证。
<!-- release-skill:changelog:end version=0.24.1 locale=zh-CN -->


<!-- release-skill:changelog:start version=0.24.0 locale=zh-CN baseline=sha256:0ae5e1d34d13be6d56f72e4c77ab44e4d24e0e4d5f562ab424d104795db770eb -->
## [0.24.0] - 2026-10-07

Engineering Kit 0.24.0 在既有 `check relock` 事务中增加显式的持久工具锁登记能力，四个顶层命令仍为 `scaffold`、`adopt-plan`、`projection`、`check`。本说明记录本地锁步候选状态，不表示远端发布或真实消费者采用已完成。

### 变更

- `registrationClass` 为 API 参数，仅接受 `handwritten` 或 `trackedToolLocks`；CLI 对应参数为 `--registration-class`。默认值保持为 `handwritten`；在默认手写模式下，文件清单为空或缺省时，原自动发现行为维持不变。
- 使用 `trackedToolLocks` 时必须提供非空显式 `files` 清单，CLI 通过 `--files` 指定。每个路径必须指向目标内已存在的普通文件，不支持自动发现工具锁，也不根据文件名或内容推断工具语义。
- 若原事务中 `classes.trackedToolLocks` 缺省，则在首次写入前初始化其 `entries` 数组，并追加明确指定的路径；若已有类别非合法对象，或 `entries` 非数组类型，则在首写前拒绝操作。其他类别保持不变。
- 仅更新 `.foundation/file-registry.json` 与 `skill-family.managed-file-lock.json` 两份状态文件。工具锁内容不进入受管摘要，后续由原工具刷新内容不会因此引发受管漂移；路径、符号链接、已登记路径、状态文档及既有受管漂移的拒绝规则继续有效。中途发布失败时仍暴露原始 `publicationState`，不承诺双文件原子回滚。
- 包版本与其他三单元同步前移至 0.24.0。Contracts 规格仍为 1.20.0，未新增合同对象、Harness 机制或报告种类；0.23.1 中仅锁步前移的历史说明保持原样。

### 升级说明

三个 Foundation npm 包须精确锁定至 0.24.0 版本。新登记模式仅属本轮候选，非 0.23.0 已发布能力；实际采用以对应版本公开接口为准。完整消费者、初始化及发布资格仍待验证。
<!-- release-skill:changelog:end version=0.24.0 locale=zh-CN -->


<!-- release-skill:changelog:start version=0.23.0 locale=zh-CN baseline=sha256:4192d7adcff64a7411acab5ef402d9baa657bcb1db6f41c4ed3b33c2303e25bc -->
## [0.23.0] - 2026-09-26

Engineering Kit 0.23.0 保持四个顶层命令，并增加完整静态专业审阅所需的本族证明出证和读取。本说明只记录本地锁步候选，不表示已经远端发布，也不表示真实宿主已经接受。

### 新增

- 增加 `check proof-create`。它把调用方提供的一份静态审阅结果投影成一份排他的 Foundation 结论，只检查审阅结构并写入本族结果；不再次扫描目标，不鉴定作者，也不覆盖已有结论。
- 增加 `check proof`。它读取一份已有的本族证明并解释公开领域码；不扫描目标，不追随 `details` 里的路径，不鉴定作者。
- 全部适用且选中的静态项通过时记录 `FOUNDATION_STATIC_CLEAR`；存在真实发现时记录 `FOUNDATION_STATIC_FINDINGS`；覆盖未完成、证据不足，或选中项全部不适用时记录 `FOUNDATION_STATIC_INCOMPLETE`。既有 `ENGINEERING_*` 仍只表示原来的局部声明检查。

### 变更

- 包坐标与 Contracts、Harness 和采用 Plugin 一起前移到 0.23.0。Contracts 规格仍是 1.20.0。本包不新增合同对象，也不新增 Harness 机制。

### 升级说明

三个 Foundation 包须一起精确锁定到 0.23.0。Kit 负责投影和读取本族结果；工程判断仍由 `foundation-engineering-check` 作出。远端发布和真实宿主验证不在本说明范围内。
<!-- release-skill:changelog:end version=0.23.0 locale=zh-CN -->


<!-- release-skill:changelog:start version=0.22.0 locale=zh-CN baseline=sha256:1926982b72cf2756963b204c22c9bfdf2969d690d3b336cf9bdc098fe4d256a0 -->
## [0.22.0] - 2026-09-18

Engineering Kit 0.22.0 保持四个顶层命令不变，在既有 `check` 命令内增加声明式工程检查与显式的专业结论输出。

### 新增

- 增加不含价格的声明式工程检查，带声明版本与入口分支；只读取项目明确登记的版本来源与物理入口，不执行目标。
- 增加可选的专业结论输出。只有 `runCommand('check')` 和入口动作可以独占创建，且必须由调用方提供已存在的输出根与受收容的相对路径。

### 变更

- 默认 `check` 诊断与纯函数 `runChecks`/`runEntryContractCheck` 仍然只读；输出根不存在或结论条目已存在时拒绝，不创建、不覆盖。
- 随 0.22.0 发布新的能力目录，按 Contracts 1.20.0 投影新增 `foundation.harness.file-set-recovery` 条目。

### 升级说明

三个 Foundation 包须一起精确锁定到 0.22.0。声明式检查只证明已登记的版本来源与入口在结构上一致，不证明目标已执行；结论的业务解释不属于 Foundation。
<!-- release-skill:changelog:end version=0.22.0 locale=zh-CN -->


<!-- release-skill:changelog:start version=0.21.0 locale=zh-CN baseline=sha256:1f50ac51db5691c5c9dbe1014d0ab43e6cfa4eab1d60eb37a9ca74d30bc75890 -->
## [0.21.0] - 2026-09-11

Engineering Kit 0.21.0 增加 `prepareHostVerification`，在既有宿主验证路径上准备一次受约束的 Cursor 调用，并读取经过摘要绑定的私有输出。

### 新增

- 增加 `prepareHostVerification`。它从调用方持有的候选、工作负载、Skill、工作区、夹具、提示词、可执行文件和状态根输入派生固定驱动请求、受收容调用目录、冻结快照与私有绑定。
- 冻结的准备对象增加 `readInvocationStream`。只有结果、请求、证据根绑定、流摘要和字节数一致时，调用方才能读取 stdout 或 stderr。

### 变更

- 启动进程前重新校验绑定与来源快照；创建会话或探测前比较安装后的 Skill 闭包摘要。发现漂移或摘要不匹配时失败关闭。

### 升级说明

三个 Foundation 包须一起精确锁定到 0.21.0。新准备接口只支持一个已声明的 Cursor Skill，并固定使用随包 `cursor-agent-print-v1` 驱动；工作负载含义、领域断言、发布新鲜度和清理由调用方负责。
<!-- release-skill:changelog:end version=0.21.0 locale=zh-CN -->


<!-- release-skill:changelog:start version=0.20.0 locale=zh-CN baseline=sha256:7f7e7f2175429d96720b04bb378afcb796e01f642abc0cdd7114fddf4a808b62 -->
## [0.20.0] - 2026-09-10

Engineering Kit 0.20.0 在既有宿主验证路径上增加 Cursor 项目级 Skill 投影和固定 Cursor Agent 验证驱动。

### 新增

- 登记 `.cursor/skills` 作为 Cursor 项目级 Skill 根，生命周期计划继续保持手动。
- 增加 `cursor-agent-print-v1`，固定工作区、问答模式、沙箱、JSON 输出、版本与失败检查。

### 变更

- 通过 Cursor CLI 菜单发现和一次显式调用取得项目级 Skill 发现资格，不重复执行 IDE 图形界面检查。

### 升级说明

三个 Foundation 包须一起精确锁定到 0.20.0，并重建官方 Bundle。Cursor 继续保持 manual/developer-preview；驱动不增加自动信任、模型选择或 Marketplace 生命周期管理。
<!-- release-skill:changelog:end version=0.20.0 locale=zh-CN -->


<!-- release-skill:changelog:start version=0.19.3 locale=zh-CN baseline=sha256:16f48a8354216cfe0f1354bed02f0a5cee6ef0b9adaaad3339dc9f80c1070e2b -->
## [0.19.3] - 2026-09-08

Engineering Kit 0.19.3 将包版本、发布文档和生成投影与 Foundation Adoption Review 的 Qoder 分发补丁对齐。公开命令和行为保持不变。

### 变更

- 包版本、发布文档和经验证的公开 package.json 投影与 Foundation 0.19.3 数值对齐，不增加命令、能力或 adapter 路径。

### 升级说明

三个 Foundation 包须一起精确锁定到 0.19.3，并按既有来源身份与完整性规则重建官方 Bundle。能力目录、宿主 descriptor、driver、since 字段和成熟度均不变。
<!-- release-skill:changelog:end version=0.19.3 locale=zh-CN -->


<!-- release-skill:changelog:start version=0.19.2 locale=zh-CN baseline=sha256:bd0cbfd935e7b9751f6311f3d1114df2db5066448d1830f27b7c92aa3aca9687 -->
## [0.19.2] - 2026-09-08

Engineering Kit 0.19.2 将包版本和生成投影与 Foundation Adoption Review 分发补丁对齐。公开命令和行为保持不变。

### 变更

- 包版本、发布说明和必要生成投影与 Foundation 0.19.2 数值对齐，不增加命令、能力或 adapter 路径。

### 升级说明

三个 Foundation 包须一起精确锁定到 0.19.2，并按既有来源身份与完整性规则重建官方 Bundle。能力目录、宿主 descriptor、driver、since 字段和成熟度均不变。
<!-- release-skill:changelog:end version=0.19.2 locale=zh-CN -->


<!-- release-skill:changelog:start version=0.19.1 locale=zh-CN baseline=sha256:832a8dfa16c41d6381cd2b0f00f58b096f45715332d42b7be11595976ab15e1e -->
## [0.19.1] - 2026-09-08

Engineering Kit 0.19.1 将兼容的批量流与结果合同修复投影到既有官方 Bundle。

### 修复

- 携带修正后的 Harness 传输行为和 Contracts 结果 Schema，不增加第二份实现或新的 Kit 命令。
- 内置能力目录区分三类失败阶段：预检拒绝不会调用机制；输出容量拒绝可能发生在当前项执行后；输出通道失败可能已有部分字节送出。

### 升级说明

三个 Foundation 包须一起精确锁定到 0.19.1，并按既有来源身份与完整性规则重建官方 Bundle。能力仍为 candidate，since 0.19.0 保持不变；目录命中不构成稳定采用声明。
<!-- release-skill:changelog:end version=0.19.1 locale=zh-CN -->


<!-- release-skill:changelog:start version=0.19.0 locale=zh-CN baseline=sha256:f000b13d13ce11660aaa4c5a1b450af39f99cb62a5177467783d863e7f411296 -->
## [0.19.0] - 2026-09-07

Engineering Kit 0.19.0 把新批量传输投影进官方离线 Bundle，并在内置能力目录登记 mechanism-batch 能力。

### 新增

- 官方 Bundle 投影携带 runMechanismCliBatch、--batch CLI 模式、两个机制批量 Schema 与冻结的批量容量政策，来源身份、摘要与完整性处理不变。
- 能力目录新增 foundation.harness.mechanism-batch：since 0.19.0、stability candidate，并登记意图、失败语义与直接测试引用。

### 变更

- 采用指导补充批量选择规则：同进程调用保留既有对象入口；跨进程、相互独立且容量允许的 canonical-json 请求可作为批量候选；有依赖或超限请求保留原路径。

### 升级说明

三个 Foundation 包须一起精确锁定到 0.19.0，升级后按既有包身份与 provenance 规则重建官方 Bundle。该目录条目为候选能力：目录命中不构成稳定采用声明。
<!-- release-skill:changelog:end version=0.19.0 locale=zh-CN -->


<!-- release-skill:changelog:start version=0.18.0 locale=zh-CN baseline=sha256:c8c2891b64fc31e1fb3754715da04d6ec0727b31e36e011d38735e45795cdd53 -->
## [0.18.0] - 2026-09-05

Engineering Kit 0.18.0 将 Harness 稳定的 replaceFixedSetAtomic 导出投影到既有离线 Quickstart Bundle。

### 新增

- 既有 candidate Bundle 携带稳定的固定集合替换源码、加载器、原生闭包与 replaceFixedSetAtomic 导出；不新增平行实现，也不增加 Kit 命令。

### 变更

- 包版本与 Contracts、Harness 一同升至 0.18.0，runProjection 继续作为 Bundle 的写入与授权边界。

### 升级说明

三个 Foundation 包须一起精确锁定到 0.18.0，并从这些已安装包的精确字节重建受管 Bundle。Bundle 消费者获得相同的非幂等替换语义，不得盲目重试提交后或不确定结果。
<!-- release-skill:changelog:end version=0.18.0 locale=zh-CN -->


<!-- release-skill:changelog:start version=0.17.0 locale=zh-CN baseline=sha256:7c413da3ad02837bdd63a1b49a5dc78cefe15a9779a05ce070876f817d09ae65 -->
## [0.17.0] - 2026-09-01

Engineering Kit 0.17.0 将 CodeBuddy 与 WorkBuddy 的宿主验证分开，并新增按需启用的提供方工程基线结构比较。

### 新增

- 新增 codebuddy-print-v1 driver，按 CodeBuddy 的 .codebuddy/skills 项目目录发现技能；既有 workbuddy-codebuddy-print-v1 driver 与 WorkBuddy 布局保持不变。
- 新增 describeSkeletonReferenceImplementation，并由 scaffoldTarget 返回该参考骨架身份。
- adopt-plan 新增须成对使用的 --engineering-baseline 与 --compare-skeleton。结果只报告参考侧独有、目标侧独有、条目类型和文件类别差异，不裁定合规、等价、严重程度或豁免。

### 变更

- public-plugin 骨架生成的 check 脚本新增 skill-family-kit check entries --root .；其他 Profile 的检查命令保持不变。
- 宿主管理的登录态、领域验收和真实宿主资格继续归消费者负责。

### 升级说明

三个 Foundation 包须一起精确锁定到 0.17.0。CodeBuddy 与 WorkBuddy 即使消费同一插件载荷，也必须走独立宿主路由。基线比较只读且按需启用；规则语义与基线发布仍由基线提供方负责。
<!-- release-skill:changelog:end version=0.17.0 locale=zh-CN -->


<!-- release-skill:changelog:start version=0.16.0 locale=zh-CN baseline=sha256:1db170e8f4ae8ca25301b4e5893d86a0f486218fa75f9bcc0ced2a5eba7d26d6 -->
## [0.16.0] - 2026-08-31

Engineering Kit 0.16.0 收紧五个固定 driver 的候选宿主验证回归，要求共用一个 workload 并核对消费者业务答案。

### 变更

- 通过既有 `runHostVerification` 路径核对 Claude、Codex、Kimi、Qoder 与 WorkBuddy 使用同一候选绑定，并暴露调用方的业务答案。
- 保持宿主管理状态、领域接受规则和真实宿主资格归调用方负责；不新增 Kit 命令或生命周期能力。

### 升级说明

五宿主检查只验证现有候选 API，不会把 fixture 或测试结果升级为真实宿主资格；领域断言与宿主授权仍由消费者负责。
<!-- release-skill:changelog:end version=0.16.0 locale=zh-CN -->


<!-- release-skill:changelog:start version=0.15.0 locale=zh-CN baseline=sha256:c559c91bed872ab70dac2a4836c636b35ed905282f4aa4cdcf56d21a1ce246b9 -->
## [0.15.0] - 2026-08-29

Engineering Kit 0.15.0 增加固定的 native-lifecycle 与 Kimi 目录资格入口。

### 新增

- 增加 Qoder 与 WorkBuddy 封闭十二阶段生命周期 fixture 解析。
- 增加 Kimi 目录资格检查，使用 driverVersion 1.0.0 与 CLI 0.39.1 接纳规则。

### 变更

- 资格检查直接将 Contracts、Harness 版本与 KIT_VERSION 比较。

### 升级说明

fixture 只证明解析器接线；正式进程、目录和领域接受观察仍由消费者负责。
<!-- release-skill:changelog:end version=0.15.0 locale=zh-CN -->


<!-- release-skill:changelog:start version=0.14.0 locale=zh-CN baseline=sha256:c3c9e90c2c1e4c06d34871d18ba4062db46e484cbeccbf25867d8b59db32ccc0 -->
## [0.14.0] - 2026-08-28

Engineering Kit 0.14.0 增加能力发现、迁移指引、消费者契约测试接线和显式资格检查入口。

### 新增

- 通过 `adopt-plan` 与 `list-capabilities` CLI 模式增加只读能力评估。
- 增加消费者契约测试脚手架指引，以及生成真实宿主证据的显式资格检查命令。

### 变更

- 明确区分候选发现、迁移完成、契约接入完成和真实宿主资格四种结论。

### 升级说明

三个 Foundation 包须一起精确锁定到 0.14.0。能力评估和迁移规划不写文件；契约向量与正式测试替身只证明接线；资格检查仍由消费者显式负责。
<!-- release-skill:changelog:end version=0.14.0 locale=zh-CN -->


<!-- release-skill:changelog:start version=0.13.0 locale=zh-CN baseline=sha256:3493c49151b2ebabddcba806d892ce967c0ae47621b0b2c75086e1cac334ebf9 -->
## [0.13.0] - 2026-08-26

Engineering Kit 0.13.0 源码候选增加完整插件验证，分别报告安装、发现和调用事实。

### 新增

- 新增永久候选根入口 runPluginVerification({ request, bindings, hostsRoot })。
- 保留完整插件布局并提供安装观察，载荷接受政策仍由调用方决定。

### 升级说明

三个包须精确锁步。runHostVerification 与 verifyHostVerificationBindings 继续用于单 Skill 验证。每个真实宿主与来源组合仍须取得资格证据；本次不代表发布完成或消费者机制已退出。
<!-- release-skill:changelog:end version=0.13.0 locale=zh-CN -->


<!-- release-skill:changelog:start version=0.12.0 locale=zh-CN baseline=sha256:f2a68cdeac0b2a44d7a4cc64df8e8f371795b4150719d821a31866a6e8873e2f -->
## [0.12.0] - 2026-08-26

Engineering Kit 0.12.0 将受约束真实宿主验证从两个固定内置驱动扩展为五个。

### 新增

- 为 runHostVerification 增加三个固定的内置驱动，保留 Kimi 与 WorkBuddy 的原始字节行为。

### 变更

- 插件目录驱动使用 plugin-root/skills/skill-id 经典插件布局；JSONL 驱动必须扫描完整事件流后才接受执行结果。
- 输出的业务含义由消费者判断，严格文本解码仅用于三个新增的文本协议驱动。
- Qoder 的宿主支持和 Descriptor 成熟度登记为 manual，真实宿主验证能力继续标为 candidate。

### 修复

- 拒绝畸形协议尾部、文本协议中的非法 UTF-8，以及驱动固定格式之外的版本后缀，避免产生错误的公共成功结果。

### 升级说明

三个 Foundation 包须精确锁定到同一 0.12.0 版本。runHostVerification、verifyHostVerificationBindings 入口与请求身份不变。验证复用宿主现有登录态；Foundation 不隔离认证、不固定模型身份、不关闭宿主工具，也不判定领域 PASS/FAIL。Qoder 验证不授予 build、plan、apply、install、update、uninstall 或 rollback 能力。可执行文件摘要仅是启动前观察，成员快照仅覆盖已声明成员的两个观察时点。
<!-- release-skill:changelog:end version=0.12.0 locale=zh-CN -->


<!-- release-skill:changelog:start version=0.11.0 locale=zh-CN baseline=sha256:5d5852f3fa3c970b4d277600a0886d533e3c883fc72ce144a85a071d1e270771 -->
## [0.11.0] - 2026-08-25

Engineering Kit 0.11.0 增加候选真实宿主验证 API，并随包携带已登记宿主 Profile 闭包。

### 新增

- 新增 runHostVerification，执行一次 fresh、受约束的 Kimi 或 WorkBuddy 调用（复用调用方现有登录态）；新增 verifyHostVerificationBindings，组合结果时只做纯校验。
- 从原始字节重算闭包和流摘要，并把私有证据留在公共结果之外。
- 通过 bundledHostProfilesRoot() 携带已登记宿主 Profile 闭包。

### 变更

- manual Profile 继续保留生命周期限制；宿主验证不会授予 build、plan、apply、install、update、uninstall 或 rollback 能力。

### 升级说明

0.11.0 宿主验证 API 仍为候选能力，不拥有领域 PASS/FAIL、发布状态或自动登录；不宣称认证状态隔离、凭证未变化、模型身份固定或宿主工具能力已关闭。executableSha256 只是启动前的点时观察，不证明实际执行映像；调用方独占对应命名空间。Foundation 保留 session 目录，调用方检查后清理外层 temporaryRoot。
<!-- release-skill:changelog:end version=0.11.0 locale=zh-CN -->


<!-- release-skill:changelog:start version=0.10.0 locale=zh-CN baseline=sha256:45180b7a3b60853842cbe3a379da7ff95f1bd1fe832192368ec2c92a813279dc -->
## [0.10.0] - 2026-08-24

Engineering Kit 0.10.0 为历史 candidate 提供职责明确的规范入口，增加受限的跨平台宿主身份、探针和本地生命周期能力，并提供同级适配器只读验证薄入口。

### 新增

- 新增 skill-family-engineering-kit/quickstart-profile、/adoption 与 /skill-naming 规范导出。
- 增加有限 Profile alias 解析、非 driver 宿主的独立手动 probe fact 和显式本地 install/update 计划；uninstall 仍要求人工恢复。
- 新增 `verifyHostPeers`，只包装 Harness 的 peer 验证，不增加第五个顶层命令，也不写入 peer 目录。

### 变更

- 历史 Quickstart candidate 导出继续作为同源迁移别名，Kit 四命令边界不变。
- 只编译一套规范 Quickstart 与批量校验 Schema；历史和规范 ID 指向同一 standalone validator。

### 升级说明

消费者应把三个包的精确 pin 更新到 0.10.0，并把导入与 Schema ID 一次迁移到规范身份。以后仅晋升成熟度标签时不另加 Bundle 重建要求；包身份、来源摘要或 provenance 变化仍按既有投影合同处理。
<!-- release-skill:changelog:end version=0.10.0 locale=zh-CN -->


<!-- release-skill:changelog:start version=0.9.0 locale=zh-CN baseline=sha256:c84db7b53f562cbdad947ccf8fcc23209f18137100270b2691bab7d9a7ad623c -->
## [0.9.0] - 2026-08-24

Engineering Kit 0.9.0 将稳定文件系统 Schema、绑定读取 Harness 闭包与有序批量校验 candidate 投影到既有 Quickstart Bundle。

### 新增

- 从 Contracts 权威源投影三个稳定文件系统 Schema 与两个批量校验 candidate Schema。
- 投影稳定绑定读取入口及其精确原生预构建闭包，不新增 Kit 命令。

### 变更

- 四个顶层 Kit 命令与 Profile SPI 的 candidate 边界保持不变。

### 升级说明

三个 Foundation 包必须精确锁定 0.9.0 并重新构建 managed Bundle；批量校验只能通过既有 candidate Bundle 与 mechanisms CLI 使用。
<!-- release-skill:changelog:end version=0.9.0 locale=zh-CN -->


<!-- release-skill:changelog:start version=0.8.4 locale=zh-CN baseline=sha256:38a973bb735c925e8453656ce24a11173b530c6376609d68dfb850d9029daa21 -->
## [0.8.4] - 2026-08-24

随 Foundation 0.8.4 锁步升版，补充外置 source authority 校验用法；Kit 命令与 Profile SPI 不变。

### 变更

- 包版本与 Contracts、Harness 一同升至 0.8.4。
- 说明消费者先经 Contracts 校验 source-authority receipt，再把返回坐标传入既有 sourceRepository 与 sourceBaseCommit 字段。
- 四个稳定顶层命令、builder、Profile SPI 与公共导出保持不变。

### 升级说明

消费者必须把三个 Foundation 包精确锁定到 0.8.4。provider Profile descriptor 从 0.8.3 与 Contracts 1.7.0 升级时，必须把自身的 base.contractsVersion 字段机械更新为 1.8.0。既有函数与 Schema 形状、Profile SPI v3、Kit 四命令均不需要迁移；需要 source authority 的消费者只增加调用 builder 前的 Contracts 校验步骤。
<!-- release-skill:changelog:end version=0.8.4 locale=zh-CN -->


<!-- release-skill:changelog:start version=0.8.3 locale=zh-CN baseline=sha256:3315d4594a7e28926b54dae3057c35d192b1e9293d07d22fd8856f44da2a7d80 -->
## [0.8.3] - 2026-08-23

随 Foundation 0.8.3 锁步升版；受管 Bundle 携带 Harness 的有界路径收容修复。

### 变更

- 包版本与 Contracts、Harness 一同升至 0.8.3；Kit 的四个稳定顶层命令与 Profile SPI 均保持不变。
- 重建受管 Bundle 会投影更新后的 Harness paths 模块，包括仅一次 ENOENT 锚点重求和保持不变的失败关闭边界。

### 升级说明

消费者必须把 Contracts、Harness 和 Engineering Kit 精确锁定到 0.8.3，再重建受管 Bundle；无需迁移 Kit API 或 Profile SPI。
<!-- release-skill:changelog:end version=0.8.3 locale=zh-CN -->


<!-- release-skill:changelog:start version=0.8.2 locale=zh-CN baseline=sha256:620f03e3fc81c1ef06d23b99fb0e70e547d58f3c6e956691b9c4a05e1b517c3b -->
## [0.8.2] - 2026-08-23

受管离线 Bundle 现在携带固定候选机制桥接所需的 strict-read 源码。

### 新增

- 把 strict-read.mjs 投影进受管 Bundle，并把它的 closure、errors 和 paths 依赖映射到相邻运行时模块。
- 在 Foundation provenance 中记录真实 strict-read.mjs 源码，并通过离线 runner 复验 read-file-strict。

### 变更

- 包版本与 Contracts、Harness 一同升至 0.8.2；Kit 的四个稳定顶层命令保持不变。

### 升级说明

消费者必须把 Contracts、Harness 和 Engineering Kit 精确锁定到 0.8.2，再重建受管 Bundle。修改工作树引用不会让已有 Bundle 获得 read-file-strict。
<!-- release-skill:changelog:end version=0.8.2 locale=zh-CN -->


<!-- release-skill:changelog:start version=0.8.1 locale=zh-CN baseline=sha256:67ed1129fc865709a1205d34c82521a6c7a7f6d9a914c0c400c21ad2767a841b -->
## [0.8.1] - 2026-08-22

宿主把 Engineering Kit 打包进单文件适配器后，Kit 仍能保留自身的包版本。

### 变更

- Contracts、Harness 与 Engineering Kit 一同升至 0.8.1；Contracts 1.7.0 与 Profile SPI v3 表面保持不变。

### 修复

- 用静态 JSON import 替换运行时基于 import.meta.url 的包清单查找。源码与普通安装包仍读取 Kit 自身清单，esbuild 则把同一版本值内联到宿主 bundle。
- 新增回归测试：把 Engineering Kit 作为第三方依赖打包成单一宿主入口，在包目录之外运行，并用包清单复核其报告版本。

### 升级说明

把 Engineering Kit 打包进宿主适配器的消费者必须精确锁定 0.8.1；源码和普通安装包消费者沿用现有 API，不需要迁移。
<!-- release-skill:changelog:end version=0.8.1 locale=zh-CN -->


<!-- release-skill:changelog:start version=0.8.0 locale=zh-CN baseline=sha256:0d8fb108ec3e89d5c6b6bea39fc6767a0e1c198546d243d86a963fc5855ed4a9 -->
## [0.8.0] - 2026-08-21

Profile SPI v3 新增 scaffold 项目 Profile 的直接校验，descriptor 校验保持兼容。

### 新增

- 新增 verifyProjectProfile({ projectRoot, profileRelPath? })，用于校验 skill-family.project-profile 声明。
- verifyProfile 继续只校验 descriptor，并复用 Contracts 拥有的 adoption 与 overrides 字段定义。
- 新增 SPE1008 PROJECT_PROFILE_INVALID；SPE1006 与 SPE1007 含义保持不变。

### 升级说明

项目根消费者必须锁定 engineering-kit 0.8.0 并调用 verifyProjectProfile；descriptor 消费者继续调用 verifyProfile，0.7.0 仍可使用。
<!-- release-skill:changelog:end version=0.8.0 locale=zh-CN -->


<!-- release-skill:changelog:start version=0.7.0 locale=zh-CN baseline=sha256:e6070267ab3db289caf998c4539055c3d39dfa16fb5bc7db44689b305fde2e81 -->
## [0.7.0] - 2026-08-21

本版导出公共规范投影闭包 builder buildProjectionClosure（FG-4），调用方经一个公共入口即可构造 compileProjectionPlan 可直接接受的计划闭包，不再复刻 Kit 私有的排序、序列化与摘要算法。

### 新增

- 新增公共 skill-family-engineering-kit/profile-spi 子路径。它投影三个 Profile SPI JSON 资源与 Contracts canonical profile-descriptor.schema.json，导出 Schema 加载器、verifyProfile、采用 pin 校验和只收紧 overrides 检查。纯数据校验器遇到 pin 缺失、符号链接或路径越界时失败关闭，绝不执行 Profile entrypoint。
- 新增 buildProjectionClosure：纯函数公共 builder，接受 {path, sha256, mode} 成员数组（可接受显式 type file），返回规范计划闭包 {digestAlgorithm sha256, digest, resourceCount, resources}，可原样作为 compileProjectionPlan 的 previousOwnedClosure 或 externalCandidateClosure；空数组返回合法的空闭包。
- builder 与编译器闭包复验共享同一规范化与摘要事实源：确定性 path.localeCompare 排序、重复路径与便携路径冲突拒绝、sha256(JSON.stringify(normalizedResources)) 字节合同；全部拒绝在既有 projection plan input invalid 领域内失败关闭（SFC2004 invalid-manifest）。

### 变更

- compileProjectionPlan 入参合同不变，四个顶层命令（scaffold、adopt-plan、projection、check）不变；全部 0.6.0 既有输入仍编译为字节不变的计划。包版本随 Foundation 线锁步，Contracts 机器合同保持 1.6.0。

### 升级说明

0.7.0 是投影闭包 builder 线。此前在本地组装计划闭包的调用方必须导入 buildProjectionClosure 并精确锁定 0.7.0。计划闭包（成员 {path, type, sha256, mode}）不是 harness computeResourceClosure 的资源闭包（成员 {path, role, exists, sha256}）——两者形状与用途不同，不能互换。
<!-- release-skill:changelog:end version=0.7.0 locale=zh-CN -->


<!-- release-skill:changelog:start version=0.6.0 locale=zh-CN baseline=sha256:e48a11bcbdffb317068cb751f914809360aa8f2e2b852b1e436696601f6a2a47 -->
## [0.6.0] - 2026-08-21

本版为 check 命令新增入口契约门禁与受控 relock 事务子动作，新增外部冻结权威投影绑定（FG-3），并承载九类 check 诊断（审计整改 C2）。

### 新增

- 新增 check entries 子动作：runEntryContractCheck 与 checkEntriesAction 运行共享入口契约门禁（SFA-ENTRY-003/004/005/007 与 SFA-CONTEXT-001/002），作用于 skill-family.entry-contract.json 与 SKILL.md 字节；只诊断、零写入。
- 新增 check relock 子动作：runRelock 与 relockAction 是零写入规则的唯一受控例外——一次失败关闭事务，精确写入两个受收容状态文档（.foundation/file-registry.json 与 skill-family.managed-file-lock.json），首次写入前做漂移校验，任何拒绝下零写入。
- 新增外部冻结权威投影绑定（FG-3）：PROJECTION_AUTHORITY_BINDING_KINDS 冻结 external-root 与 caller-bytes；external-root 经严格不跟随读取器从独立的冻结目录重读每个权威源，caller-bytes 将调用方提供的 base64 权威字节绑定到声明的 sha256 摘要、完全不访问权威文件系统，使目标根内不存在伪造的本地权威事实。

### 变更

- check 诊断扩展为九类（新增版本单源一致性、公开边界校验、平台子集限制声明校验）；COMMAND_SIDE_EFFECTS 现记录 entries 与 relock 子动作语义。
- 四个顶层命令（scaffold、adopt-plan、projection、check）保持不变；entries 与 relock 是 check 子动作，不是新命令。

### 升级说明

0.6.0 是 Kit 门禁补齐线。权威不在目标根内的投影必须声明 kind 为 external-root 或 caller-bytes 的 authorityBinding，并精确锁定 0.6.0。
<!-- release-skill:changelog:end version=0.6.0 locale=zh-CN -->


<!-- release-skill:changelog:start version=0.5.0 locale=zh-CN baseline=sha256:bdeefb2e456f6e9d1348152b464c701e96a739e514c5a08ca3576e9982e9b7e0 -->
## [0.5.0] - 2026-08-16

本版保持 Kit 稳定四命令边界不变，并把离线消费者验证门加固为覆盖三个 Foundation 包的完整第三方生产闭包。

### 新增

- 加固离线消费者验证门：candidate-profile-bundle 与 tarball-source-binding 测试中的第三方闭包推导从单包闭包扩展为三个 Foundation 包的完整生产闭包（真实身份去重、npm: 别名感知、range-scoped override selector、对 pnpm 真实本地存储目录的字节身份），使 harness 运行时依赖评审决策（FND-ADR-011）持续对着真实安装字节被验证。

### 变更

- 稳定四命令（scaffold、adopt-plan、projection、check）保持不变。
- 延续 0.4.0 的 adoption CLI 候选与 Quickstart Profile v2 离线 Bundle；0.5.0 未新增或移除任何 Kit 边界或候选入口。

### 升级说明

0.5.0 已发布到 npm 与 public 镜像仓。Kit 公开面与 0.4.0 相同；面向新的契约规格 1.5.0 线请把包精确锁定为 0.5.0。
<!-- release-skill:changelog:end version=0.5.0 locale=zh-CN -->


<!-- release-skill:changelog:start version=0.4.0 locale=zh-CN baseline=sha256:0305934fb2f833eff10b17014f551533bfca9e9e51d3820a5a1e62613a3edb6a -->
## [0.4.0] - 2026-08-16

本版为 Engineering Kit 新增候选 adoption CLI 与 adoption mechanisms，同时保持稳定四命令边界与 0.3.0 的离线 Bundle 不变。

### 新增

- 新增 adoption-cli 候选：基于 stdin/stdout 的 CLI，通过 migration manifest 评估 adoption 绑定、遗留 exit list 与遗留引用，并校验 managed-bundle 身份与 harness 表面清单。
- 新增 adoption-mechanisms 候选模块，作为 adoption CLI 的共享实现。

### 变更

- 稳定四命令（scaffold、adopt-plan、projection、check）保持不变。
- 延续 0.3.0 的 Quickstart Profile v2 离线 Bundle（按 schema $id 选择的 standalone validator、完整 provenance 记录）与候选插件技能命名检查器。

### 升级说明

0.4.0 已发布到 npm 与 public 镜像仓。adoption CLI 是候选入口，须经显式 candidate 子路径调用，并把包精确锁定为 0.4.0。
<!-- release-skill:changelog:end version=0.4.0 locale=zh-CN -->


<!-- release-skill:changelog:start version=0.3.0 locale=zh-CN baseline=sha256:ddb48e61ef87de545348880216ee283b5d0165305dd5dfd8e044929b93ec4673 -->
## [0.3.0] - 2026-08-12

本源码候选版构建确定性的 Quickstart Profile v2 Bundle，运行时不依赖 Foundation 包、node_modules 或 Ajv。

### 新增

- 接收显式消费者 Schema 文件与来源身份，生成按 Schema $id 选择的 standalone validator。
- 完整记录来源与 payload provenance、包管理器身份，以及实际进入 Bundle 的第三方代码许可证。
- 新增候选插件技能命名检查器（policy JSON 加构建期 CLI）：扫描插件 skills 根目录，对前缀命名、description 领域信号与路由入口范围三条规则逐项输出 PASS/FAIL。

### 变更

- 替换与 0.2.1 不兼容的依赖闭包 Bundle；仍依赖 v1 的消费者必须继续精确锁定 0.2.1。
- 机械投影 Contracts 与 Harness 运行代码，同时保持 Kit 稳定的四命令边界。

### 升级说明

0.3.0 当前只是本地、未发布的源码候选。采用 v2 时，应从冻结输入重新生成受管 Bundle，并把 builder 精确锁定为 0.3.0。
<!-- release-skill:changelog:end version=0.3.0 locale=zh-CN -->


<!-- release-skill:changelog:start version=0.2.1 locale=zh-CN baseline=sha256:f43f41fadfa1dc9affd87825a382af6aed91050ef36a0c0854a6b04c2ba7fcea -->
## [0.2.1] - 2026-08-10

本版新增 Quickstart Profile 候选投影包，同时保持 Kit 四命令边界，并补齐双语包发布文档。

### 新增

- 新增候选构建函数与 CLI，用于生成确定性、自包含的 Quickstart Profile 投影包，并记录源码闭包与投影包摘要。
- 新增完整的英文与简体中文包文档，并补充智能体快速参考章节。

### 变更

- 使用同一份双语版本化说明源管理当前 README 与 CHANGELOG 的发布区域。
- 项目 NOTICE 与现有第三方声明及许可证闭包分开分发。

### 升级说明

候选投影包仍受既有 projection 授权边界约束。它不增加第五个 Kit 顶层命令，也不替代 THIRD_PARTY_NOTICES。
<!-- release-skill:changelog:end version=0.2.1 locale=zh-CN -->
