// @feature FND-FR-034
// @decision FND-ADR-035
// @design FND-DES-044
import { lstat, readdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import {
  compareExactSemver,
  describeInternalDependencyResolutionReceipt,
  digestDocument,
  parseExactSemver,
  validateDocument,
  validateInternalDependencyMap,
} from "skill-family-contracts";
import { digestBytes, publishFileOrReplace, resolveContained, writeFileAtomic } from "skill-family-harness-node";
import { prepareOptionalProjectManifestLock } from "./capability-cli.mjs";
import { invalidParamsError, KIT_ERROR_KINDS, kitError } from "./errors.mjs";
import { KIT_TOOL_NAME, KIT_VERSION, MANAGED_LOCK_PATH, PROJECT_MANIFEST_PATH } from "./skeleton.mjs";
import { resolveTargetRoot } from "./workspace.mjs";

const PROJECT_MANIFEST_SCHEMA_ID = "https://contracts.skill-family.example/v1/project-manifest.json";
const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** 内部依赖受控抬升报告的文档类型标识。 */
export const INTERNAL_DEPENDENCY_BUMP_REPORT_KIND = "skill-family.internal-dependency-bump-report";

/** 底层支撑仓同迭代版本滞后诊断报告的文档类型标识。 */
export const INTERNAL_DEPENDENCY_SUPPORT_LAG_REPORT_KIND = "skill-family.support-dependency-lag-report";

/** 全生态第 0-3 层发布拓扑顺序报告的文档类型标识。 */
export const INTERNAL_DEPENDENCY_TOPOLOGY_REPORT_KIND = "skill-family.publish-topology-report";

/** 本地工作区联调覆盖状态文件名。 */
export const LOCAL_WORKSPACE_OVERRIDES_PATH = ".skill-family-local-overrides.json";

const BASE_PACKAGE_NAMES = Object.freeze([
  "skill-family-contracts",
  "skill-family-harness-node",
  "skill-family-engineering-kit",
  "artifact-graph",
]);

const WORKSPACE_SCAN_SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".artifacts",
  ".runs",
  ".evidence",
  ".cache",
  "_archives",
  "_worktrees",
  "dist",
  "coverage",
  "planner",
  "backups",
  "runs",
  "incoming",
  "work",
]);

export const CANONICAL_SUPPORT_REPO_IDS = new Set([
  "skill-family-studio",
  "skill-family-studio-workspace",
  "skill-family-doc-render",
  "skill-family-doc-render-workspace",
  "skill-family-test",
  "skill-family-test-workspace",
  "release-skill",
  "release-skill-workspace",
  "agent-method-registry",
  "agent-method-registry-workspace",
  "skill-failure-auditor",
  "skill-failure-auditor-workspace",
  "skill-family-audit",
  "skill-family-audit-workspace",
  "skill-family-hub",
  "skill-family-hub-workspace",
]);

const CANONICAL_TOPOLOGY_REPO_DIRS = new Set([
  "skill-family-foundation-workspace",
  "artifact-graph",
  "release-skill",
  "agent-method-registry",
  "skill-failure-auditor-workspace",
  "skill-family-audit",
  "skill-family-audit-workspace",
  "skill-family-hub-workspace",
  "loop-agent",
  "skill-eval",
  "skill-family-workspace",
]);

const LAYER_DEFINITIONS = Object.freeze([
  Object.freeze({
    layer: 0,
    name: "底座与制品图谱层",
    role: "提供共享契约、受控原语、工程工具与制品图校验工具链。",
    canonicalMembers: [
      "skill-family-contracts",
      "skill-family-harness-node",
      "skill-family-engineering-kit",
      "foundation-adoption-review",
      "artifact-graph",
    ],
  }),
  Object.freeze({
    layer: 1,
    name: "支撑工具与注册表层",
    role: "承接规范审计、发布门禁、方法注册表、制品助手与监控工作台等底层支撑技能族（support）。",
    canonicalMembers: [
      "skill-family-audit",
      "release-skill",
      "agent-method-registry",
      "artifact-chain-assistant",
      "skill-family-studio",
    ],
  }),
  Object.freeze({
    layer: 2,
    name: "通用流程与评测基础设施层",
    role: "提供循环执行、评测基准与通用编排骨架，依赖第 0-1 层发布件。",
    canonicalMembers: [
      "loop-agent",
      "skill-eval",
      "skill-family-workflow",
    ],
  }),
  Object.freeze({
    layer: 3,
    name: "业务领域技能族层",
    role: "面向具体业务场景的领域技能族（business），锁定已发布版本并按需增量跟进。",
    canonicalMembers: [
      "skill-family-workspace",
    ],
  }),
]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeDigest(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") return null;
  const cleaned = raw.startsWith("sha256:") ? raw.slice("sha256:".length) : raw;
  return SHA256_HEX_RE.test(cleaned) ? cleaned : null;
}

async function readTargetProjectManifest(rootAbs) {
  let rawBytes;
  try {
    const manifestAbs = await resolveContained(rootAbs, PROJECT_MANIFEST_PATH);
    const stat = await lstat(manifestAbs);
    if (!stat.isFile()) {
      throw kitError(
        KIT_ERROR_KINDS.NOT_A_REGULAR_FILE,
        `${PROJECT_MANIFEST_PATH} 不是普通文件，无法执行内部依赖操作。`,
        { path: PROJECT_MANIFEST_PATH },
      );
    }
    rawBytes = await readFile(manifestAbs);
  } catch (cause) {
    if (cause?.code?.startsWith?.("SFC")) throw cause;
    throw kitError(
      KIT_ERROR_KINDS.CONTRACTS_MISSING,
      `未找到或无法读取项目清单 ${PROJECT_MANIFEST_PATH}；请先确认目标根目录已完成 Foundation 初始化。`,
      { path: PROJECT_MANIFEST_PATH },
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(rawBytes.toString("utf8"));
  } catch {
    throw kitError(
      KIT_ERROR_KINDS.CONTRACT_PARSE_FAILED,
      `${PROJECT_MANIFEST_PATH} 不是合法 JSON，请先修复清单语法错误。`,
      { path: PROJECT_MANIFEST_PATH },
    );
  }
  const validated = validateDocument(parsed, {
    schemaId: PROJECT_MANIFEST_SCHEMA_ID,
    dialect: "2020-12",
    policy: "strict",
  });
  if (!validated.valid) {
    throw kitError(
      KIT_ERROR_KINDS.INVALID_MANIFEST,
      `${PROJECT_MANIFEST_PATH} 未通过契约校验：${validated.errors?.[0]?.message ?? "结构不合法"}`,
      { path: PROJECT_MANIFEST_PATH, errors: validated.errors },
    );
  }
  return { manifest: validated.data, rawBytes };
}

function normalizeCatalogEntries(catalog) {
  const byPackage = new Map();
  if (catalog === undefined || catalog === null) return byPackage;

  const pushCandidate = (pkgName, item, defaultSource = "catalog") => {
    if (typeof pkgName !== "string" || !PACKAGE_NAME_RE.test(pkgName)) {
      throw invalidParamsError(`候选版本目录包含非法包名 "${String(pkgName)}"`, { packageName: pkgName });
    }
    let version;
    let verified = true;
    let digest = null;
    let source = defaultSource;
    if (typeof item === "string") {
      version = item;
    } else if (isPlainObject(item)) {
      version = item.version;
      if (item.verified === false) verified = false;
      digest = normalizeDigest(item.sha256 ?? item.digest ?? null);
      if (typeof item.source === "string" && item.source.length > 0) source = item.source;
    } else {
      throw invalidParamsError(`包 "${pkgName}" 的候选条目必须是版本字符串或对象`, { packageName: pkgName });
    }
    if (!verified) return;
    const parsed = parseExactSemver(version);
    if (!parsed) {
      throw invalidParamsError(
        `包 "${pkgName}" 的候选版本 "${String(version)}" 不是精确的 major.minor.patch 版本号`,
        { packageName: pkgName, version },
      );
    }
    if (!byPackage.has(pkgName)) byPackage.set(pkgName, new Map());
    byPackage.get(pkgName).set(parsed.raw, {
      version: parsed.raw,
      major: parsed.major,
      digest,
      source,
    });
  };

  if (Array.isArray(catalog)) {
    for (const entry of catalog) {
      if (!isPlainObject(entry)) {
        throw invalidParamsError("数组形态的 catalog 每项必须是对象");
      }
      const pkgName = entry.packageName ?? entry.name;
      pushCandidate(pkgName, entry);
    }
    return byPackage;
  }

  if (!isPlainObject(catalog)) {
    throw invalidParamsError("catalog 必须是对象或数组");
  }
  const mapSource = isPlainObject(catalog.packages) ? catalog.packages : catalog;
  for (const [pkgName, list] of Object.entries(mapSource)) {
    if (!Array.isArray(list)) {
      throw invalidParamsError(`catalog 中包 "${pkgName}" 的候选列表必须是数组`, { packageName: pkgName });
    }
    for (const item of list) pushCandidate(pkgName, item);
  }
  return byPackage;
}

async function probeInstalledCandidate(rootAbs, pkgName) {
  if (!rootAbs) return null;
  try {
    const segments = pkgName.split("/");
    const pkgJsonAbs = path.join(rootAbs, "node_modules", ...segments, "package.json");
    const stat = await lstat(pkgJsonAbs);
    if (!stat.isFile()) return null;
    const bytes = await readFile(pkgJsonAbs);
    const parsed = JSON.parse(bytes.toString("utf8"));
    const semver = parseExactSemver(parsed?.version);
    if (!semver) return null;
    return {
      version: semver.raw,
      major: semver.major,
      digest: digestBytes(bytes),
      source: "installed",
    };
  } catch {
    return null;
  }
}

/**
 * 按“固定主版本（0.x 或 N.x）+ 最低可用版本（>= minVersion）”规则解析项目内部依赖，
 * 在同主版本已验证候选集中自动选择最高兼容版本并生成会话级选版收据。
 */
export async function resolveInternalDependencies({
  root,
  manifest: injectedManifest,
  catalog,
  sessionId,
  resolvedAt,
  receiptOut,
} = {}) {
  let rootAbs = null;
  if (root !== undefined) {
    rootAbs = await resolveTargetRoot(root);
  }
  if (!rootAbs && !injectedManifest) {
    throw invalidParamsError("resolveInternalDependencies 需要提供 root 或 manifest 参数");
  }
  if (receiptOut !== undefined && !rootAbs) {
    throw invalidParamsError("指定 receiptOut 输出路径时必须同时提供 root 目录");
  }

  let manifestDoc;
  if (injectedManifest !== undefined) {
    const validated = validateDocument(injectedManifest, {
      schemaId: PROJECT_MANIFEST_SCHEMA_ID,
      dialect: "2020-12",
      policy: "strict",
    });
    if (!validated.valid) {
      throw kitError(
        KIT_ERROR_KINDS.INVALID_MANIFEST,
        `传入的 manifest 未通过契约校验：${validated.errors?.[0]?.message ?? "结构不合法"}`,
        { errors: validated.errors },
      );
    }
    manifestDoc = validated.data;
  } else {
    manifestDoc = (await readTargetProjectManifest(rootAbs)).manifest;
  }

  const rawDeps = manifestDoc.internalDependencies ?? {};
  const mapValidation = validateInternalDependencyMap(rawDeps);
  if (!mapValidation.valid) {
    throw kitError(
      KIT_ERROR_KINDS.INVALID_MANIFEST,
      `internalDependencies 语义校验未通过：${mapValidation.errors?.[0]?.message ?? "版本范围不合法"}`,
      { errors: mapValidation.errors },
    );
  }

  const catalogByPackage = normalizeCatalogEntries(catalog);
  const normalizedDeps = mapValidation.data;
  const resolutions = [];

  for (const [pkgName, spec] of Object.entries(normalizedDeps)) {
    const candidateMap = new Map(catalogByPackage.get(pkgName) ?? []);
    if (candidateMap.size === 0 && rootAbs) {
      const installed = await probeInstalledCandidate(rootAbs, pkgName);
      if (installed) candidateMap.set(installed.version, installed);
    }

    const sortedCandidates = [...candidateMap.values()].sort((a, b) =>
      compareExactSemver(a.version, b.version),
    );
    const evaluatedVersions = sortedCandidates.map((c) => c.version);
    const eligible = sortedCandidates.filter((candidate) => {
      if (candidate.major !== spec.major) return false;
      if (compareExactSemver(candidate.version, spec.minVersion) < 0) return false;
      if (spec.verifiedCeiling !== null && compareExactSemver(candidate.version, spec.verifiedCeiling) > 0) {
        return false;
      }
      return true;
    });

    if (eligible.length > 0) {
      const winner = eligible[eligible.length - 1];
      const trackLabel = `${spec.major}.x`;
      const ceilingClause = spec.verifiedCeiling !== null ? ` 且 <= ${spec.verifiedCeiling}` : "";
      const reason = spec.mode === "exact"
        ? `精确版本声明命中已验证版本 ${winner.version}。`
        : `在主版本轨道 ${trackLabel} 且 >= ${spec.minVersion}${ceilingClause} 的 ${eligible.length} 个兼容候选中自动命中最高已验证版本 ${winner.version}。`;
      resolutions.push({
        packageName: pkgName,
        mode: spec.mode,
        major: spec.major,
        minVersion: spec.minVersion,
        verifiedCeiling: spec.verifiedCeiling,
        selectedVersion: winner.version,
        selectedDigest: winner.digest,
        selectedSource: winner.source,
        status: "resolved",
        candidatesEvaluated: evaluatedVersions,
        reason,
      });
    } else {
      const trackLabel = `${spec.major}.x`;
      let reason;
      if (evaluatedVersions.length === 0) {
        reason = `未发现包 "${pkgName}" 的任何已验证候选版本；请先安装依赖或通过 --catalog 提供已验证版本目录。`;
      } else {
        const ceilingNote = spec.verifiedCeiling !== null ? `、上限 <= ${spec.verifiedCeiling}` : "";
        reason = `候选版本 [${evaluatedVersions.join(", ")}] 均不满足主版本轨道 ${trackLabel}、最低版本 >= ${spec.minVersion}${ceilingNote}；请发布或安装同主版本的新兼容版本，或核对 minVersion / verifiedCeiling 声明。`;
      }
      resolutions.push({
        packageName: pkgName,
        mode: spec.mode,
        major: spec.major,
        minVersion: spec.minVersion,
        verifiedCeiling: spec.verifiedCeiling,
        selectedVersion: null,
        selectedDigest: null,
        selectedSource: null,
        status: "unresolved",
        candidatesEvaluated: evaluatedVersions,
        reason,
      });
    }
  }

  const receipt = describeInternalDependencyResolutionReceipt({
    projectId: manifestDoc.project.id,
    ...(typeof sessionId === "string" && sessionId.length > 0 ? { sessionId } : {}),
    resolvedAt: resolvedAt ?? new Date().toISOString(),
    manifestDigest: digestDocument(manifestDoc),
    resolutions,
  });

  if (receiptOut !== undefined) {
    if (typeof receiptOut !== "string" || receiptOut.length === 0) {
      throw invalidParamsError("receiptOut 必须是非空的项目相对路径");
    }
    const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    await writeFileAtomic(rootAbs, receiptOut, receiptBytes);
  }

  return receipt;
}

/**
 * 受控抬升项目清单（skill-family.project-manifest.json）中指定内部依赖的最低可用版本（minVersion）。
 * 默认要求在同主版本轨道（0.x 或 N.x）内单调不降抬升；若存在托管锁则在同一封闭事务内同步更新摘要。
 */
export async function bumpInternalDependencyMin(options = {}) {
  const root = options.root;
  const pkgName = options.packageName ?? options.package;
  const targetVer = options.toVersion ?? options.to;
  const clearCeiling = options.clearCeiling === true;
  const allowMajorUpgrade = options.allowMajorUpgrade === true;

  if (!root) {
    throw invalidParamsError("bumpInternalDependencyMin 需要提供 root 目录参数");
  }
  if (typeof pkgName !== "string" || !PACKAGE_NAME_RE.test(pkgName)) {
    throw invalidParamsError(
      `请通过 --package 提供合法的内部依赖包名（收到 "${String(pkgName ?? "")}"）`,
      { packageName: pkgName },
    );
  }
  const parsedTarget = parseExactSemver(targetVer);
  if (!parsedTarget) {
    throw invalidParamsError(
      `请通过 --to 提供精确的 major.minor.patch 目标最低版本（收到 "${String(targetVer ?? "")}"）`,
      { toVersion: targetVer },
    );
  }

  const rootAbs = await resolveTargetRoot(root);
  const { manifest, rawBytes: previousManifestBytes } = await readTargetProjectManifest(rootAbs);
  const currentDeps = isPlainObject(manifest.internalDependencies)
    ? structuredClone(manifest.internalDependencies)
    : {};
  const existingMapCheck = validateInternalDependencyMap(currentDeps);
  if (!existingMapCheck.valid) {
    throw kitError(
      KIT_ERROR_KINDS.INVALID_MANIFEST,
      `现有 internalDependencies 包含非法条目：${existingMapCheck.errors?.[0]?.message ?? "校验失败"}`,
      { errors: existingMapCheck.errors },
    );
  }

  const previousSpec = existingMapCheck.data[pkgName] ?? null;
  if (previousSpec) {
    if (previousSpec.major !== parsedTarget.major && !allowMajorUpgrade) {
      throw kitError(
        KIT_ERROR_KINDS.INTERNAL_DEPENDENCY_BUMP_REFUSED,
        `拒绝跨主版本修改包 "${pkgName}"（当前主版本 ${previousSpec.major}.x，目标 ${parsedTarget.raw}）；如确需跨主版本迁移请显式传入 --allow-major-upgrade。`,
        { packageName: pkgName, currentMajor: previousSpec.major, targetVersion: parsedTarget.raw },
      );
    }
    if (
      previousSpec.major === parsedTarget.major
      && compareExactSemver(parsedTarget.raw, previousSpec.minVersion) < 0
    ) {
      throw kitError(
        KIT_ERROR_KINDS.INTERNAL_DEPENDENCY_BUMP_REFUSED,
        `拒绝回退包 "${pkgName}" 的最低可用版本（当前 minVersion=${previousSpec.minVersion}，目标 ${parsedTarget.raw}）；bump-min 仅允许单调抬升或幂等保持。`,
        { packageName: pkgName, currentMinVersion: previousSpec.minVersion, targetVersion: parsedTarget.raw },
      );
    }
  }

  let nextCeiling = null;
  if (!clearCeiling) {
    if (options.verifiedCeiling !== undefined && options.verifiedCeiling !== null) {
      const parsedCeiling = parseExactSemver(options.verifiedCeiling);
      if (!parsedCeiling || parsedCeiling.major !== parsedTarget.major) {
        throw invalidParamsError(
          `verifiedCeiling "${String(options.verifiedCeiling)}" 必须是与 ${parsedTarget.raw} 同主版本的精确版本号`,
          { verifiedCeiling: options.verifiedCeiling },
        );
      }
      nextCeiling = parsedCeiling.raw;
    } else if (previousSpec && previousSpec.mode === "range" && previousSpec.verifiedCeiling !== null) {
      if (previousSpec.major === parsedTarget.major) {
        nextCeiling = previousSpec.verifiedCeiling;
      }
    }
  }
  if (nextCeiling !== null && compareExactSemver(nextCeiling, parsedTarget.raw) < 0) {
    throw kitError(
      KIT_ERROR_KINDS.INTERNAL_DEPENDENCY_BUMP_REFUSED,
      `目标最低版本 ${parsedTarget.raw} 高于当前已声明的 verifiedCeiling (${nextCeiling})；请同步传入更高的 --verified-ceiling 或使用 --clear-ceiling。`,
      { packageName: pkgName, targetVersion: parsedTarget.raw, verifiedCeiling: nextCeiling },
    );
  }

  const nextRange = {
    major: parsedTarget.major,
    minVersion: parsedTarget.raw,
    ...(nextCeiling !== null ? { verifiedCeiling: nextCeiling } : {}),
  };
  const nextDeps = { ...currentDeps, [pkgName]: nextRange };
  const nextManifest = {
    ...manifest,
    internalDependencies: nextDeps,
  };
  const validatedNext = validateDocument(nextManifest, {
    schemaId: PROJECT_MANIFEST_SCHEMA_ID,
    dialect: "2020-12",
    policy: "strict",
  });
  if (!validatedNext.valid) {
    throw kitError(
      KIT_ERROR_KINDS.INVALID_MANIFEST,
      `更新后的 ${PROJECT_MANIFEST_PATH} 未通过契约校验：${validatedNext.errors?.[0]?.message ?? "校验失败"}`,
      { errors: validatedNext.errors },
    );
  }

  const nextManifestBytes = Buffer.from(`${JSON.stringify(nextManifest, null, 2)}\n`, "utf8");
  const unchanged = Buffer.compare(previousManifestBytes, nextManifestBytes) === 0;

  let lockReceipt = null;
  let manifestReceipt;
  if (unchanged) {
    manifestReceipt = { sha256: digestBytes(previousManifestBytes), bytes: previousManifestBytes.length };
  } else {
    const plannedLock = await prepareOptionalProjectManifestLock(
      rootAbs,
      previousManifestBytes,
      nextManifestBytes,
      "执行 bump-min",
    );
    manifestReceipt = await publishFileOrReplace(rootAbs, PROJECT_MANIFEST_PATH, nextManifestBytes);
    if (plannedLock) {
      const committedLock = await publishFileOrReplace(rootAbs, MANAGED_LOCK_PATH, plannedLock.bytes);
      lockReceipt = {
        path: MANAGED_LOCK_PATH,
        lockVersion: plannedLock.lockVersion,
        sha256: committedLock.sha256,
      };
    }
  }

  return Object.freeze({
    schemaVersion: 1,
    kind: INTERNAL_DEPENDENCY_BUMP_REPORT_KIND,
    ok: true,
    changed: !unchanged,
    projectId: manifest.project.id,
    packageName: pkgName,
    previous: previousSpec,
    updated: Object.freeze({
      mode: "range",
      major: parsedTarget.major,
      minVersion: parsedTarget.raw,
      verifiedCeiling: nextCeiling,
    }),
    manifest: Object.freeze({
      path: PROJECT_MANIFEST_PATH,
      sha256: manifestReceipt.sha256,
    }),
    lock: lockReceipt ? Object.freeze(lockReceipt) : null,
  });
}

async function readJsonFileIfRegular(fileAbs) {
  try {
    const st = await lstat(fileAbs);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    const parsed = JSON.parse(await readFile(fileAbs, "utf8"));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractDeclaredSemverRange(rawSpec) {
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
  return match ? parseExactSemver(match[1])?.raw ?? null : null;
}

export function isLocalOverrideSpec(rawSpec) {
  return typeof rawSpec === "string" && (rawSpec.startsWith("link:") || rawSpec.startsWith("file:"));
}

export function stripWorkspaceSuffix(id) {
  return typeof id === "string" ? id.replace(/-workspace$/u, "") : "";
}

export function inferTargetRepoTier({ manifest, rootPkg, dirName } = {}) {
  if (manifest?.repoTier === "support" || manifest?.repoTier === "business") {
    return manifest.repoTier;
  }
  const candidates = [
    manifest?.project?.id,
    typeof rootPkg?.name === "string" ? rootPkg.name.trim() : null,
    dirName,
  ].filter((val) => typeof val === "string" && val.length > 0);
  for (const candidate of candidates) {
    if (
      CANONICAL_SUPPORT_REPO_IDS.has(candidate)
      || CANONICAL_SUPPORT_REPO_IDS.has(stripWorkspaceSuffix(candidate))
    ) {
      return "support";
    }
  }
  return null;
}

export async function readActiveLocalOverrides(repoDirAbs, rootPkg = undefined) {
  const effectiveRootPkg =
    rootPkg === undefined
      ? await readJsonFileIfRegular(path.join(repoDirAbs, "package.json"))
      : rootPkg;
  const localOverridesFile = await readJsonFileIfRegular(
    path.join(repoDirAbs, LOCAL_WORKSPACE_OVERRIDES_PATH),
  );
  const rootOverrides = isPlainObject(effectiveRootPkg?.pnpm?.overrides)
    ? effectiveRootPkg.pnpm.overrides
    : {};
  const linkedPackages = new Set();
  for (const [pkgName, spec] of Object.entries(rootOverrides)) {
    if (isLocalOverrideSpec(spec)) linkedPackages.add(pkgName);
  }
  if (isPlainObject(localOverridesFile?.overrides)) {
    for (const [pkgName, spec] of Object.entries(localOverridesFile.overrides)) {
      if (isLocalOverrideSpec(spec)) linkedPackages.add(pkgName);
    }
  }
  return linkedPackages;
}

export async function collectTargetPackageFiles(repoDirAbs, rootPkg = undefined) {
  const resolvedRootPkg =
    rootPkg === undefined
      ? await readJsonFileIfRegular(path.join(repoDirAbs, "package.json"))
      : rootPkg;
  const packageFiles = [];
  if (resolvedRootPkg) {
    packageFiles.push({ relPath: "package.json", pkg: resolvedRootPkg, dirAbs: repoDirAbs });
  }
  const packagesDirAbs = path.join(repoDirAbs, "packages");
  let subEntries = [];
  try {
    const subSt = await lstat(packagesDirAbs);
    if (!subSt.isSymbolicLink() && subSt.isDirectory()) {
      subEntries = await readdir(packagesDirAbs, { withFileTypes: true });
    }
  } catch {
    subEntries = [];
  }
  subEntries.sort((a, b) => a.name.localeCompare(b.name));
  for (const dirent of subEntries) {
    if (!dirent.isDirectory() || dirent.isSymbolicLink()) continue;
    const subDirAbs = path.join(packagesDirAbs, dirent.name);
    const subPkg = await readJsonFileIfRegular(path.join(subDirAbs, "package.json"));
    if (subPkg && typeof subPkg.name === "string") {
      packageFiles.push({
        relPath: `packages/${dirent.name}/package.json`,
        pkg: subPkg,
        dirAbs: subDirAbs,
      });
    }
  }
  return { rootPkg: resolvedRootPkg, packageFiles };
}

function toPosixRelative(fromDirAbs, toDirAbs) {
  const rel = path.relative(fromDirAbs, toDirAbs).split(path.sep).join("/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

async function discoverWorkspaceContext(sourceRootAbs) {
  const basePackages = new Map();
  const repositories = [];

  async function walk(dirAbs, depth) {
    if (depth > 4) return;
    const manifest = await readJsonFileIfRegular(path.join(dirAbs, PROJECT_MANIFEST_PATH));
    const rootPkg = await readJsonFileIfRegular(path.join(dirAbs, "package.json"));

    if (manifest || (depth > 0 && rootPkg && typeof rootPkg.name === "string")) {
      const repoRel = path.relative(sourceRootAbs, dirAbs).split(path.sep).join("/") || ".";
      const { packageFiles } = await collectTargetPackageFiles(dirAbs, rootPkg);

      for (const item of packageFiles) {
        const pkgName = item.pkg.name;
        const parsedVer = parseExactSemver(item.pkg.version);
        const existingBase = basePackages.get(pkgName);
        if (
          BASE_PACKAGE_NAMES.includes(pkgName)
          && parsedVer
          && (!existingBase || compareExactSemver(parsedVer.raw, existingBase.version) > 0)
        ) {
          basePackages.set(pkgName, {
            packageName: pkgName,
            version: parsedVer.raw,
            packageDirAbs: item.dirAbs,
            packageRelPath: path.relative(sourceRootAbs, item.dirAbs).split(path.sep).join("/"),
          });
        }
      }

      const dirName = path.basename(dirAbs);
      if (manifest) {
        const rawProjectId = manifest?.project?.id ?? dirName;
        const inferredTier = inferTargetRepoTier({ manifest, rootPkg, dirName });
        repositories.push({
          repoDirAbs: dirAbs,
          repoRelPath: repoRel,
          projectId: rawProjectId,
          repoTier: inferredTier,
          manifest,
          rootPkg,
          packageFiles,
        });
        return;
      }

      if (depth > 0 && rootPkg && CANONICAL_TOPOLOGY_REPO_DIRS.has(dirName)) {
        const rawProjectId = (typeof rootPkg.name === "string" && rootPkg.name.trim()) ? rootPkg.name.trim() : dirName;
        const inferredTier = inferTargetRepoTier({ manifest: null, rootPkg, dirName });
        repositories.push({
          repoDirAbs: dirAbs,
          repoRelPath: repoRel,
          projectId: rawProjectId === "artifact-graph-workspace" ? "artifact-graph" : rawProjectId,
          repoTier: inferredTier,
          manifest: null,
          rootPkg,
          packageFiles,
        });
        return;
      }
    }

    let entries;
    try {
      entries = await readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const dirent of entries) {
      if (!dirent.isDirectory() || dirent.isSymbolicLink()) continue;
      if (
        dirent.name.startsWith(".")
        || WORKSPACE_SCAN_SKIP_DIRS.has(dirent.name)
        || /-hotfix-\d+\.\d+\.\d+$/u.test(dirent.name)
      ) {
        continue;
      }
      await walk(path.join(dirAbs, dirent.name), depth + 1);
    }
  }

  await walk(sourceRootAbs, 0);
  repositories.sort((a, b) => a.repoRelPath.localeCompare(b.repoRelPath));
  return { basePackages, repositories };
}

/**
 * 扫描同源工作区中全部底层支撑技能族（repoTier === "support"）仓库：
 * 若锁定的 Foundation 或 artifact-graph 版本落后于本机最新源码基线且未开启本地联调覆盖，
 * 输出 SUPPORT_TIER_VERSION_LAG 诊断项督促同迭代拉齐。
 */
export async function checkSupportWorkspaceDependencies({ workspaceRoot } = {}) {
  if (!workspaceRoot || typeof workspaceRoot !== "string") {
    throw invalidParamsError("checkSupportWorkspaceDependencies 需要提供 --workspace-root 目录参数", {
      flag: "--workspace-root",
    });
  }
  const sourceRootAbs = await resolveTargetRoot(workspaceRoot);
  const { basePackages, repositories } = await discoverWorkspaceContext(sourceRootAbs);

  const supportRepos = repositories.filter((repo) => repo.repoTier === "support");
  const findings = [];
  const checkedRepos = [];

  for (const repo of supportRepos) {
    const linkedPackages = await readActiveLocalOverrides(repo.repoDirAbs, repo.rootPkg);

    const repoLags = [];
    for (const pkgFile of repo.packageFiles) {
      for (const section of ["dependencies", "devDependencies", "peerDependencies"]) {
        const deps = pkgFile.pkg[section];
        if (!isPlainObject(deps)) continue;
        for (const basePkgName of BASE_PACKAGE_NAMES) {
          if (!Object.prototype.hasOwnProperty.call(deps, basePkgName)) continue;
          const baseInfo = basePackages.get(basePkgName);
          if (!baseInfo) continue;

          const rawSpec = deps[basePkgName];
          const hasLocalOverride = linkedPackages.has(basePkgName) || isLocalOverrideSpec(rawSpec);
          const lockedSemver = extractDeclaredSemverRange(rawSpec);
          if (!lockedSemver || hasLocalOverride) continue;

          if (compareExactSemver(lockedSemver, baseInfo.version) < 0) {
            const lag = {
              code: "SUPPORT_TIER_VERSION_LAG",
              projectId: repo.projectId,
              repoPath: repo.repoRelPath,
              manifestFile: pkgFile.relPath,
              section,
              packageName: basePkgName,
              lockedVersion: lockedSemver,
              declaredRange: rawSpec,
              baseSourceVersion: baseInfo.version,
              message: `底层支撑仓 ${repo.projectId}（${pkgFile.relPath} ${section}）锁定 ${basePkgName}@${lockedSemver}，落后于本地底座源码 ${baseInfo.version} 且未启用本地联调覆盖；请同迭代拉齐版本号，或通过 adopt-plan deps --link-workspace 启用联调覆盖。`,
            };
            repoLags.push(lag);
            findings.push(lag);
          }
        }
      }
    }

    checkedRepos.push({
      projectId: repo.projectId,
      repoPath: repo.repoRelPath,
      repoTier: repo.repoTier,
      activeLocalOverrides: [...linkedPackages].sort(),
      lagCount: repoLags.length,
    });
  }

  const baseSummary = {};
  for (const [pkgName, info] of [...basePackages.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    baseSummary[pkgName] = {
      version: info.version,
      packagePath: info.packageRelPath,
    };
  }

  return Object.freeze({
    schemaVersion: 1,
    kind: INTERNAL_DEPENDENCY_SUPPORT_LAG_REPORT_KIND,
    ok: findings.length === 0,
    basePackages: baseSummary,
    supportRepos: checkedRepos,
    findings,
  });
}

/**
 * 输出第 0 层到第 3 层的确定性全生态发版拓扑顺序；若提供 workspaceRoot，同时归类各已发现仓库层级。
 */
export async function describePublishTopology({ workspaceRoot } = {}) {
  let discoveredByLayer = new Map([
    [0, []],
    [1, []],
    [2, []],
    [3, []],
  ]);
  let baseSummary = {};

  if (workspaceRoot !== undefined && workspaceRoot !== null) {
    const sourceRootAbs = await resolveTargetRoot(workspaceRoot);
    const { basePackages, repositories } = await discoverWorkspaceContext(sourceRootAbs);
    for (const [pkgName, info] of [...basePackages.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      baseSummary[pkgName] = { version: info.version, packagePath: info.packageRelPath };
    }
    for (const repo of repositories) {
      const dirName = path.basename(repo.repoDirAbs);
      const candidateIds = new Set(
        [
          repo.projectId,
          stripWorkspaceSuffix(repo.projectId),
          dirName,
          stripWorkspaceSuffix(dirName),
        ].filter(Boolean),
      );
      const matchesLayer = (layerIdx) =>
        LAYER_DEFINITIONS[layerIdx].canonicalMembers.some((member) => candidateIds.has(member));

      let layer = 3;
      if (
        candidateIds.has("skill-family-foundation")
        || repo.repoRelPath.endsWith("skill-family-foundation-workspace")
        || matchesLayer(0)
      ) {
        layer = 0;
      } else if (repo.repoTier === "support" || matchesLayer(1)) {
        layer = 1;
      } else if (matchesLayer(2)) {
        layer = 2;
      }
      discoveredByLayer.get(layer).push({
        projectId: repo.projectId,
        repoPath: repo.repoRelPath,
        repoTier: repo.repoTier,
      });
    }
  }

  const layers = LAYER_DEFINITIONS.map((def) => {
    const repos = discoveredByLayer.get(def.layer) ?? [];
    repos.sort((a, b) => a.projectId.localeCompare(b.projectId));
    return {
      layer: def.layer,
      name: def.name,
      role: def.role,
      canonicalMembers: [...def.canonicalMembers],
      discoveredRepos: repos,
    };
  });

  return Object.freeze({
    schemaVersion: 1,
    kind: INTERNAL_DEPENDENCY_TOPOLOGY_REPORT_KIND,
    ok: true,
    basePackages: baseSummary,
    layers,
  });
}

function collectReferencedBasePackages(rootPkg, packageFiles) {
  const referenced = new Set();
  const candidates = [rootPkg, ...packageFiles.map((item) => item.pkg)].filter(Boolean);
  for (const pkg of candidates) {
    for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const deps = pkg[section];
      if (!isPlainObject(deps)) continue;
      for (const baseName of BASE_PACKAGE_NAMES) {
        if (Object.prototype.hasOwnProperty.call(deps, baseName)) {
          referenced.add(baseName);
        }
      }
    }
  }
  return referenced;
}

/**
 * 为底层支撑仓写入指向同源本地底座源码包目录的 pnpm.overrides 联调覆盖，
 * 并在 .skill-family-local-overrides.json 保留原有语义版本号以供 --unlink-workspace 原样恢复。
 */
export async function linkWorkspaceDependencies({
  root = ".",
  sourceRoot,
  packages,
  dryRun = false,
} = {}) {
  if (!sourceRoot || typeof sourceRoot !== "string") {
    throw invalidParamsError("linkWorkspaceDependencies 需要提供 --link-workspace <sourceRoot> 参数", {
      flag: "--link-workspace",
    });
  }
  const rootAbs = await resolveTargetRoot(root);
  const sourceRootAbs = await resolveTargetRoot(sourceRoot);
  const { basePackages } = await discoverWorkspaceContext(sourceRootAbs);

  const pkgAbs = await resolveContained(rootAbs, "package.json");
  const pkgDoc = await readJsonFileIfRegular(pkgAbs);
  if (!pkgDoc) {
    throw kitError(
      KIT_ERROR_KINDS.CONTRACTS_MISSING,
      "目标根目录缺少合法的 package.json，无法写入本地工作区联调覆盖。",
      { path: "package.json" },
    );
  }

  const localStateAbs = await resolveContained(rootAbs, LOCAL_WORKSPACE_OVERRIDES_PATH);
  const existingState = await readJsonFileIfRegular(localStateAbs);
  const previousOverridesBackup = isPlainObject(existingState?.previousPnpmOverrides)
    ? { ...existingState.previousPnpmOverrides }
    : {};

  // 收集目标工作区子包，以便准确识别所需覆盖的底座包。
  const subPkgFiles = [];
  const packagesDirAbs = path.join(rootAbs, "packages");
  try {
    const subSt = await lstat(packagesDirAbs);
    if (!subSt.isSymbolicLink() && subSt.isDirectory()) {
      const dirents = await readdir(packagesDirAbs, { withFileTypes: true });
      for (const dirent of dirents) {
        if (!dirent.isDirectory() || dirent.isSymbolicLink()) continue;
        const subPkg = await readJsonFileIfRegular(path.join(packagesDirAbs, dirent.name, "package.json"));
        if (subPkg) subPkgFiles.push({ relPath: `packages/${dirent.name}/package.json`, pkg: subPkg });
      }
    }
  } catch {
    // 非 monorepo 单包结构无需扫描 packages/
  }

  const referencedBase = collectReferencedBasePackages(pkgDoc, subPkgFiles);
  const explicitFilter = Array.isArray(packages) && packages.length > 0
    ? new Set(packages)
    : typeof packages === "string" && packages.trim().length > 0
      ? new Set(packages.split(",").map((p) => p.trim()).filter(Boolean))
      : null;

  const targetPackageNames = [];
  for (const [pkgName] of [...basePackages.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (explicitFilter) {
      if (explicitFilter.has(pkgName)) targetPackageNames.push(pkgName);
    } else if (referencedBase.size === 0 || referencedBase.has(pkgName)) {
      targetPackageNames.push(pkgName);
    }
  }
  if (targetPackageNames.length === 0) {
    throw kitError(
      KIT_ERROR_KINDS.INTERNAL_DEPENDENCY_UNRESOLVED,
      "在指定的源码目录中未找到可联调链接的底座包（skill-family-contracts / skill-family-harness-node / skill-family-engineering-kit / artifact-graph）。",
      { sourceRoot: "." },
    );
  }

  const nextPkgDoc = structuredClone(pkgDoc);
  if (!isPlainObject(nextPkgDoc.pnpm)) nextPkgDoc.pnpm = {};
  if (!isPlainObject(nextPkgDoc.pnpm.overrides)) nextPkgDoc.pnpm.overrides = {};

  const linkedOverrides = {};
  for (const pkgName of targetPackageNames) {
    const info = basePackages.get(pkgName);
    const linkSpec = `link:${toPosixRelative(rootAbs, info.packageDirAbs)}`;
    if (!Object.prototype.hasOwnProperty.call(previousOverridesBackup, pkgName)) {
      const prevSpec = nextPkgDoc.pnpm.overrides[pkgName];
      previousOverridesBackup[pkgName] = prevSpec !== undefined && !isLocalOverrideSpec(prevSpec)
        ? prevSpec
        : null;
    }
    nextPkgDoc.pnpm.overrides[pkgName] = linkSpec;
    linkedOverrides[pkgName] = linkSpec;
  }

  const nextStateDoc = {
    schemaVersion: 1,
    kind: "skill-family.local-workspace-overrides",
    overrides: linkedOverrides,
    previousPnpmOverrides: previousOverridesBackup,
  };

  if (!dryRun) {
    await publishFileOrReplace(rootAbs, "package.json", Buffer.from(`${JSON.stringify(nextPkgDoc, null, 2)}\n`, "utf8"));
    await publishFileOrReplace(
      rootAbs,
      LOCAL_WORKSPACE_OVERRIDES_PATH,
      Buffer.from(`${JSON.stringify(nextStateDoc, null, 2)}\n`, "utf8"),
    );
  }

  return Object.freeze({
    schemaVersion: 1,
    kind: "skill-family.local-workspace-link-report",
    action: "link-workspace",
    ok: true,
    dryRun: Boolean(dryRun),
    overrides: linkedOverrides,
    stateFile: LOCAL_WORKSPACE_OVERRIDES_PATH,
    restoredBaselineAvailable: true,
  });
}

/**
 * 清除目标仓中的本地工作区联调覆盖，按 .skill-family-local-overrides.json 恢复原有正式语义版本号。
 */
export async function unlinkWorkspaceDependencies({ root = ".", dryRun = false } = {}) {
  const rootAbs = await resolveTargetRoot(root);
  const pkgAbs = await resolveContained(rootAbs, "package.json");
  const pkgDoc = await readJsonFileIfRegular(pkgAbs);
  if (!pkgDoc) {
    throw kitError(
      KIT_ERROR_KINDS.CONTRACTS_MISSING,
      "目标根目录缺少合法的 package.json，无法恢复联调覆盖。",
      { path: "package.json" },
    );
  }

  const localStateAbs = await resolveContained(rootAbs, LOCAL_WORKSPACE_OVERRIDES_PATH);
  const stateDoc = await readJsonFileIfRegular(localStateAbs);
  const currentOverrides = isPlainObject(pkgDoc?.pnpm?.overrides) ? pkgDoc.pnpm.overrides : {};

  if (!stateDoc && !Object.values(currentOverrides).some((val) => isLocalOverrideSpec(val))) {
    return Object.freeze({
      schemaVersion: 1,
      kind: "skill-family.local-workspace-link-report",
      action: "unlink-workspace",
      ok: true,
      dryRun: Boolean(dryRun),
      changed: false,
      restored: {},
      removed: [],
    });
  }

  const nextPkgDoc = structuredClone(pkgDoc);
  const restored = {};
  const removed = [];
  if (isPlainObject(nextPkgDoc?.pnpm?.overrides)) {
    const backup = isPlainObject(stateDoc?.previousPnpmOverrides) ? stateDoc.previousPnpmOverrides : {};
    const trackedKeys = new Set([
      ...Object.keys(backup),
      ...Object.keys(isPlainObject(stateDoc?.overrides) ? stateDoc.overrides : {}),
      ...Object.entries(nextPkgDoc.pnpm.overrides)
        .filter(([, value]) => isLocalOverrideSpec(value))
        .map(([key]) => key),
    ]);

    for (const pkgName of [...trackedKeys].sort()) {
      if (Object.prototype.hasOwnProperty.call(backup, pkgName)) {
        const prev = backup[pkgName];
        if (prev === null || prev === undefined) {
          delete nextPkgDoc.pnpm.overrides[pkgName];
          removed.push(pkgName);
        } else {
          nextPkgDoc.pnpm.overrides[pkgName] = prev;
          restored[pkgName] = prev;
        }
      } else if (isLocalOverrideSpec(nextPkgDoc.pnpm.overrides[pkgName])) {
        delete nextPkgDoc.pnpm.overrides[pkgName];
        removed.push(pkgName);
      }
    }

    if (Object.keys(nextPkgDoc.pnpm.overrides).length === 0) {
      delete nextPkgDoc.pnpm.overrides;
    }
    if (isPlainObject(nextPkgDoc.pnpm) && Object.keys(nextPkgDoc.pnpm).length === 0) {
      delete nextPkgDoc.pnpm;
    }
  }

  if (!dryRun) {
    await publishFileOrReplace(rootAbs, "package.json", Buffer.from(`${JSON.stringify(nextPkgDoc, null, 2)}\n`, "utf8"));
    if (stateDoc) {
      await unlink(localStateAbs);
    }
  }

  return Object.freeze({
    schemaVersion: 1,
    kind: "skill-family.local-workspace-link-report",
    action: "unlink-workspace",
    ok: true,
    dryRun: Boolean(dryRun),
    changed: true,
    restored,
    removed,
  });
}

/** 将内部依赖解析收据渲染为可读中文摘要。 */
export function formatDepsResolveReport(receipt) {
  const statusLabel = receipt.status === "resolved" ? "全部命中" : "存在未命中依赖";
  const lines = [
    `# 内部依赖版本解析报告（项目：${receipt.projectId}，结论：${statusLabel}）`,
  ];
  if (!Array.isArray(receipt.resolutions) || receipt.resolutions.length === 0) {
    lines.push("- 当前项目未声明 internalDependencies。");
    return `${lines.join("\n")}\n`;
  }
  for (const item of receipt.resolutions) {
    if (item.status === "resolved") {
      lines.push(
        `- [已命中] ${item.packageName} -> ${item.selectedVersion}（来源：${item.selectedSource ?? "unknown"}）：${item.reason}`,
      );
    } else {
      lines.push(`- [未命中] ${item.packageName}：${item.reason}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** 将支撑仓底座依赖滞后检查报告渲染为可读中文摘要。 */
export function formatSupportLagReport(report) {
  const lines = [
    `# 支撑技能族底座依赖体检报告（结论：${report.ok ? "全部对齐" : `发现 ${report.findings.length} 项滞后`}）`,
  ];
  const baseEntries = Object.entries(report.basePackages ?? {});
  if (baseEntries.length > 0) {
    lines.push(
      `- 本地第 0 层底座基线：${baseEntries.map(([name, info]) => `${name}@${info.version}`).join("、")}`,
    );
  }
  if (!Array.isArray(report.supportRepos) || report.supportRepos.length === 0) {
    lines.push("- 未在指定工作区发现支撑层（support）仓库。");
    return `${lines.join("\n")}\n`;
  }
  for (const repo of report.supportRepos) {
    const overrideNote =
      Array.isArray(repo.activeLocalOverrides) && repo.activeLocalOverrides.length > 0
        ? `（已挂载本地联调覆盖：${repo.activeLocalOverrides.join("、")}）`
        : "";
    const statusText = repo.lagCount === 0 ? "已对齐" : `滞后 ${repo.lagCount} 项`;
    lines.push(`- ${repo.projectId}（${repo.repoPath}）：${statusText}${overrideNote}`);
  }
  for (const finding of report.findings ?? []) {
    lines.push(`  - [滞后] ${finding.message}`);
  }
  return `${lines.join("\n")}\n`;
}

/** 将全生态第 0-3 层发版拓扑报告渲染为可读中文摘要。 */
export function formatPublishTopologyReport(topology) {
  const lines = ["# 全生态第 0-3 层发版拓扑报告"];
  const baseEntries = Object.entries(topology.basePackages ?? {});
  if (baseEntries.length > 0) {
    lines.push(
      `- 本地底座源码基线：${baseEntries.map(([name, info]) => `${name}@${info.version}`).join("、")}`,
    );
  }
  for (const layer of topology.layers ?? []) {
    lines.push(`## 第 ${layer.layer} 层：${layer.name}`);
    lines.push(`- 职责定位：${layer.role}`);
    lines.push(`- 规范成员：${(layer.canonicalMembers ?? []).join("、")}`);
    if (Array.isArray(layer.discoveredRepos) && layer.discoveredRepos.length > 0) {
      lines.push(
        `- 已发现仓库：${layer.discoveredRepos.map((r) => `${r.projectId}（${r.repoPath}）`).join("、")}`,
      );
    } else {
      lines.push("- 已发现仓库：未传入 --workspace-root 或当前目录未检出对应仓库");
    }
  }
  return `${lines.join("\n")}\n`;
}
