// @feature FND-FR-037
// @decision FND-ADR-038
// @design FND-DES-047
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { findSchemaByObject, validateDocument } from "skill-family-contracts";
import {
  digestBytes,
  publishFileOrReplace,
  resolveContained,
} from "skill-family-harness-node";
import { loadCapabilityCatalog } from "./capability-assessment.mjs";
import { invalidParamsError, KIT_ERROR_KINDS, kitError } from "./errors.mjs";
import { KIT_TOOL_NAME, KIT_VERSION, MANAGED_LOCK_PATH, PROJECT_MANIFEST_PATH } from "./skeleton.mjs";
import { resolveTargetRoot } from "./workspace.mjs";

/** 按需能力声明与安全解绑清理报告的文档类型标识。 */
export const CAPABILITY_REPORT_KIND = "skill-family.capability-report";

const CAPABILITY_ID_RE = /^foundation\.[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/u;
const PROJECT_MANIFEST_SCHEMA_ID = "https://contracts.skill-family.example/v1/project-manifest.json";
const MANAGED_LOCK_SCHEMA_ID = "https://contracts.skill-family.example/v1/managed-file-lock.json";
const SKIP_SCAN_DIRS = new Set([
  ".git",
  "node_modules",
  ".artifacts",
  ".runs",
  ".evidence",
  ".cache",
  "dist",
  "coverage",
  "lib",
]);
const HOST_PROJECTION_PREFIXES = Object.freeze([
  ".codex/",
  ".claude/",
  ".cursor/",
  ".agents/",
  ".kimi/",
  ".qoder/",
  ".dsh/",
  ".gemini/",
  ".grok/",
  ".codebuddy/",
  ".workbuddy/",
]);
const MAX_SCAN_FILE_BYTES = 2 * 1024 * 1024;

function assertValidCapabilityId(rawId) {
  if (typeof rawId !== "string" || !CAPABILITY_ID_RE.test(rawId.trim())) {
    throw invalidParamsError(
      `请通过 --id 提供合法的稳定能力标识（格式如 foundation.<layer>.<name>，收到 "${String(rawId ?? "")}"）`,
      { capabilityId: rawId },
    );
  }
  return rawId.trim();
}

async function readManifestIfPresent(rootAbs, relPath) {
  let absPath;
  try {
    absPath = await resolveContained(rootAbs, relPath);
    const st = await lstat(absPath);
    if (st.isSymbolicLink() || !st.isFile()) {
      throw kitError(
        KIT_ERROR_KINDS.NOT_A_REGULAR_FILE,
        `项目清单路径 ${relPath} 不是普通文件，拒绝读取或修改。`,
        { path: relPath },
      );
    }
  } catch (cause) {
    if (cause?.code?.startsWith?.("SFC")) throw cause;
    if (cause && cause.code === "ENOENT") return null;
    return null;
  }
  const rawBytes = await readFile(absPath);
  let parsed;
  try {
    parsed = JSON.parse(rawBytes.toString("utf8"));
  } catch {
    throw kitError(
      KIT_ERROR_KINDS.CONTRACT_PARSE_FAILED,
      `${relPath} 不是合法 JSON，请先修复语法错误。`,
      { path: relPath },
    );
  }
  const reg = findSchemaByObject("project-manifest");
  const validated = validateDocument(parsed, {
    schemaId: reg?.$id ?? PROJECT_MANIFEST_SCHEMA_ID,
    dialect: "2020-12",
    policy: "strict",
  });
  if (!validated.valid) {
    throw kitError(
      KIT_ERROR_KINDS.INVALID_MANIFEST,
      `${relPath} 未通过项目清单契约校验：${validated.errors?.[0]?.message ?? "结构不合法"}`,
      { path: relPath, errors: validated.errors },
    );
  }
  return { relPath, manifest: validated.data, rawBytes };
}

async function resolveProjectManifestTargets(rootAbs) {
  const rootManifest = await readManifestIfPresent(rootAbs, PROJECT_MANIFEST_PATH);
  if (!rootManifest) {
    throw kitError(
      KIT_ERROR_KINDS.CONTRACTS_MISSING,
      `未找到 ${PROJECT_MANIFEST_PATH}；请先运行 skill-family-kit adopt-plan apply 或 scaffold 初始化项目清单。`,
      { expectedPaths: [PROJECT_MANIFEST_PATH] },
    );
  }
  return { primary: rootManifest };
}

/** 若存在 skill-family.managed-file-lock.json 且已锁定 project-manifest，在修改前核验防漂移并准备同步锁更新。 */
export async function prepareOptionalProjectManifestLock(
  rootAbs,
  previousManifestBytes,
  nextManifestBytes,
  actionLabel = "修改能力声明",
) {
  let lockAbs;
  let st;
  try {
    lockAbs = await resolveContained(rootAbs, MANAGED_LOCK_PATH);
    st = await lstat(lockAbs);
  } catch (cause) {
    if (cause?.code?.startsWith?.("SFC")) throw cause;
    if (cause?.code === "ENOENT") return null;
    throw kitError(
      KIT_ERROR_KINDS.RELOCK_LOCK_DRIFT,
      `无法读取 ${MANAGED_LOCK_PATH}，拒绝修改受管清单。`,
      { path: MANAGED_LOCK_PATH },
    );
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw kitError(
      KIT_ERROR_KINDS.NOT_A_REGULAR_FILE,
      `${MANAGED_LOCK_PATH} 不是普通文件，拒绝修改受管清单。`,
      { path: MANAGED_LOCK_PATH },
    );
  }
  const lockBytes = await readFile(lockAbs);
  let lockDoc;
  try {
    lockDoc = JSON.parse(lockBytes.toString("utf8"));
  } catch {
    throw kitError(
      KIT_ERROR_KINDS.CONTRACT_PARSE_FAILED,
      `${MANAGED_LOCK_PATH} 不是合法 JSON，拒绝修改受管清单。`,
      { path: MANAGED_LOCK_PATH },
    );
  }
  const validated = validateDocument(lockDoc, {
    schemaId: MANAGED_LOCK_SCHEMA_ID,
    dialect: "2020-12",
    policy: "strict",
  });
  if (!validated.valid) {
    throw kitError(
      KIT_ERROR_KINDS.RELOCK_LOCK_DRIFT,
      `${MANAGED_LOCK_PATH} 未通过托管锁契约校验，拒绝修改受管清单。`,
      { path: MANAGED_LOCK_PATH, errors: validated.errors },
    );
  }
  const entry = lockDoc.entries.find((item) => item.path === PROJECT_MANIFEST_PATH);
  if (!entry) return null;
  const currentHash = digestBytes(previousManifestBytes);
  if (entry.hash.value !== currentHash) {
    throw kitError(
      KIT_ERROR_KINDS.RELOCK_LOCK_DRIFT,
      `${PROJECT_MANIFEST_PATH} 当前内容与 ${MANAGED_LOCK_PATH} 锁定摘要不一致；请先消除受管漂移后再${actionLabel}。`,
      { path: PROJECT_MANIFEST_PATH, expected: entry.hash.value, actual: currentHash },
    );
  }

  const nextDoc = {
    ...lockDoc,
    lockVersion: lockDoc.lockVersion + 1,
    entries: lockDoc.entries.map((item) =>
      item.path === PROJECT_MANIFEST_PATH
        ? {
            ...item,
            hash: { algorithm: "sha256", value: digestBytes(nextManifestBytes) },
            generator: { tool: KIT_TOOL_NAME, version: KIT_VERSION },
          }
        : item,
    ),
  };
  return {
    lockVersion: nextDoc.lockVersion,
    bytes: Buffer.from(`${JSON.stringify(nextDoc, null, 2)}\n`, "utf8"),
  };
}

function classifyReferencePath(relPath) {
  if (
    relPath === "skill-family.projection.json"
    || HOST_PROJECTION_PREFIXES.some((prefix) => relPath.startsWith(prefix))
  ) {
    return "host-projection";
  }
  if (
    relPath === "profile.json"
    || relPath === "skill-family.migration.json"
    || relPath === ".projenrc.js"
    || /\.(?:json|ya?ml|toml)$/iu.test(relPath)
  ) {
    return "config";
  }
  return "source";
}

async function scanResidualCapabilityReferences(rootAbs, capabilityId, excludedRelPaths) {
  const excluded = new Set(excludedRelPaths);
  const residualReferences = [];

  async function walk(dirAbs, relPrefix) {
    let dirents;
    try {
      dirents = await readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const dirent of dirents) {
      const rel = relPrefix === "" ? dirent.name : `${relPrefix}/${dirent.name}`;
      if (dirent.isSymbolicLink()) continue;
      if (dirent.isDirectory()) {
        if (SKIP_SCAN_DIRS.has(dirent.name)) continue;
        await walk(path.join(dirAbs, dirent.name), rel);
        continue;
      }
      if (!dirent.isFile() || excluded.has(rel)) continue;
      const fileAbs = path.join(dirAbs, dirent.name);
      let st;
      try {
        st = await lstat(fileAbs);
      } catch {
        continue;
      }
      if (!st.isFile() || st.size === 0 || st.size > MAX_SCAN_FILE_BYTES) continue;
      let bytes;
      try {
        bytes = await readFile(fileAbs);
      } catch {
        continue;
      }
      if (bytes.includes(0)) continue;
      const text = bytes.toString("utf8");
      if (!text.includes(capabilityId)) continue;

      const category = classifyReferencePath(rel);
      const lines = text.split(/\r?\n/u);
      for (let idx = 0; idx < lines.length; idx += 1) {
        if (lines[idx].includes(capabilityId)) {
          const trimmed = lines[idx].trim();
          residualReferences.push({
            path: rel,
            line: idx + 1,
            category,
            snippet: trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed,
          });
        }
      }
    }
  }

  await walk(rootAbs, "");
  return residualReferences;
}

async function prepareManifestWrite(rootAbs, target, nextCapabilities) {
  const nextManifest = {
    ...target.manifest,
    adoptedCapabilities: nextCapabilities,
  };
  const reg = findSchemaByObject("project-manifest");
  const validated = validateDocument(nextManifest, {
    schemaId: reg?.$id ?? PROJECT_MANIFEST_SCHEMA_ID,
    dialect: "2020-12",
    policy: "strict",
  });
  if (!validated.valid) {
    throw kitError(
      KIT_ERROR_KINDS.INVALID_MANIFEST,
      `更新 ${target.relPath} 的 adoptedCapabilities 后未通过契约校验：${validated.errors?.[0]?.message ?? "结构不合法"}`,
      { path: target.relPath, errors: validated.errors },
    );
  }
  const nextBytes = Buffer.from(`${JSON.stringify(nextManifest, null, 2)}\n`, "utf8");
  if (Buffer.compare(target.rawBytes, nextBytes) === 0) {
    return { target, changed: false, nextBytes, plannedLock: null, sha256: digestBytes(target.rawBytes) };
  }
  const plannedLock = await prepareOptionalProjectManifestLock(
    rootAbs,
    target.rawBytes,
    nextBytes,
    "修改能力声明",
  );
  return { target, changed: true, nextBytes, plannedLock };
}

async function persistManifestTargets(rootAbs, target, nextCapabilities) {
  const plan = await prepareManifestWrite(rootAbs, target, nextCapabilities);
  if (!plan.changed) return false;
  await publishFileOrReplace(rootAbs, plan.target.relPath, plan.nextBytes);
  if (plan.plannedLock) {
    await publishFileOrReplace(rootAbs, MANAGED_LOCK_PATH, plan.plannedLock.bytes);
  }
  return true;
}

/** 列出当前项目声明采用的 Foundation 能力清单及目录元数据。 */
export async function listAdoptedCapabilities({ root } = {}) {
  const rootAbs = await resolveTargetRoot(root ?? ".");
  const { primary } = await resolveProjectManifestTargets(rootAbs);
  const catalog = await loadCapabilityCatalog({ locale: "zh-CN" });
  const catalogById = new Map(catalog.capabilities.map((item) => [item.id, item]));
  const adopted = Array.isArray(primary.manifest.adoptedCapabilities)
    ? [...primary.manifest.adoptedCapabilities]
    : [];

  const details = adopted.map((id) => {
    const entry = catalogById.get(id);
    return {
      id,
      inCatalog: Boolean(entry),
      package: entry?.package ?? null,
      layer: entry?.layer ?? null,
      stability: entry?.stability ?? null,
      intent: entry?.intent ?? null,
    };
  });

  return {
    schemaVersion: 1,
    kind: CAPABILITY_REPORT_KIND,
    action: "list",
    ok: true,
    projectId: primary.manifest.project.id,
    manifestPath: primary.relPath,
    adoptedCapabilities: adopted,
    details,
  };
}

/** 向项目的 adoptedCapabilities 安全登记一项能力声明（自动去重并校验契约）。 */
export async function addAdoptedCapability({ root, id, dryRun = false } = {}) {
  const capabilityId = assertValidCapabilityId(id);
  const rootAbs = await resolveTargetRoot(root ?? ".");
  const { primary } = await resolveProjectManifestTargets(rootAbs);
  const catalog = await loadCapabilityCatalog({ locale: "zh-CN" });
  const catalogEntry = catalog.capabilities.find((item) => item.id === capabilityId) ?? null;

  if (catalogEntry && catalogEntry.stability === "unsupported") {
    throw kitError(
      KIT_ERROR_KINDS.CAPABILITY_MUTATION_REFUSED,
      `能力 "${capabilityId}" 在 Foundation 目录中声明为不支持边界（unsupported），不能添加至 adoptedCapabilities。`,
      { capabilityId, stability: "unsupported" },
    );
  }

  const current = Array.isArray(primary.manifest.adoptedCapabilities)
    ? [...primary.manifest.adoptedCapabilities]
    : [];
  const alreadyPresent = current.includes(capabilityId);
  const nextCapabilities = alreadyPresent
    ? current
    : [...new Set([...current, capabilityId])].sort();

  let changed = !alreadyPresent;
  if (!dryRun && !alreadyPresent) {
    changed = await persistManifestTargets(rootAbs, primary, nextCapabilities);
  }

  return {
    schemaVersion: 1,
    kind: CAPABILITY_REPORT_KIND,
    action: "add",
    ok: true,
    dryRun: Boolean(dryRun),
    changed,
    alreadyPresent,
    capabilityId,
    inCatalog: Boolean(catalogEntry),
    projectId: primary.manifest.project.id,
    manifestPath: primary.relPath,
    adoptedCapabilities: nextCapabilities,
  };
}

/**
 * 从项目的 adoptedCapabilities 安全移除目标能力 ID，并只读扫描项目内是否残留
 * 指向该能力的宿主投影、配置文件或业务源码引用（绝不自动删除用户文件）。
 */
export async function removeAdoptedCapability({ root, id, dryRun = false } = {}) {
  const capabilityId = assertValidCapabilityId(id);
  const rootAbs = await resolveTargetRoot(root ?? ".");
  const { primary } = await resolveProjectManifestTargets(rootAbs);

  const current = Array.isArray(primary.manifest.adoptedCapabilities)
    ? [...primary.manifest.adoptedCapabilities]
    : [];
  const wasPresent = current.includes(capabilityId);
  const nextCapabilities = current.filter((item) => item !== capabilityId);

  let changed = wasPresent;
  if (!dryRun && wasPresent) {
    changed = await persistManifestTargets(rootAbs, primary, nextCapabilities);
  }

  const excludedManifestPaths = [primary.relPath];
  const residualReferences = await scanResidualCapabilityReferences(
    rootAbs,
    capabilityId,
    excludedManifestPaths,
  );
  const cleanupGuidance = residualReferences.length > 0
    ? `已在项目清单中解绑能力 "${capabilityId}"，但只读扫描发现 ${residualReferences.length} 处残留引用（涉及宿主投影、配置或源码）；请按 residualReferences 列表逐项核对并人工清理，工具不会自动删除用户文件。`
    : `能力 "${capabilityId}" 已安全解绑，项目内未发现残留引用。`;

  return {
    schemaVersion: 1,
    kind: CAPABILITY_REPORT_KIND,
    action: "remove",
    ok: true,
    dryRun: Boolean(dryRun),
    changed,
    wasPresent,
    capabilityId,
    projectId: primary.manifest.project.id,
    manifestPath: primary.relPath,
    adoptedCapabilities: nextCapabilities,
    residualReferences,
    cleanupGuidance,
  };
}

/** 将 capability 子命令输出格式化为可读中文报告。 */
export function formatCapabilityReport(report) {
  if (report.action === "list") {
    const lines = [
      `# 已声明采用的 Foundation 能力（${report.projectId}）`,
      `- 清单路径：${report.manifestPath}`,
      `- 能力数量：${report.adoptedCapabilities.length}`,
    ];
    for (const item of report.details) {
      const meta = item.inCatalog ? `${item.package} / ${item.stability} —— ${item.intent}` : "自定义或未编目能力标识";
      lines.push(`  - ${item.id}（${meta}）`);
    }
    return `${lines.join("\n")}\n`;
  }
  if (report.action === "add") {
    const mode = report.dryRun ? "（预演模式，未落盘）" : "";
    const status = report.alreadyPresent ? "此前已声明，保持幂等" : "已登记至 adoptedCapabilities";
    return [
      `# 能力声明更新${mode}`,
      `- 清单路径：${report.manifestPath}`,
      `- 目标能力：${report.capabilityId}（${status}）`,
      `- 当前列表：${report.adoptedCapabilities.join("、") || "空"}`,
      "",
    ].join("\n");
  }
  const mode = report.dryRun ? "（预演模式，未落盘）" : "";
  const lines = [
    `# 能力安全解绑报告${mode}`,
    `- 清单路径：${report.manifestPath}`,
    `- 目标能力：${report.capabilityId}（${report.wasPresent ? "已移除声明" : "原清单未声明"}）`,
    `- 清理提示：${report.cleanupGuidance}`,
  ];
  for (const ref of report.residualReferences) {
    lines.push(`  - [${ref.category}] ${ref.path}:${ref.line} -> ${ref.snippet}`);
  }
  return `${lines.join("\n")}\n`;
}
