# 变更日志

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
