#!/usr/bin/env node
import { realpathSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readFileContained, resolveContained } from "skill-family-harness-node";
import { bundledProfilesRoot } from "./licensing.mjs";
import { checkReportAction, renderReportAction } from "./report.mjs";
import {
  COMMAND_SIDE_EFFECTS,
  KIT_EXIT_CODES,
  REFUSED_MUTATION_FLAGS,
  runCommand,
  TOP_LEVEL_COMMANDS,
  unknownCommandError,
  invalidParamsError,
  mutationModeError,
  describeHost,
  probeHost,
  buildHostAdapter,
  materializeHostBuild,
  planHost,
  refuseHostApply,
} from "./index.mjs";

/**
 * skill-family-engineering-kit CLI.
 *
 * Exactly four top-level commands exist; there is no fifth. The report layer
 * (FND-ADR-005) hangs under two of them as positional sub-actions —
 * `projection report` (render) and `check report` (graded diagnosis) — not as
 * a fifth command. Exit codes are stable: 0 = ok/clean, 1 = findings (check),
 * 2 = rejected/usage/mechanism error. Every refusal prints its registered
 * SFC code and stable kind.
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
               报告子动作: projection report 将调用方提交的 report-model 确定性渲染为
               中立 Markdown（FND-ADR-005）；默认只写 stdout，给定 --out/
               --binding 时只写这两个显式且被 --root 收容的路径（原子写）。
  check        契约/漂移/闭包/版本/文档事实/Git 前置状态诊断。
               副作用: 无 —— 只诊断、绝不自动修复，git 仅只读探测。
               报告子动作: check report 对一份已渲染报告做分级诊断：
               硬失败（SFC3001/3002/3003）计为发现（退出码 1）；
               风格告警只报告、绝不阻塞机器正确的报告。

全局选项:
  --root <dir>  目标工作区根目录（默认当前目录）
  --help, -h    显示本帮助或单个命令的帮助

退出码: 0 成功/无发现；1 check 有发现；2 拒绝/用法/机制错误。
错误码复用 contracts 的 SFC* 体系（SFC2002/SFC2003/SFC2004 + 稳定 details.kind；
报告层硬失败使用 SFC3001/SFC3002/SFC3003）。
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
      "",
      "宿主构建: skill-family-kit scaffold host-build --root <workspace> --host <id>",
      "  --path-category <id> --input <relpath> --out <relpath> [--hosts-root <dir>]",
      "  将完整 source closure 逐字节写入 sibling staging，验证后一次 rename；目标必须不存在。",
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
      "只读宿主子动作: host-describe | host-probe | host-plan | host-apply",
      "  host-probe 默认不执行进程；仅 --allow-host-spawn + --host-executable <绝对路径> 可启用受审计版本向量；",
      "  host-plan 必须显式提供 --build-manifest/--probe-facts，绝不隐式探测；",
      "  host-apply 在本阶段稳定拒绝，且不会产生占位文件或临时目录。",
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
      "",
      "报告子动作: skill-family-kit projection report [options]",
      "  --model <relpath>     经 Contracts 验证的 report-model JSON（必填）",
      "  --result <relpath>    机器结果 JSON（必填，仅用于摘要和错误绑定核对）",
      "  --out <relpath>       报告 Markdown 输出路径；缺省时 Markdown 只写 stdout",
      "  --binding <relpath>   同时写出 report-binding JSON（model/result/report 三摘要）",
      "  确定性: 同一 report-model 反复渲染字节一致；Harness 不推导状态、不补造事实。",
    ],
    check: [
      "选项:",
      "  --root <dir>          目标工作区（默认当前目录）",
      "  --only <class>        只运行一个诊断类: contracts|drift|closure|version|docs|git|identity",
      "  --profiles-root <dir> 许可证 Profile 根目录",
      "  --no-git-spawn        禁用只读 git status 探测，仅用文件系统事实",
      "",
      "报告子动作: skill-family-kit check report [options]",
      "  --report <relpath>    已渲染报告 Markdown（必填，只读）",
      "  --model <relpath>     对应 report-model JSON（必填，只读）",
      "  --result <relpath>    对应机器结果 JSON（必填，只读；核对 digest/errors）",
      "  --binding <relpath>   可选 report-binding JSON；摘要过期即 SFC3001",
      "  分级: 硬失败（SFC3001/3002/3003）计为发现，退出码 1；",
      "  风格告警（超长句/重复段/翻译腔/未解释术语）只报告、绝不改变判定。",
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
  "projection report": {
    flags: {
      "--root": { key: "root", value: true },
      "--model": { key: "model", value: true },
      "--result": { key: "result", value: true },
      "--out": { key: "out", value: true },
      "--binding": { key: "binding", value: true },
    },
  },
  "check report": {
    flags: {
      "--root": { key: "root", value: true },
      "--report": { key: "report", value: true },
      "--model": { key: "model", value: true },
      "--result": { key: "result", value: true },
      "--binding": { key: "binding", value: true },
    },
  },
  "scaffold host-build": {
    flags: {
      "--root": { key: "root", value: true },
      "--host": { key: "hostId", value: true },
      "--path-category": { key: "pathCategoryId", value: true },
      "--input": { key: "input", value: true },
      "--out": { key: "out", value: true },
      "--hosts-root": { key: "hostsRoot", value: true },
    },
  },
  "adopt-plan host-describe": {
    flags: { "--host": { key: "hostId", value: true }, "--hosts-root": { key: "hostsRoot", value: true } },
  },
  "adopt-plan host-probe": {
    flags: {
      "--host": { key: "hostId", value: true },
      "--hosts-root": { key: "hostsRoot", value: true },
      "--allow-host-spawn": { key: "allowHostSpawn", value: false },
      "--host-executable": { key: "hostExecutable", value: true },
    },
  },
  "adopt-plan host-plan": {
    flags: {
      "--root": { key: "root", value: true },
      "--host": { key: "hostId", value: true },
      "--path-category": { key: "pathCategoryId", value: true },
      "--build-manifest": { key: "buildManifest", value: true },
      "--probe-facts": { key: "probeFacts", value: true },
      "--hosts-root": { key: "hostsRoot", value: true },
    },
  },
  "adopt-plan host-apply": { flags: {} },
};

async function readJson(root, relPath, label) {
  if (!relPath) throw invalidParamsError(`${label} is required`);
  try {
    return JSON.parse((await readFileContained(root, relPath)).toString("utf8"));
  } catch (cause) {
    if (cause?.code?.startsWith?.("SFC")) throw cause;
    throw invalidParamsError(`${label} must name valid JSON contained in --root`);
  }
}

async function runHostSubAction(command, action, rest) {
  const specName = `${command} ${action}`;
  try {
    if (action === "host-apply") refuseHostApply();
    const spec = COMMAND_SPECS[specName];
    const options = parseOptions(rest, { command: specName, flags: spec.flags });
    const hostsRoot = options.hostsRoot;
    let output;
    if (action === "host-describe") {
      output = await describeHost({ hostId: options.hostId, hostsRoot });
    } else if (action === "host-probe") {
      output = await probeHost({ hostId: options.hostId, hostsRoot, allowSpawn: options.allowHostSpawn === true, executable: options.hostExecutable });
    } else if (action === "host-build") {
      const root = options.root ?? ".";
      const input = await readJson(root, options.input, "--input");
      const build = await buildHostAdapter({ hostId: options.hostId, pathCategoryId: options.pathCategoryId, input, hostsRoot });
      if (build.status === "built") {
        if (!options.out) throw invalidParamsError("--out is required");
        const targetRoot = await resolveContained(root, options.out);
        await materializeHostBuild({ targetRoot, build });
      }
      output = build.status === "built" ? { status: "built", manifest: build.manifest, outputRoot: options.out } : build;
    } else if (action === "host-plan") {
      const root = options.root ?? ".";
      const buildManifest = await readJson(root, options.buildManifest, "--build-manifest");
      const probeDocument = await readJson(root, options.probeFacts, "--probe-facts");
      const probeFacts = Array.isArray(probeDocument) ? probeDocument : probeDocument.facts;
      output = await planHost({ hostId: options.hostId, pathCategoryId: options.pathCategoryId, buildManifest, probeFacts, hostsRoot });
    }
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return KIT_EXIT_CODES.ok;
  } catch (error) {
    printError(error);
    return KIT_EXIT_CODES.rejected;
  }
}

async function runReportSubAction(command, rest) {
  const specName = `${command} report`;
  try {
    const options = parseOptions(rest, { command: specName, flags: COMMAND_SPECS[specName].flags });
    if (options.help) {
      process.stdout.write(`${commandHelp(command)}\n`);
      return KIT_EXIT_CODES.ok;
    }
    const action = command === "projection" ? renderReportAction : checkReportAction;
    const { status, output } = await action({
      root: options.root,
      model: options.model,
      result: options.result,
      report: options.report,
      out: options.out,
      binding: options.binding,
    });
    if (output !== undefined) {
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    }
    if (status === "ok") return KIT_EXIT_CODES.ok;
    if (status === "findings") return KIT_EXIT_CODES.findings;
    return KIT_EXIT_CODES.rejected;
  } catch (error) {
    printError(error);
    return KIT_EXIT_CODES.rejected;
  }
}

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

  // Positional report sub-actions (FND-ADR-005): `projection report` renders,
  // `check report` diagnoses. They hang under existing commands; the
  // four-command vocabulary and runCommand stay untouched.
  if ((command === "projection" || command === "check") && argv[1] === "report") {
    return runReportSubAction(command, argv.slice(2));
  }
  if (command === "scaffold" && argv[1] === "host-build") {
    return runHostSubAction(command, "host-build", argv.slice(2));
  }
  if (command === "adopt-plan" && ["host-describe", "host-probe", "host-plan", "host-apply"].includes(argv[1])) {
    return runHostSubAction(command, argv[1], argv.slice(2));
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
