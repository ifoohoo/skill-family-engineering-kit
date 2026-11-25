// @feature FND-FR-037
// @decision FND-ADR-038
// @design FND-DES-047
import { spawnSync } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { compareExactSemver, parseExactSemver } from "skill-family-contracts";
import { digestBytes, resolveContained } from "skill-family-harness-node";
import { invalidParamsError, KIT_ERROR_KINDS, kitError } from "./errors.mjs";
import {
  collectTargetPackageFiles,
  inferTargetRepoTier,
  isLocalOverrideSpec,
  readActiveLocalOverrides,
} from "./internal-dependencies.mjs";
import { KIT_TOOL_NAME, KIT_VERSION, PROJECT_MANIFEST_PATH } from "./skeleton.mjs";
import { KIT_NODE_ENGINE_RANGE } from "./version.mjs";
import { resolveTargetRoot } from "./workspace.mjs";

/** 运行期前置环境体检与会话内旧指令残留检测报告的文档类型标识。 */
export const PREREQS_CHECK_REPORT_KIND = "skill-family.prereqs-check-report";

/** US-058 会话内技能指令过期的固定中文提示。 */
export const STALE_SKILL_INSTRUCTION_MESSAGE =
  "磁盘技能指令已更新，建议开启新会话或重新加载技能后再继续执行";

/** 业务仓开工体检参考的默认底座基线版本（不阻断执行）。 */
export const DEFAULT_BASELINE_VERSIONS = Object.freeze({
  "skill-family-contracts": KIT_VERSION,
  "skill-family-harness-node": KIT_VERSION,
  "skill-family-engineering-kit": KIT_VERSION,
  "artifact-graph": "1.2.0",
  "agent-method-registry": "0.3.0",
});

const DEPENDENCY_SECTIONS = Object.freeze([
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
]);

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/iu;

function normalizeNodeVersion(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/^v/iu, "").split("-")[0];
  return parseExactSemver(trimmed)?.raw ?? null;
}

function evaluateSingleComparator(actual, token) {
  const expr = token.trim();
  if (expr === "" || expr === "*") return true;

  const wildcardMatch = /^v?(\d+)(?:\.(?:x|\*|(\d+)(?:\.(?:x|\*))?))?$/iu.exec(expr);
  if (wildcardMatch) {
    const parsedActual = parseExactSemver(actual);
    if (!parsedActual) return false;
    if (parsedActual.major !== Number(wildcardMatch[1])) return false;
    if (wildcardMatch[2] !== undefined && parsedActual.minor !== Number(wildcardMatch[2])) {
      return false;
    }
    return true;
  }

  if (expr.startsWith("^")) {
    const base = parseExactSemver(expr.slice(1).replace(/^v/iu, ""));
    if (!base) return null;
    if (compareExactSemver(actual, base.raw) < 0) return false;
    const parsedActual = parseExactSemver(actual);
    if (base.major > 0) return parsedActual.major === base.major;
    if (base.minor > 0) return parsedActual.major === 0 && parsedActual.minor === base.minor;
    return parsedActual.raw === base.raw;
  }

  if (expr.startsWith("~")) {
    const base = parseExactSemver(expr.slice(1).replace(/^v/iu, ""));
    if (!base) return null;
    if (compareExactSemver(actual, base.raw) < 0) return false;
    const parsedActual = parseExactSemver(actual);
    return parsedActual.major === base.major && parsedActual.minor === base.minor;
  }

  const opMatch = /^(>=|<=|>|<|=)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/u.exec(expr);
  if (!opMatch) return null;
  const op = opMatch[1] ?? "=";
  const major = Number(opMatch[2]);
  const minor = opMatch[3] !== undefined ? Number(opMatch[3]) : 0;
  const patch = opMatch[4] !== undefined ? Number(opMatch[4]) : 0;
  const target = `${major}.${minor}.${patch}`;
  const cmp = compareExactSemver(actual, target);
  if (op === ">=") return cmp >= 0;
  if (op === "<=") return cmp <= 0;
  if (op === ">") return cmp > 0;
  if (op === "<") return cmp < 0;
  if (opMatch[3] === undefined) return parseExactSemver(actual).major === major;
  if (opMatch[4] === undefined) {
    const parsedActual = parseExactSemver(actual);
    return parsedActual.major === major && parsedActual.minor === minor;
  }
  return cmp === 0;
}

/**
 * 零外部依赖判定 Node.js 版本是否满足 package.json 的 engines.node 范围表达式。
 */
export function satisfiesNodeEngineRange(versionInput, rangeExpr) {
  const actual = normalizeNodeVersion(versionInput);
  if (!actual || typeof rangeExpr !== "string" || rangeExpr.trim().length === 0) {
    return false;
  }
  const branches = rangeExpr.split("||").map((part) => part.trim()).filter(Boolean);
  if (branches.length === 0) return false;

  for (const branch of branches) {
    const normalizedBranch = branch.replace(/([><=~^])\s+(\d)/gu, "$1$2");
    const tokens = normalizedBranch.split(/\s+/u).filter(Boolean);
    let branchOk = true;
    for (const token of tokens) {
      const outcome = evaluateSingleComparator(actual, token);
      if (outcome !== true) {
        branchOk = false;
        break;
      }
    }
    if (branchOk) return true;
  }
  return false;
}

function defaultPythonProbe() {
  const res = spawnSync("python3", ["--version"], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (res.error || res.status !== 0) {
    return { available: false, version: null };
  }
  const combined = `${res.stdout ?? ""}\n${res.stderr ?? ""}`.trim();
  const match = /Python\s+(\d+\.\d+(?:\.\d+)?)/iu.exec(combined);
  return {
    available: true,
    version: match ? match[1] : combined.split(/\r?\n/u)[0] || "unknown",
  };
}

async function readTargetManifestIfRegular(rootAbs) {
  try {
    const manifestAbs = await resolveContained(rootAbs, PROJECT_MANIFEST_PATH);
    const st = await lstat(manifestAbs);
    if (!st.isFile() || st.isSymbolicLink()) return null;
    const manifest = JSON.parse(await readFile(manifestAbs, "utf8"));
    return manifest !== null && typeof manifest === "object" && !Array.isArray(manifest) ? manifest : null;
  } catch {
    return null;
  }
}

function normalizeLatestVersions(latestVersions) {
  const merged = { ...DEFAULT_BASELINE_VERSIONS };
  if (latestVersions === undefined || latestVersions === null) return merged;
  const source =
    typeof latestVersions === "object" && !Array.isArray(latestVersions)
      ? (latestVersions.packages && typeof latestVersions.packages === "object" && !Array.isArray(latestVersions.packages)
        ? latestVersions.packages
        : latestVersions)
      : null;
  if (!source) {
    throw invalidParamsError("--latest-versions 必须是包含包名与精确版本号映射的 JSON 对象", {
      flag: "--latest-versions",
    });
  }
  for (const [pkgName, rawVer] of Object.entries(source)) {
    if (typeof rawVer !== "string") {
      throw invalidParamsError(`--latest-versions 中包 "${pkgName}" 的版本号必须是精确 semver 字符串`, {
        flag: "--latest-versions",
        packageName: pkgName,
      });
    }
    const parsed = parseExactSemver(rawVer.trim().replace(/^v/iu, ""));
    if (!parsed) {
      throw invalidParamsError(`--latest-versions 中包 "${pkgName}" 的版本 "${rawVer}" 不是合法的 major.minor.patch`, {
        flag: "--latest-versions",
        packageName: pkgName,
        version: rawVer,
      });
    }
    merged[pkgName] = parsed.raw;
  }
  return merged;
}

function extractDeclaredSemver(rawSpec) {
  if (typeof rawSpec !== "string") return null;
  const trimmed = rawSpec.trim();
  if (
    trimmed.length === 0
    || trimmed.startsWith("workspace:")
    || trimmed.startsWith("file:")
    || trimmed.startsWith("link:")
    || trimmed.startsWith("git+")
    || trimmed.includes("://")
  ) {
    return null;
  }
  const match = /^(?:[~^=])?v?(\d+\.\d+\.\d+)$/u.exec(trimmed);
  if (!match) return null;
  return parseExactSemver(match[1])?.raw ?? null;
}

function collectDependencyAdvisories(packageFiles, repoTier, baselineVersions, activeLocalOverrides = new Set()) {
  if (repoTier === "support" || !Array.isArray(packageFiles) || packageFiles.length === 0) return [];
  const advisories = [];
  for (const pkgFile of packageFiles) {
    const packageJson = pkgFile.pkg;
    if (!packageJson || typeof packageJson !== "object" || Array.isArray(packageJson)) continue;
    for (const section of DEPENDENCY_SECTIONS) {
      const depMap = packageJson[section];
      if (!depMap || typeof depMap !== "object" || Array.isArray(depMap)) continue;
      for (const [pkgName, baselineVer] of Object.entries(baselineVersions)) {
        if (!Object.prototype.hasOwnProperty.call(depMap, pkgName)) continue;
        const rawSpec = depMap[pkgName];
        if (activeLocalOverrides.has(pkgName) || isLocalOverrideSpec(rawSpec)) continue;
        const currentVer = extractDeclaredSemver(rawSpec);
        if (!currentVer) continue;
        if (compareExactSemver(currentVer, baselineVer) < 0) {
          const locationLabel = pkgFile.relPath === "package.json" ? section : `${pkgFile.relPath} ${section}`;
          advisories.push({
            level: "info",
            code: "DEPENDENCY_BASELINE_BEHIND",
            packageName: pkgName,
            manifestFile: pkgFile.relPath,
            section,
            currentVersion: currentVer,
            declaredRange: rawSpec,
            recommendedVersion: baselineVer,
            message: `检测到 ${pkgName} 当前锁定版本为 ${currentVer}（${locationLabel}），低于最新已知基线 ${baselineVer}；建议在本次迭代合适窗口同步升级并核验契约测试（本提示仅作温和提醒，不阻断开工）。`,
          });
        }
      }
    }
  }
  advisories.sort(
    (a, b) =>
      a.packageName.localeCompare(b.packageName)
      || a.manifestFile.localeCompare(b.manifestFile)
      || a.section.localeCompare(b.section),
  );
  return advisories;
}

function normalizeLoadedSha256(raw) {
  if (typeof raw !== "string") return null;
  const cleaned = raw.trim().replace(/^sha256:/iu, "");
  return SHA256_HEX_RE.test(cleaned) ? cleaned.toLowerCase() : null;
}

/**
 * 执行运行期前置环境体检与会话内旧技能指令残留检测（US-058 / US-059）。
 * 安全红线：环境变量仅检查“是否存在且非空”，绝不读取、拼接、回显或记录变量值或长度。
 * 业务仓（repoTier !== "support"）如依赖版本落后于已知基线，仅追加 level="info" 的温和提醒，绝不阻断开工。
 */
export async function checkPrereqs({
  root,
  requirePython = false,
  requireEnv = [],
  skillFile,
  loadedSha256,
  latestVersions,
  nodeVersion = process.versions.node,
  env = process.env,
  pythonProbe = defaultPythonProbe,
} = {}) {
  const hasSkillFile = skillFile !== undefined && skillFile !== null;
  const hasLoadedSha = loadedSha256 !== undefined && loadedSha256 !== null;
  if (hasSkillFile !== hasLoadedSha) {
    throw invalidParamsError(
      "--skill-file 与 --loaded-sha256 必须成对提供，以便比对磁盘最新技能指令与当前会话已加载摘要",
      { reason: "invalid-option-combination" },
    );
  }

  let normalizedLoadedSha = null;
  if (hasLoadedSha) {
    normalizedLoadedSha = normalizeLoadedSha256(loadedSha256);
    if (!normalizedLoadedSha) {
      throw invalidParamsError(
        "--loaded-sha256 必须是 64 位十六进制 SHA-256 摘要",
        { flag: "--loaded-sha256" },
      );
    }
  }

  const envNames = Array.isArray(requireEnv) ? requireEnv : [requireEnv];
  const uniqueEnvNames = [];
  const seenEnv = new Set();
  for (const rawName of envNames) {
    if (rawName === undefined || rawName === null) continue;
    if (typeof rawName !== "string" || !ENV_NAME_RE.test(rawName.trim())) {
      throw invalidParamsError(
        `--require-env 变量名 "${String(rawName)}" 格式不合法；仅支持标准环境变量标识符`,
        { flag: "--require-env" },
      );
    }
    const cleanName = rawName.trim();
    if (!seenEnv.has(cleanName)) {
      seenEnv.add(cleanName);
      uniqueEnvNames.push(cleanName);
    }
  }

  const baselineVersions = normalizeLatestVersions(latestVersions);
  const rootAbs = await resolveTargetRoot(root ?? ".");
  const findings = [];

  // 1. 读取根与子包 package.json、repoTier 与本地联调覆盖，执行 Node.js 版本核验
  const { rootPkg: targetPackageJson, packageFiles: targetPackageFiles } =
    await collectTargetPackageFiles(rootAbs);
  const targetManifest = await readTargetManifestIfRegular(rootAbs);
  const declaredRepoTier = inferTargetRepoTier({
    manifest: targetManifest,
    rootPkg: targetPackageJson,
    dirName: path.basename(rootAbs),
  });
  const activeLocalOverrides = await readActiveLocalOverrides(rootAbs, targetPackageJson);
  const expectedRange =
    typeof targetPackageJson?.engines?.node === "string" && targetPackageJson.engines.node.trim().length > 0
      ? targetPackageJson.engines.node.trim()
      : KIT_NODE_ENGINE_RANGE;
  const engineSource =
    typeof targetPackageJson?.engines?.node === "string" && targetPackageJson.engines.node.trim().length > 0
      ? "package.json"
      : "foundation-default";
  const normalizedNode = normalizeNodeVersion(nodeVersion) ?? String(nodeVersion);
  const nodeOk = satisfiesNodeEngineRange(normalizedNode, expectedRange);
  const nodeMessage = nodeOk
    ? `当前 Node.js 版本 v${normalizedNode} 满足约束 "${expectedRange}"（来源：${engineSource}）。`
    : `当前 Node.js 版本 v${normalizedNode} 不满足项目约束 "${expectedRange}"（来源：${engineSource}）；请切换匹配的 Node.js 运行时并将对应 bin 目录置于 PATH 最前。`;
  if (!nodeOk) {
    findings.push({ category: "node", code: "NODE_VERSION_MISMATCH", message: nodeMessage });
  }

  // 2. Python 3 可选探测
  let pythonResult = {
    required: Boolean(requirePython),
    checked: Boolean(requirePython),
    ok: true,
    executable: "python3",
    version: null,
    message: "未要求检测 python3。",
  };
  if (requirePython) {
    const probed = await pythonProbe();
    const pyOk = Boolean(probed && probed.available);
    const pyMessage = pyOk
      ? `检测到可用 python3 运行时（版本：${probed.version}）。`
      : "未检测到可用的 python3 运行时；请安装 Python 3 并确认 python3 在当前 PATH 中可执行。";
    pythonResult = {
      required: true,
      checked: true,
      ok: pyOk,
      executable: "python3",
      version: probed?.version ?? null,
      message: pyMessage,
    };
    if (!pyOk) {
      findings.push({ category: "python", code: "PYTHON3_UNAVAILABLE", message: pyMessage });
    }
  }

  // 3. 环境变量存在且非空检查（严禁回显或记录任何值信息）
  const envResults = uniqueEnvNames.map((varName) => {
    const hasOwn = env !== null && typeof env === "object" && Object.prototype.hasOwnProperty.call(env, varName);
    const isNonEmpty = hasOwn && typeof env[varName] === "string" && env[varName].length > 0;
    const msg = isNonEmpty
      ? `环境变量 ${varName} 已设置且非空。`
      : `环境变量 ${varName} 未设置或为空；请在当前运行环境中配置后再执行任务。`;
    if (!isNonEmpty) {
      findings.push({ category: "env", code: "REQUIRED_ENV_MISSING_OR_EMPTY", name: varName, message: msg });
    }
    return {
      name: varName,
      present: Boolean(hasOwn && env[varName] !== undefined),
      nonEmpty: Boolean(isNonEmpty),
      ok: Boolean(isNonEmpty),
      message: msg,
    };
  });

  // 4. 会话内旧技能指令残留检测（US-058）
  let skillInstructionResult = null;
  if (hasSkillFile) {
    let relSkillPath = String(skillFile).trim();
    if (path.isAbsolute(relSkillPath)) {
      relSkillPath = path.relative(rootAbs, relSkillPath).split(path.sep).join("/");
    } else {
      relSkillPath = relSkillPath.replaceAll("\\", "/");
    }
    let skillAbs;
    try {
      skillAbs = await resolveContained(rootAbs, relSkillPath);
    } catch {
      throw kitError(
        KIT_ERROR_KINDS.UNAUTHORIZED_PATH,
        `--skill-file 路径 "${String(skillFile)}" 越出目标工作区根目录，拒绝读取。`,
        { path: String(skillFile) },
      );
    }
    let st;
    try {
      st = await lstat(skillAbs);
    } catch {
      st = null;
    }
    if (!st || st.isSymbolicLink() || !st.isFile()) {
      const missingMsg = `未找到或无法按普通文件读取技能指令 "${relSkillPath}"；请核对 --skill-file 路径。`;
      skillInstructionResult = {
        required: true,
        ok: false,
        stale: false,
        path: relSkillPath,
        loadedSha256: normalizedLoadedSha,
        diskSha256: null,
        message: missingMsg,
      };
      findings.push({ category: "skill-instruction", code: "SKILL_FILE_UNREADABLE", path: relSkillPath, message: missingMsg });
    } else {
      const diskSha256 = digestBytes(await readFile(skillAbs));
      const matches = diskSha256 === normalizedLoadedSha;
      const skillMsg = matches
        ? "磁盘技能指令摘要与当前会话启动记录一致。"
        : STALE_SKILL_INSTRUCTION_MESSAGE;
      skillInstructionResult = {
        required: true,
        ok: matches,
        stale: !matches,
        path: relSkillPath,
        loadedSha256: normalizedLoadedSha,
        diskSha256,
        message: skillMsg,
      };
      if (!matches) {
        findings.push({
          category: "skill-instruction",
          code: "STALE_SKILL_INSTRUCTION",
          path: relSkillPath,
          message: STALE_SKILL_INSTRUCTION_MESSAGE,
        });
      }
    }
  }

  const dependencyAdvisories = collectDependencyAdvisories(
    targetPackageFiles,
    declaredRepoTier,
    baselineVersions,
    activeLocalOverrides,
  );

  return {
    schemaVersion: 1,
    kind: PREREQS_CHECK_REPORT_KIND,
    generatedBy: { tool: KIT_TOOL_NAME, version: KIT_VERSION },
    ok: findings.length === 0,
    repoTier: declaredRepoTier,
    checks: {
      node: {
        ok: nodeOk,
        currentVersion: normalizedNode,
        expectedRange,
        source: engineSource,
        message: nodeMessage,
      },
      python: pythonResult,
      env: envResults,
      skillInstruction: skillInstructionResult,
    },
    findings,
    dependencyAdvisories,
  };
}

/** 将 check prereqs 结果渲染为可读中文体检摘要。 */
export function formatPrereqsReport(report) {
  const lines = [
    `# 运行期前置环境体检报告（结论：${report.ok ? "通过" : "未通过"}）`,
    `- Node.js：${report.checks.node.message}`,
  ];
  if (report.checks.python.checked) {
    lines.push(`- Python 3：${report.checks.python.message}`);
  }
  for (const item of report.checks.env) {
    lines.push(`- 环境变量 ${item.name}：${item.message}`);
  }
  if (report.checks.skillInstruction) {
    lines.push(`- 技能指令（${report.checks.skillInstruction.path}）：${report.checks.skillInstruction.message}`);
  }
  for (const advisory of report.dependencyAdvisories ?? []) {
    lines.push(`- [提示/${advisory.level}] ${advisory.message}`);
  }
  return `${lines.join("\n")}\n`;
}
