#!/usr/bin/env node
import { realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readFileContained, resolveContained } from "skill-family-harness-node";
import { bundledProfilesRoot } from "./licensing.mjs";
import { checkEntriesAction } from "./entry-check.mjs";
import { relockAction } from "./relock.mjs";
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
import { buildCapabilityAssessment } from "./capability-assessment.mjs";
import { QUALIFICATION_NOTICE, runQualification } from "./qualification.mjs";

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
               入口契约子动作: check entries 运行共享入口契约门禁
               （SFA-ENTRY-003/004/005/007 + SFA-CONTEXT-001/002），
               读取 skill-family.entry-contract.json 声明；声明缺失是数据、不是发现。
               受控重锁子动作: check relock 运行受控 relock 事务（SG-36）：
               把新手写文件登记进 .foundation/file-registry.json，并以当前字节
               重算 skill-family.managed-file-lock.json（单次 fail-closed 事务；
               只写这两个收容状态文档，任何拒绝都零写入）。
               显式资格子动作: check qualification 仅在显式提供
               capability/request/bindings/native 后适配目录声明的能力特定入口。

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
      "  --capability <id>      可重复的稳定能力 ID（重复值会去重并按 ASCII 排序）",
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
      "  --engineering-baseline <relative-json-path>  工程基线合同（须与 --compare-skeleton 成对）",
      "  --compare-skeleton    只读比较基线参考骨架与目标结构",
      "",
      "  能力查询（仍属于 adopt-plan，不增加顶层命令）:",
      "  --list-capabilities --locale <en|zh-CN>",
      "    覆盖: --all --scope <scope>",
      "    项目评估: --all --scope <scope> --uses <relative-json-path>",
      "    单需求: [--scope <scope>] [--filter <text>] [--limit <1..10>]",
      "    精确展开: --capability <exact-id>",
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
      "  --only <class>        只运行一个诊断类: contracts|drift|closure|version|docs|git|identity|boundary|platform",
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
      "",
      "显式资格子动作: skill-family-kit check qualification [options]",
      "  --root <dir>          消费方工作区（--request/--bindings 文件必须收容其中）",
      "  --capability <id>     foundation.kit.plugin-verification 或 foundation.kit.skill-family-directory-verification",
      "  --request <relpath>   受注册合同约束的 plugin-verification-request 或目录 request JSON",
      "  --bindings <relpath>  受对应固定资格入口约束的私有绑定 JSON",
      "  --native              显式确认允许本次真实资格；缺失即零宿主副作用。",
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
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (REFUSED_MUTATION_FLAGS.includes(arg)) {
      throw mutationModeError(arg, spec.command);
    }
    if (arg === "--help" || arg === "-h") {
      if (seen.has("help")) {
        throw invalidParamsError(`duplicate option for '${spec.command}': --help`, { reason: "duplicate-option", flag: "--help" });
      }
      seen.add("help");
      options.help = true;
      continue;
    }
    const flagSpec = spec.flags[arg];
    if (!flagSpec) {
      throw invalidParamsError(`unknown option for '${spec.command}': ${arg}`, { flag: arg, reason: "unknown-option" });
    }
    if (spec.rejectDuplicates && seen.has(arg) && !flagSpec.repeat) {
      throw invalidParamsError(`duplicate option for '${spec.command}': ${arg}`, { reason: "duplicate-option", flag: arg });
    }
    seen.add(arg);
    if (flagSpec.value) {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) {
        throw invalidParamsError(`option ${arg} requires a value`, { flag: arg, reason: "missing-option-value" });
      }
      if (flagSpec.repeat) {
        if (!Array.isArray(options[flagSpec.key])) options[flagSpec.key] = [];
        options[flagSpec.key].push(value);
      } else {
        options[flagSpec.key] = value;
      }
    } else {
      options[flagSpec.key] = true;
    }
  }
  return options;
}

const COMMAND_SPECS = {
  scaffold: {
    rejectDuplicates: true,
    flags: {
      "--root": { key: "root", value: true },
      "--project-id": { key: "projectId", value: true },
      "--project-name": { key: "projectName", value: true },
      "--profile": { key: "profileId", value: true },
      "--licensing-profile": { key: "licensingProfile", value: true },
      "--licensing-variant": { key: "licensingVariant", value: true },
      "--profiles-root": { key: "profilesRoot", value: true },
      "--capability": { key: "capabilities", value: true, repeat: true },
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
      "--engineering-baseline": { key: "engineeringBaselinePath", value: true },
      "--compare-skeleton": { key: "compareSkeleton", value: false },
      "--list-capabilities": { key: "listCapabilities", value: false },
      "--scope": { key: "scope", value: true },
      "--locale": { key: "locale", value: true },
      "--all": { key: "all", value: false },
      "--uses": { key: "uses", value: true },
      "--filter": { key: "filter", value: true },
      "--capability": { key: "capability", value: true },
      "--limit": { key: "limit", value: true },
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
  "check entries": {
    flags: {
      "--root": { key: "root", value: true },
    },
  },
  "check relock": {
    flags: {
      "--root": { key: "root", value: true },
      "--files": { key: "files", value: true },
    },
  },
  "check qualification": {
    rejectDuplicates: true,
    flags: {
      "--root": { key: "root", value: true },
      "--capability": { key: "capability", value: true },
      "--request": { key: "requestPath", value: true },
      "--bindings": { key: "bindingsPath", value: true },
      "--native": { key: "native", value: false },
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

async function readEngineeringBaselineJson(root, relPath) {
  if (
    typeof relPath !== "string"
    || relPath.length === 0
    || relPath.includes("\0")
    || path.posix.isAbsolute(relPath)
    || path.win32.isAbsolute(relPath)
  ) {
    throw invalidParamsError("--engineering-baseline must name a relative JSON path contained in --root", {
      flag: "--engineering-baseline",
      reason: "invalid-engineering-baseline-path",
    });
  }
  try {
    return JSON.parse((await readFileContained(root, relPath)).toString("utf8"));
  } catch {
    throw invalidParamsError("--engineering-baseline must name valid JSON contained in --root", {
      flag: "--engineering-baseline",
      reason: "invalid-engineering-baseline-json",
    });
  }
}

async function runCapabilityList(options) {
  const forbidden = [
    "projectId",
    "projectName",
    "profileId",
    "licensingProfile",
    "licensingVariant",
    "profilesRoot",
    "noGitSpawn",
    "engineeringBaselinePath",
    "compareSkeleton",
  ];
  if (forbidden.some((key) => options[key] !== undefined)) {
    throw invalidParamsError("adopt-plan capability query cannot use repository planning options", { reason: "invalid-option-combination" });
  }
  let mode;
  if (options.capability !== undefined) mode = "exact-capability";
  else if (options.all === true) mode = options.uses !== undefined ? "project-assessment" : "coverage";
  else mode = "incremental-query";
  const limit = options.limit === undefined ? undefined : Number(options.limit);
  const output = await buildCapabilityAssessment({
    mode,
    scope: options.scope,
    locale: options.locale,
    all: options.all,
    root: options.root ?? ".",
    usesPath: options.uses,
    filter: options.filter,
    capability: options.capability,
    limit,
  });
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  return KIT_EXIT_CODES.ok;
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

async function runEntriesSubAction(rest) {
  const specName = "check entries";
  try {
    const options = parseOptions(rest, { command: specName, flags: COMMAND_SPECS[specName].flags });
    if (options.help) {
      process.stdout.write(`${commandHelp("check")}\n`);
      return KIT_EXIT_CODES.ok;
    }
    const { status, output } = await checkEntriesAction({ root: options.root });
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    if (status === "ok") return KIT_EXIT_CODES.ok;
    if (status === "findings") return KIT_EXIT_CODES.findings;
    return KIT_EXIT_CODES.rejected;
  } catch (error) {
    printError(error);
    return KIT_EXIT_CODES.rejected;
  }
}

async function runRelockSubAction(rest) {
  const specName = "check relock";
  try {
    const options = parseOptions(rest, { command: specName, flags: COMMAND_SPECS[specName].flags });
    if (options.help) {
      process.stdout.write(`${commandHelp("check")}\n`);
      return KIT_EXIT_CODES.ok;
    }
    // --files is one comma-separated relative-path list; absent means the
    // auto-discovery mode of the closed-world stage (mirrors runRelock).
    const files =
      options.files === undefined
        ? null
        : options.files
            .split(",")
            .map((rel) => rel.trim())
            .filter((rel) => rel.length > 0);
    const { status, output } = await relockAction({ root: options.root, files });
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    // Relock has no findings state: it either commits the whole transaction
    // or throws (exit 2). Any status other than "ok" is a mechanism error.
    return status === "ok" ? KIT_EXIT_CODES.ok : KIT_EXIT_CODES.rejected;
  } catch (error) {
    printError(error);
    return KIT_EXIT_CODES.rejected;
  }
}

async function runQualificationSubAction(rest) {
  const specName = "check qualification";
  try {
    const options = parseOptions(rest, {
      command: specName,
      flags: COMMAND_SPECS[specName].flags,
      rejectDuplicates: true,
    });
    if (options.help) {
      process.stdout.write(`${commandHelp("check")}\n`);
      return KIT_EXIT_CODES.ok;
    }
    const result = await runQualification({
      root: options.root,
      capability: options.capability,
      requestPath: options.requestPath,
      bindingsPath: options.bindingsPath,
      native: options.native === true,
    });
    const notice = result[QUALIFICATION_NOTICE];
    if (notice) {
      process.stderr.write(`[qualification] 保留私有资格现场：${notice.parentRoot}（证据根：${notice.privateEvidenceRoot}）。请在人工检查后删除该临时目录。\n`);
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return KIT_EXIT_CODES.ok;
  } catch (error) {
    const notice = error?.[QUALIFICATION_NOTICE];
    if (notice) {
      const evidence = notice.privateEvidenceRoot ? `（证据根：${notice.privateEvidenceRoot}）` : "";
      process.stderr.write(`[qualification] 保留私有资格现场：${notice.parentRoot}${evidence}。请在人工检查后删除该临时目录。\n`);
    }
    printError(error);
    return KIT_EXIT_CODES.rejected;
  }
}

export async function cliMain(argv) {
  if (argv.length === 0) {
    process.stdout.write(HELP_TEXT);
    return KIT_EXIT_CODES.ok;
  }
  if (argv[0] === "--help" || argv[0] === "-h") {
    try {
      const options = parseOptions(argv, { command: "global", flags: {}, rejectDuplicates: true });
      if (options.help && Object.keys(options).length === 1) {
        process.stdout.write(HELP_TEXT);
        return KIT_EXIT_CODES.ok;
      }
      throw invalidParamsError("global help must be the only option", { reason: "invalid-option-combination" });
    } catch (error) {
      printError(error);
      return KIT_EXIT_CODES.rejected;
    }
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
  // Positional entry-contract sub-action (SG-34): `check entries` runs the
  // shared entry contract gate (SFA-ENTRY-003/004/005/007 + SFA-CONTEXT-001/002).
  // It hangs under the existing check command; no fifth command is created.
  if (command === "check" && argv[1] === "entries") {
    return runEntriesSubAction(argv.slice(2));
  }
  // Positional controlled-relock sub-action (SG-36): `check relock` runs the
  // fail-closed registration + lock-recompute transaction. It hangs under the
  // existing check command, parallel to `check entries`; no fifth command.
  if (command === "check" && argv[1] === "relock") {
    return runRelockSubAction(argv.slice(2));
  }
  if (command === "check" && argv[1] === "qualification") {
    return runQualificationSubAction(argv.slice(2));
  }
  if (command === "scaffold" && argv[1] === "host-build") {
    return runHostSubAction(command, "host-build", argv.slice(2));
  }
  if (command === "adopt-plan" && ["host-describe", "host-probe", "host-plan", "host-apply"].includes(argv[1])) {
    return runHostSubAction(command, argv[1], argv.slice(2));
  }

  try {
    const listCapabilitiesRequested = command === "adopt-plan" && argv.slice(1).includes("--list-capabilities");
    const engineeringBaselineRequested = command === "adopt-plan"
      && argv.slice(1).some((arg) => arg === "--engineering-baseline" || arg === "--compare-skeleton");
    const options = parseOptions(argv.slice(1), {
      command,
      flags: COMMAND_SPECS[command].flags,
      rejectDuplicates: listCapabilitiesRequested || engineeringBaselineRequested || COMMAND_SPECS[command].rejectDuplicates === true,
    });
    if (options.help) {
      process.stdout.write(`${commandHelp(command)}\n`);
      return KIT_EXIT_CODES.ok;
    }
    if (command === "adopt-plan" && options.listCapabilities === true) {
      return await runCapabilityList(options);
    }
    if (command === "adopt-plan" && argv.slice(1).some((arg) => ["--all", "--scope", "--locale", "--uses", "--filter", "--capability", "--limit"].includes(arg))) {
      throw invalidParamsError("capability query options require --list-capabilities", { reason: "invalid-option-combination" });
    }
    const hasEngineeringBaseline = options.engineeringBaselinePath !== undefined;
    const compareSkeleton = options.compareSkeleton === true;
    if (command === "adopt-plan" && hasEngineeringBaseline !== compareSkeleton) {
      throw invalidParamsError("--engineering-baseline and --compare-skeleton must be provided together", {
        reason: "invalid-option-combination",
      });
    }
    const engineeringBaseline = command === "adopt-plan" && hasEngineeringBaseline
      ? await readEngineeringBaselineJson(options.root ?? ".", options.engineeringBaselinePath)
      : undefined;
    const { exitCode, output } = await runCommand(command, {
      root: options.root ?? ".",
      projectId: options.projectId,
      projectName: options.projectName,
      profileId: options.profileId,
      licensingProfile: options.licensingProfile,
      licensingVariant: options.licensingVariant,
      profilesRoot: options.profilesRoot ?? bundledProfilesRoot(),
      capabilities: options.capabilities,
      manifest: options.manifest,
      only: options.only,
      allowGitSpawn: !options.noGitSpawn,
      engineeringBaseline,
      compareSkeleton: compareSkeleton ? true : undefined,
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
    process.exitCode = code;
  });
}
