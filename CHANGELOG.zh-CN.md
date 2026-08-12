# 变更日志

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
