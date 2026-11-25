// @feature FND-FR-005
// @feature FND-FR-037
// @decision FND-ADR-038
// @design FND-DES-047
import { lstat, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  CONTRACTS_VERSION,
  findSchemaByObject,
  validateDocument,
} from "skill-family-contracts";
import {
  classifyPathInput,
  digestBytes,
  publishFileOrReplace,
  resolveContained,
  writeFileAtomic,
} from "skill-family-harness-node";
import { planAdoption } from "./adopt-plan.mjs";
import { prepareOptionalProjectManifestLock } from "./capability-cli.mjs";
import { invalidParamsError, KIT_ERROR_KINDS, kitError } from "./errors.mjs";
import { bundledProfilesRoot } from "./licensing.mjs";
import { MIGRATION_MANIFEST_PATH } from "./migration.mjs";
import { KIT_TOOL_NAME, KIT_VERSION, MANAGED_LOCK_PATH, PROJECT_MANIFEST_PATH } from "./skeleton.mjs";
import { listTargetEntries, normalizeRelPath, resolveTargetRoot } from "./workspace.mjs";

/** 非空存量仓库无损引导接入报告的文档类型标识。 */
export const ADOPT_APPLY_REPORT_KIND = "skill-family.adopt-apply-report";

/** 存量接入按需补齐的标准目录骨架（已有目录保留，已有同名文件跳过且绝不覆盖）。 */
export const STANDARD_ADOPT_DIRECTORIES = Object.freeze([
  "skills",
  "docs",
  "scripts",
  "test",
]);

const CAPABILITY_ID_RE = /^foundation\.[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/u;
const PROJECT_MANIFEST_SCHEMA_ID = "https://contracts.skill-family.example/v1/project-manifest.json";

function normalizeCapabilities(capabilities = []) {
  if (capabilities === undefined || capabilities === null) return [];
  if (!Array.isArray(capabilities)) {
    throw invalidParamsError("capabilities 必须是稳定能力 ID 数组");
  }
  const unique = new Set();
  for (const raw of capabilities) {
    if (typeof raw !== "string" || !CAPABILITY_ID_RE.test(raw.trim())) {
      throw invalidParamsError(
        `能力 ID "${String(raw)}" 格式不合法；必须匹配 foundation.<layer>.<name> 规范标识`,
        { capability: raw },
      );
    }
    unique.add(raw.trim());
  }
  return [...unique].sort();
}

async function inspectEntryKind(rootAbs, relPath) {
  const check = classifyPathInput(relPath);
  if (!check.ok) {
    throw kitError(KIT_ERROR_KINDS.ADOPT_APPLY_REFUSED, `非法目标相对路径：${relPath}`, { path: relPath });
  }
  const absPath = path.join(rootAbs, relPath);
  try {
    const st = await lstat(absPath);
    if (st.isSymbolicLink()) return "symlink";
    if (st.isDirectory()) return "directory";
    if (st.isFile()) return "file";
    return "special";
  } catch (cause) {
    if (cause && cause.code === "ENOENT") return "missing";
    throw cause;
  }
}

function buildManifestDocument({ projectId, projectName, profileId, adoptedCapabilities, existingManifest, repoTier }) {
  const mergedCaps = adoptedCapabilities.length > 0
    ? [...new Set([...(existingManifest?.adoptedCapabilities ?? []), ...adoptedCapabilities])].sort()
    : existingManifest?.adoptedCapabilities;
  const resolvedRepoTier = repoTier ?? existingManifest?.repoTier;
  const doc = {
    schemaVersion: 1,
    kind: "skill-family.project-manifest",
    project: {
      id: existingManifest?.project?.id ?? projectId,
      name: existingManifest?.project?.name ?? projectName,
      description: existingManifest?.project?.description ?? `技能族项目 ${projectName}。`,
    },
    contracts: {
      version: CONTRACTS_VERSION,
      profile: existingManifest?.contracts?.profile ?? profileId,
    },
    managedFiles: existingManifest?.managedFiles ?? [PROJECT_MANIFEST_PATH],
    ...(existingManifest?.internalDependencies ? { internalDependencies: existingManifest.internalDependencies } : {}),
    ...(Array.isArray(mergedCaps) && mergedCaps.length > 0 ? { adoptedCapabilities: mergedCaps } : {}),
    ...(existingManifest?.engineering ? { engineering: existingManifest.engineering } : {}),
    ...(resolvedRepoTier !== undefined ? { repoTier: resolvedRepoTier } : {}),
    ...(existingManifest?.updatedAt ? { updatedAt: existingManifest.updatedAt } : {}),
  };
  const reg = findSchemaByObject("project-manifest");
  const validation = validateDocument(doc, {
    schemaId: reg?.$id ?? PROJECT_MANIFEST_SCHEMA_ID,
    dialect: "2020-12",
    policy: "strict",
  });
  if (!validation.valid) {
    throw kitError(
      KIT_ERROR_KINDS.INVALID_MANIFEST,
      `生成的 ${PROJECT_MANIFEST_PATH} 未通过契约校验：${validation.errors?.[0]?.message ?? "结构不合法"}`,
      { path: PROJECT_MANIFEST_PATH, errors: validation.errors },
    );
  }
  return doc;
}

/**
 * 复用 adopt-plan 探测结果，在不覆盖、不删除任何已有业务文件的前提下，
 * 为存量目录创建缺失的 skill-family.project-manifest.json 与标准目录骨架。
 */
export async function applyAdoption({
  root,
  projectId,
  projectName,
  profileId,
  licensingProfile,
  licensingVariant,
  profilesRoot,
  capabilities = [],
  repoTier,
  allowGitSpawn = true,
  dryRun = false,
  updateManifest = false,
} = {}) {
  const rootAbs = await resolveTargetRoot(root ?? ".");
  const normalizedCaps = normalizeCapabilities(capabilities);

  // 1. 先检查 skill-family.project-manifest.json 冲突边界，任何拒绝均零写入。
  const manifestKind = await inspectEntryKind(rootAbs, PROJECT_MANIFEST_PATH);
  let existingManifest = null;
  let previousManifestBytes = null;
  if (manifestKind === "symlink" || manifestKind === "directory" || manifestKind === "special") {
    throw kitError(
      KIT_ERROR_KINDS.ADOPT_APPLY_REFUSED,
      `路径 ${PROJECT_MANIFEST_PATH} 被非普通文件（${manifestKind}）占用，拒绝通过链接或目录写入。`,
      { path: PROJECT_MANIFEST_PATH, entryKind: manifestKind },
    );
  }
  if (manifestKind === "file") {
    if (updateManifest !== true) {
      throw kitError(
        KIT_ERROR_KINDS.ADOPT_APPLY_REFUSED,
        `检测到 ${PROJECT_MANIFEST_PATH} 已存在；默认拒绝覆盖既有项目清单。如需显式更新清单，请传入 --update-manifest（所有已有业务文件仍将完整保留）。`,
        { path: PROJECT_MANIFEST_PATH, reason: "manifest-already-exists" },
      );
    }
    const manifestAbs = await resolveContained(rootAbs, PROJECT_MANIFEST_PATH);
    previousManifestBytes = await readFile(manifestAbs);
    try {
      existingManifest = JSON.parse(previousManifestBytes.toString("utf8"));
    } catch {
      throw kitError(
        KIT_ERROR_KINDS.CONTRACT_PARSE_FAILED,
        `现有 ${PROJECT_MANIFEST_PATH} 不是合法 JSON，请先人工修复后再更新。`,
        { path: PROJECT_MANIFEST_PATH },
      );
    }
  }

  // 2. 复用只读 planAdoption 获取完整存量探测与冲突分析事实。
  const plan = await planAdoption({
    root: rootAbs,
    projectId,
    projectName,
    profileId,
    licensingProfile,
    licensingVariant,
    profilesRoot: profilesRoot ?? bundledProfilesRoot(),
    allowGitSpawn,
  });

  const entries = await listTargetEntries(rootAbs);
  const preservedSet = new Set();
  for (const entry of entries) {
    if (entry.kind === "file" || entry.kind === "symlink" || entry.kind === "special") {
      if (entry.path === PROJECT_MANIFEST_PATH && updateManifest === true) continue;
      preservedSet.add(entry.path);
    }
  }
  for (const conflict of plan.conflicts) {
    preservedSet.add(normalizeRelPath(conflict.path));
  }

  const skippedDirectoryConflicts = [];
  const directoriesToCreate = [];
  for (const dirRel of STANDARD_ADOPT_DIRECTORIES) {
    const kind = await inspectEntryKind(rootAbs, dirRel);
    if (kind === "missing") {
      directoriesToCreate.push(dirRel);
    } else if (kind !== "directory") {
      preservedSet.add(dirRel);
      skippedDirectoryConflicts.push({ path: dirRel, existingKind: kind });
    }
  }

  const manifestDoc = buildManifestDocument({
    projectId: plan.project.projectId,
    projectName: plan.project.projectName,
    profileId: plan.project.profileId,
    adoptedCapabilities: normalizedCaps,
    existingManifest,
    repoTier,
  });
  const manifestContent = `${JSON.stringify(manifestDoc, null, 2)}\n`;
  const manifestBytes = Buffer.from(manifestContent, "utf8");
  const manifestSha256 = digestBytes(manifestBytes);

  let plannedLock = null;
  if (!dryRun && previousManifestBytes !== null && Buffer.compare(previousManifestBytes, manifestBytes) !== 0) {
    plannedLock = await prepareOptionalProjectManifestLock(
      rootAbs,
      previousManifestBytes,
      manifestBytes,
      "更新项目清单",
    );
  }

  const migrationKind = await inspectEntryKind(rootAbs, MIGRATION_MANIFEST_PATH);
  const shouldCreateMigrationManifest = migrationKind === "missing";
  const migrationContent = `${JSON.stringify({
    schemaVersion: 1,
    kind: "skill-family.migration-manifest",
    legacyInfra: [],
    exceptions: [],
  }, null, 2)}\n`;

  const appliedPaths = [];
  for (const dirRel of directoriesToCreate) {
    if (!dryRun) {
      await mkdir(path.join(rootAbs, dirRel), { recursive: true });
    }
    appliedPaths.push(`${dirRel}/`);
  }

  if (!dryRun) {
    await publishFileOrReplace(rootAbs, PROJECT_MANIFEST_PATH, manifestBytes);
    if (plannedLock) {
      await publishFileOrReplace(rootAbs, MANAGED_LOCK_PATH, plannedLock.bytes);
    }
  }
  appliedPaths.push(PROJECT_MANIFEST_PATH);
  if (plannedLock) {
    appliedPaths.push(MANAGED_LOCK_PATH);
  }

  if (shouldCreateMigrationManifest) {
    if (!dryRun) {
      await writeFileAtomic(rootAbs, MIGRATION_MANIFEST_PATH, migrationContent);
    }
    appliedPaths.push(MIGRATION_MANIFEST_PATH);
  }

  const preservedPaths = [...preservedSet].sort();
  const nextSteps = [
    `运行 skill-family-kit check prereqs --root ${root ?? "."} 核验本地 Node.js 运行环境`,
    `运行 skill-family-kit check capability list --root ${root ?? "."} 查看已采用的 Foundation 能力（如需增删请用 adopt-plan capability add/remove）`,
    `运行 skill-family-kit adopt-plan --root ${root ?? "."} 查看完整骨架差异与迁移退出状态`,
  ];

  return {
    schemaVersion: 1,
    kind: ADOPT_APPLY_REPORT_KIND,
    ok: true,
    dryRun: Boolean(dryRun),
    generatedBy: { tool: KIT_TOOL_NAME, version: KIT_VERSION },
    project: {
      id: manifestDoc.project.id,
      name: manifestDoc.project.name,
      profile: manifestDoc.contracts.profile,
      contractsVersion: manifestDoc.contracts.version,
    },
    manifest: {
      path: PROJECT_MANIFEST_PATH,
      action: manifestKind === "file" ? "updated" : "created",
      sha256: manifestSha256,
    },
    appliedPaths,
    preservedPaths,
    skippedDirectoryConflicts,
    planSummary: {
      entryCount: plan.target.entryCount,
      plannedSkeletonCount: plan.writeSet.length,
      conflictCount: plan.conflicts.length,
      riskCount: plan.risks.length,
      gitRepository: plan.git.repository,
    },
    nextSteps,
    policy: `无损引导式接入：仅创建缺失的 ${PROJECT_MANIFEST_PATH}、迁移清单与标准目录骨架，绝不覆盖或删除任何已有业务文件。`,
  };
}

/** 将 adopt-apply 结果渲染为面向人类阅读的中文文本说明。 */
export function formatAdoptApplyReport(report) {
  const modeLabel = report.dryRun ? "预演模式（--dry-run，零磁盘写入）" : "实际写入模式（已有业务文件零覆盖）";
  const lines = [
    `# 存量仓库无损引导接入报告（${report.project.id}）`,
    `- 执行模式：${modeLabel}`,
    `- 项目清单：${report.manifest.path}（${report.manifest.action === "updated" ? "显式更新" : "新建"}，SHA-256: ${report.manifest.sha256.slice(0, 12)}…）`,
    `- 新增或更新路径（${report.appliedPaths.length} 项）：${report.appliedPaths.length > 0 ? report.appliedPaths.join("、") : "无"}`,
    `- 完整保留的既有路径（${report.preservedPaths.length} 项）：${report.preservedPaths.length > 0 ? report.preservedPaths.join("、") : "无"}`,
    "",
    "## 下一步校验指引",
    ...report.nextSteps.map((step, index) => `${index + 1}. ${step}`),
    "",
  ];
  return lines.join("\n");
}
