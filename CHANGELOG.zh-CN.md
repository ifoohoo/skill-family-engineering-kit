# 变更日志

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
