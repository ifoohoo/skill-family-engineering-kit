<!-- release-skill:safe-first-command -->
<!-- release-skill:external-write-boundary -->

# skill-family-engineering-kit

开发与 CI 阶段使用的工程工具包。**恰好四个**顶层命令，没有第五个：

| 命令 | 用途 | 副作用 |
| --- | --- | --- |
| `scaffold` | 在空目录生成 Skill Family 项目骨架 | 只向空目标目录写入骨架文件（原子写、路径收容）；非空或冲突目标被拒绝且不被触碰 |
| `adopt-plan` | 严格只读地规划存量仓采用 | 无——不写任何文件（含临时文件），不运行 git 写命令；计划输出到 stdout |
| `projection` | 投影受管生成物 | 只写 manifest 授权且被目标声明为受管的路径；未授权、手写与越界路径一律拒绝（拒绝时零写入） |
| `check` | 契约/漂移/闭包/版本/文档事实/Git 前置状态诊断 | 无——只诊断、绝不自动修复；git 仅只读探测 |

## 使用

```sh
node packages/skill-family-engineering-kit/src/cli.mjs --help
node packages/skill-family-engineering-kit/src/cli.mjs scaffold --root <empty-dir> --project-id my-project
node packages/skill-family-engineering-kit/src/cli.mjs adopt-plan --root <repo>
node packages/skill-family-engineering-kit/src/cli.mjs projection --root <repo>
node packages/skill-family-engineering-kit/src/cli.mjs check --root <repo>
```

## 边界机制

- `scaffold` 的目标必须是**空目录**（任何条目含点文件都算非空），或其父目录已存在的不存在路径（只创建最后一级）。
  全部写入经 harness 的原子收容写（`writeFileAtomic`），失败不留半成品，路径不能越出目标根。
- `adopt-plan` 结构性只读：实现中不存在任何写调用，连临时文件都不产生；计划字节与 `scaffold`
  同源（`describeSkeletonFiles` 单一事实源），因此「计划即动作」。dirty 仓运行前后字节级零变化。
- `projection` 采用两阶段执行：先对每个条目做路径分类、收容预检、自投影检查、manifest 授权检查、
  手写保护与冲突守卫；任一条目违规则整体拒绝、零写入。覆盖既有文件必须声明精确的 `expect.sha256`
  前置状态；内容相同的既有文件是幂等 no-op。写入失败时尽力还原已覆盖文件的前置字节。
- `check` 只诊断：无写调用、无 `--fix/--apply/--repair` 模式（此类标志在入口处被拒绝）。
  Git 前置状态仅用文件系统事实加至多一次冻结参数矢量的只读 `git status --porcelain=2`
  （`--no-optional-locks` + `GIT_OPTIONAL_LOCKS=0`，不刷新索引）。

## 错误码与退出码

错误码复用 contracts 冻结的 SFC\* 体系，不新增码：

- `SFC2002`（UNKNOWN_OPERATION）——入口收到四命令词表之外的命令名；
- `SFC2003`（INVALID_PARAMS）——选项/参数值违规，或请求 `--fix` 等不存在的变更模式；
- `SFC2004`（EXECUTION_FAILED）——执行期失败，`details.kind` 为稳定的 kit 级 kind
  （如 `target-not-empty`、`unauthorized-path`、`handwritten-overwrite`、`conflict-drift`）；
  harness 抛出的收容类 kind（`path-traversal`、`symlink-escape` 等）原样透传；
- `SFC1001`（SCHEMA_VALIDATION_FAILED）——`check` 发现的合同文档未通过注册 Schema。

进程退出码：`0` 成功/无发现；`1` check 有发现；`2` 拒绝/用法/机制错误。

## 目标工作区文档约定

- `skill-family.project-manifest.json` —— contracts 的 project-manifest 实例（项目身份与 managedFiles 声明）；
- `skill-family.managed-file-lock.json` —— contracts 的 managed-file-lock 实例（受管路径与内容哈希锁定）；
- `skill-family.projection.json` —— projection 的授权 manifest（kit 级文档）。

projection 只写同时满足两个条件的路径：manifest 列出，且目标自身的登记
（file-registry / project-manifest managedFiles / managed-file-lock）声明为受管。
匹配手写模式的路径永不写入，即使有受管声明也拒绝。

## 禁止项

本包不得执行 git init、commit、push、tag、stash、分支切换、发布、删除、远端写入或发布状态复述；
不实现第五个顶层命令；不做业务判断、模型调用、远程网络。

## 安装

```sh
npm install skill-family-engineering-kit
```

## 故障诊断

`check` 退出码 1 表示有发现，退出码 2 表示用法或机制错误。如失败，确认目标仓库存在且 `skill-family.project-manifest.json` 形状合法；路径越界或手写保护触发时命令会拒绝写入并报告 `SFC2004`。
