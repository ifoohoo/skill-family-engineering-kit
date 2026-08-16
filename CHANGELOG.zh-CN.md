# 变更日志

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
