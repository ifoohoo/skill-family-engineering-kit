#!/usr/bin/env node
import { realpathSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { bundledProfilesRoot } from "./licensing.mjs";
import {
  COMMAND_SIDE_EFFECTS,
  KIT_EXIT_CODES,
  REFUSED_MUTATION_FLAGS,
  runCommand,
  TOP_LEVEL_COMMANDS,
  unknownCommandError,
  invalidParamsError,
  mutationModeError,
} from "./index.mjs";

/**
 * skill-family-engineering-kit CLI.
 *
 * Exactly four top-level commands exist; there is no fifth. Exit codes are
 * stable: 0 = ok/clean, 1 = findings (check), 2 = rejected/usage/mechanism
 * error. Every refusal prints its registered SFC code and stable kind.
 */

const HELP_TEXT = `skill-family-engineering-kit —— 构建期工程工具包（恰好四个顶层命令）

用法: skill-family-kit <command> [options]

命令（四且仅四）:
  scaffold     在空目录生成 Skill Family 项目骨架。
               副作用: 只向空目标目录写入骨架文件（原子写、路径收容）；
               非空或冲突目标被拒绝且不被触碰。
  adopt-plan   严格只读地规划存量仓采用与迁移闭环。
               副作用: 无 —— 不写任何文件（含临时文件），不运行 git 写命令，
               不改名、不触碰远端；输出精确写集、冲突、风险、旧实现退出清单、
               临时例外校验与迁移完成判定（JSON 到 stdout）。
  projection   投影受管生成物。
               副作用: 只写 manifest 授权且被目标声明为受管的路径；
               未授权路径、手写文件与越界路径一律拒绝（拒绝时零写入）。
  check        契约/漂移/闭包/版本/文档事实/Git 前置状态诊断。
               副作用: 无 —— 只诊断、绝不自动修复，git 仅只读探测。

全局选项:
  --root <dir>  目标工作区根目录（默认当前目录）
  --help, -h    显示本帮助或单个命令的帮助

退出码: 0 成功/无发现；1 check 有发现；2 拒绝/用法/机制错误。
错误码复用 contracts 的 SFC* 体系（SFC2002/SFC2003/SFC2004 + 稳定 details.kind）。
禁止项: git init/commit/push/tag、发布、删除、远端写入；不存在第五个顶层命令。
`;

function commandHelp(command) {
  const sideEffect = COMMAND_SIDE_EFFECTS[command];
  const details = {
    scaffold: [
      "选项:",
      "  --root <dir>          目标目录（必须为空，或其父目录存在的不存在路径）",
      "  --project-id <id>     kebab-case 项目 id（默认取目录名）",
      "  --project-name <name> 人类可读项目名（默认同 id）",
      "  --profile <id>        Profile id（默认 generic）",
      "  --licensing-profile <id> 许可证 Profile id（默认 registry 第一个变体）",
      "  --licensing-variant <id> 多变体 Profile 的必选变体 id",
      "  --profiles-root <dir> 许可证 Profile 根目录",
    ],
    "adopt-plan": [
      "选项:",
      "  --root <dir>          目标工作区（默认当前目录）",
      "  --project-id <id>     计划采用的项目 id（默认取目录名）",
      "  --profile <id>        目标 Profile id（默认 generic）",
      "  --licensing-profile <id> 许可证 Profile id（默认 registry 第一个变体）",
      "  --licensing-variant <id> 多变体 Profile 的必选变体 id",
      "  --profiles-root <dir> 许可证 Profile 根目录",
      "  --no-git-spawn        禁用只读 git status 探测，仅用文件系统事实",
      "",
      "  迁移闭环（FND-070）: 只读读取目标仓 skill-family.migration.json",
      "  （旧实现退出清单 + 临时例外）；例外缺 owner/reason/deadline/",
      "  migrationTarget 任一字段即计为冲突；到期例外不自动续期；",
      "  旧实现未全部退出时完成判定恒为 false（双轨接入不算完成）。",
    ],
    projection: [
      "选项:",
      "  --root <dir>          目标工作区（默认当前目录）",
      "  --manifest <relpath>  投影 manifest 相对路径（默认 skill-family.projection.json）",
    ],
    check: [
      "选项:",
      "  --root <dir>          目标工作区（默认当前目录）",
      "  --only <class>        只运行一个诊断类: contracts|drift|closure|version|docs|git|identity",
      "  --profiles-root <dir> 许可证 Profile 根目录",
      "  --no-git-spawn        禁用只读 git status 探测，仅用文件系统事实",
    ],
  };
  return [
    `${command} —— ${sideEffect.summary}`,
    `副作用: ${sideEffect.sideEffect}`,
    "",
    ...details[command],
    "",
    `退出码: ${sideEffect.exitCodes}`,
  ].join("\n");
}

function printError(error) {
  const code = error && error.code ? error.code : "SFC2004";
  const kind = error && error.details && error.details.kind ? ` (${error.details.kind})` : "";
  process.stderr.write(`[kit] ${code}${kind}: ${error && error.message ? error.message : String(error)}\n`);
}

function parseOptions(argv, spec) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (REFUSED_MUTATION_FLAGS.includes(arg)) {
      throw mutationModeError(arg, spec.command);
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    const flagSpec = spec.flags[arg];
    if (!flagSpec) {
      throw invalidParamsError(`unknown option for '${spec.command}': ${arg}`, { flag: arg });
    }
    if (flagSpec.value) {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) {
        throw invalidParamsError(`option ${arg} requires a value`, { flag: arg });
      }
      options[flagSpec.key] = value;
    } else {
      options[flagSpec.key] = true;
    }
  }
  return options;
}

const COMMAND_SPECS = {
  scaffold: {
    flags: {
      "--root": { key: "root", value: true },
      "--project-id": { key: "projectId", value: true },
      "--project-name": { key: "projectName", value: true },
      "--profile": { key: "profileId", value: true },
      "--licensing-profile": { key: "licensingProfile", value: true },
      "--licensing-variant": { key: "licensingVariant", value: true },
      "--profiles-root": { key: "profilesRoot", value: true },
    },
  },
  "adopt-plan": {
    flags: {
      "--root": { key: "root", value: true },
      "--project-id": { key: "projectId", value: true },
      "--project-name": { key: "projectName", value: true },
      "--profile": { key: "profileId", value: true },
      "--licensing-profile": { key: "licensingProfile", value: true },
      "--licensing-variant": { key: "licensingVariant", value: true },
      "--profiles-root": { key: "profilesRoot", value: true },
      "--no-git-spawn": { key: "noGitSpawn", value: false },
    },
  },
  projection: {
    flags: {
      "--root": { key: "root", value: true },
      "--manifest": { key: "manifest", value: true },
    },
  },
  check: {
    flags: {
      "--root": { key: "root", value: true },
      "--only": { key: "only", value: true },
      "--profiles-root": { key: "profilesRoot", value: true },
      "--no-git-spawn": { key: "noGitSpawn", value: false },
    },
  },
};

export async function cliMain(argv) {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(HELP_TEXT);
    return KIT_EXIT_CODES.ok;
  }
  const command = argv[0];
  if (!TOP_LEVEL_COMMANDS.includes(command)) {
    printError(unknownCommandError(command));
    return KIT_EXIT_CODES.rejected;
  }

  try {
    const options = parseOptions(argv.slice(1), { command, flags: COMMAND_SPECS[command].flags });
    if (options.help) {
      process.stdout.write(`${commandHelp(command)}\n`);
      return KIT_EXIT_CODES.ok;
    }
    const { exitCode, output } = await runCommand(command, {
      root: options.root ?? ".",
      projectId: options.projectId,
      projectName: options.projectName,
      profileId: options.profileId,
      licensingProfile: options.licensingProfile,
      licensingVariant: options.licensingVariant,
      profilesRoot: options.profilesRoot ?? bundledProfilesRoot(),
      manifest: options.manifest,
      only: options.only,
      allowGitSpawn: !options.noGitSpawn,
    });
    if (output !== undefined) {
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    }
    return exitCode;
  } catch (error) {
    printError(error);
    return KIT_EXIT_CODES.rejected;
  }
}

// Direct-execution detection must survive symlinked package bins (pnpm
// .bin shims): compare real paths, not the raw argv[1] URL.
function isDirectExecution() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isDirectExecution()) {
  cliMain(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
