// @feature FND-FR-035
// @decision FND-ADR-036
// @design FND-DES-045
import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { invalidParamsError, KIT_ERROR_KINDS, kitError } from "./errors.mjs";
import { bundledHostProfilesRoot, describeHost } from "./host-profiles.mjs";

/** 同名技能遮蔽与加载优先级排障报告的文档类型标识。 */
export const SKILL_SHADOWING_REPORT_KIND = "skill-family.skill-shadowing-report";

const ALLOWED_SCOPES = new Set(["project", "plugin", "user", "custom"]);

function sha256Hex(bufferOrString) {
  return createHash("sha256").update(bufferOrString).digest("hex");
}

function toPosixRel(fromRoot, targetPath) {
  return path.relative(fromRoot, targetPath).split(path.sep).join("/");
}

function parseFrontmatterName(markdownText) {
  const normalized = markdownText.replace(/^\uFEFF/u, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(normalized);
  if (!match) return null;
  const lines = match[1].split(/\r?\n/u);
  for (const rawLine of lines) {
    const m = /^name\s*:\s*(.+?)\s*$/u.exec(rawLine);
    if (!m) continue;
    let value = m[1];
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1).trim();
    }
    if (value.length > 0) return value;
  }
  return null;
}

async function computeDirectoryClosureDigest(dirAbs) {
  const records = [];
  async function walk(currentAbs) {
    const entries = await readdir(currentAbs, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const childAbs = path.join(currentAbs, entry.name);
      const st = await lstat(childAbs);
      if (st.isSymbolicLink()) {
        records.push(`symlink:${toPosixRel(dirAbs, childAbs)}`);
      } else if (st.isDirectory()) {
        await walk(childAbs);
      } else if (st.isFile()) {
        const bytes = await readFile(childAbs);
        records.push(`file:${toPosixRel(dirAbs, childAbs)}:${sha256Hex(bytes)}`);
      }
    }
  }
  await walk(dirAbs);
  return sha256Hex(records.join("\n"));
}

const PLUGIN_MANIFEST_CANDIDATES = [
  "plugin.json",
  ".antigravity-plugin/plugin.json",
  ".gemini-plugin/plugin.json",
  "gemini-extension.json",
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  ".kimi-plugin/plugin.json",
  ".qoder-plugin/plugin.json",
];

async function readJsonFileIfPresent(fileAbs) {
  try {
    const st = await lstat(fileAbs);
    if (!st.isFile() || st.isSymbolicLink()) return null;
    return JSON.parse(await readFile(fileAbs, "utf8"));
  } catch {
    return null;
  }
}

async function resolvePluginManifestInDir(pluginDirAbs) {
  for (const rel of PLUGIN_MANIFEST_CANDIDATES) {
    const parsed = await readJsonFileIfPresent(path.join(pluginDirAbs, rel));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { hasMarker: true, manifest: parsed };
    }
  }
  return { hasMarker: false, manifest: null };
}

function isPluginBundleEnabled(pluginDirName, manifest, hostPluginConfigMap) {
  if (hostPluginConfigMap && Object.hasOwn(hostPluginConfigMap, pluginDirName)) {
    const entry = hostPluginConfigMap[pluginDirName];
    if (typeof entry === "boolean") return entry;
    if (entry && typeof entry === "object" && typeof entry.enabled === "boolean") {
      return entry.enabled;
    }
  }
  return manifest?.disabled !== true;
}

async function scanPluginRootLayer(layerAbs, dirents, layer, priorityIndex, hostPluginConfigMap) {
  const discovered = [];
  for (const dirent of dirents) {
    if (dirent.name.startsWith(".")) continue;
    const pluginDirAbs = path.join(layerAbs, dirent.name);
    const pluginSt = await lstat(pluginDirAbs);
    if (pluginSt.isSymbolicLink() || !pluginSt.isDirectory()) continue;
    const { hasMarker, manifest } = await resolvePluginManifestInDir(pluginDirAbs);
    if (!hasMarker) continue;
    if (!isPluginBundleEnabled(dirent.name, manifest, hostPluginConfigMap)) continue;

    const skillsDirAbs = path.join(pluginDirAbs, "skills");
    let skillsSt = null;
    try {
      skillsSt = await lstat(skillsDirAbs);
    } catch {
      continue;
    }
    if (!skillsSt.isDirectory() || skillsSt.isSymbolicLink()) continue;

    const skillDirents = await readdir(skillsDirAbs, { withFileTypes: true });
    skillDirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const skillDirent of skillDirents) {
      if (skillDirent.name.startsWith(".")) continue;
      const candidateAbs = path.join(skillsDirAbs, skillDirent.name);
      const st = await lstat(candidateAbs);
      if (st.isSymbolicLink() || !st.isDirectory()) continue;
      const skillMdAbs = path.join(candidateAbs, "SKILL.md");
      let mdStat = null;
      try {
        mdStat = await lstat(skillMdAbs);
      } catch {
        continue;
      }
      if (!mdStat.isFile() || mdStat.isSymbolicLink()) continue;
      const mdBytes = await readFile(skillMdAbs);
      const declaredName = parseFrontmatterName(mdBytes.toString("utf8"));
      const skillName = declaredName ?? skillDirent.name;
      const closureSha256 = await computeDirectoryClosureDigest(candidateAbs);
      discovered.push({
        skillName,
        declaredName,
        entryForm: "plugin-skill-directory",
        priority: priorityIndex + 1,
        layerId: layer.id,
        scope: layer.scope,
        layerLabel: layer.label,
        relativePath: `${dirent.name}/skills/${skillDirent.name}/SKILL.md`,
        displayLocation: `${layer.label}/${dirent.name}/skills/${skillDirent.name}/SKILL.md`,
        skillMdSha256: sha256Hex(mdBytes),
        closureSha256,
      });
    }
  }
  return discovered;
}

async function scanSingleLayer(layer, priorityIndex, hostPluginConfigMap = null) {
  const layerAbs = path.resolve(layer.root);
  let rootStat = null;
  try {
    rootStat = await lstat(layerAbs);
  } catch (cause) {
    if (cause?.code === "ENOENT") {
      return {
        meta: {
          priority: priorityIndex + 1,
          layerId: layer.id,
          scope: layer.scope,
          label: layer.label,
          exists: false,
          skillCount: 0,
        },
        skills: [],
      };
    }
    throw kitError(
      KIT_ERROR_KINDS.SKILL_SHADOWING_SCAN_FAILED,
      `无法读取技能层级目录 "${layer.label}"：${cause?.message ?? "读取失败"}`,
      { layerId: layer.id, scope: layer.scope },
    );
  }

  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw kitError(
      KIT_ERROR_KINDS.SKILL_SHADOWING_SCAN_FAILED,
      `技能层级根路径 "${layer.label}" 必须是真实目录（不接受普通文件或顶层符号链接）。`,
      { layerId: layer.id, scope: layer.scope },
    );
  }

  const dirents = await readdir(layerAbs, { withFileTypes: true });
  dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (layer.role === "plugin-root") {
    const discoveredPlugins = await scanPluginRootLayer(layerAbs, dirents, layer, priorityIndex, hostPluginConfigMap);
    return {
      meta: {
        priority: priorityIndex + 1,
        layerId: layer.id,
        scope: layer.scope,
        label: layer.label,
        exists: true,
        skillCount: discoveredPlugins.length,
      },
      skills: discoveredPlugins,
    };
  }
  const discovered = [];

  for (const dirent of dirents) {
    if (dirent.name.startsWith(".")) continue;
    const candidateAbs = path.join(layerAbs, dirent.name);
    const st = await lstat(candidateAbs);
    if (st.isSymbolicLink()) continue;

    if (st.isDirectory()) {
      const skillMdAbs = path.join(candidateAbs, "SKILL.md");
      let mdStat = null;
      try {
        mdStat = await lstat(skillMdAbs);
      } catch {
        continue;
      }
      if (!mdStat.isFile() || mdStat.isSymbolicLink()) continue;
      const mdBytes = await readFile(skillMdAbs);
      const declaredName = parseFrontmatterName(mdBytes.toString("utf8"));
      const skillName = declaredName ?? dirent.name;
      const closureSha256 = await computeDirectoryClosureDigest(candidateAbs);
      discovered.push({
        skillName,
        declaredName,
        entryForm: "directory",
        priority: priorityIndex + 1,
        layerId: layer.id,
        scope: layer.scope,
        layerLabel: layer.label,
        relativePath: `${dirent.name}/SKILL.md`,
        displayLocation: `${layer.label}/${dirent.name}/SKILL.md`,
        skillMdSha256: sha256Hex(mdBytes),
        closureSha256,
      });
    } else if (st.isFile() && dirent.name.endsWith(".md") && dirent.name.toLowerCase() !== "readme.md") {
      const mdBytes = await readFile(candidateAbs);
      const stem = dirent.name.slice(0, -3);
      const declaredName = parseFrontmatterName(mdBytes.toString("utf8"));
      const skillName = declaredName ?? stem;
      const digest = sha256Hex(mdBytes);
      discovered.push({
        skillName,
        declaredName,
        entryForm: "flat-markdown",
        priority: priorityIndex + 1,
        layerId: layer.id,
        scope: layer.scope,
        layerLabel: layer.label,
        relativePath: dirent.name,
        displayLocation: `${layer.label}/${dirent.name}`,
        skillMdSha256: digest,
        closureSha256: digest,
      });
    }
  }

  return {
    meta: {
      priority: priorityIndex + 1,
      layerId: layer.id,
      scope: layer.scope,
      label: layer.label,
      exists: true,
      skillCount: discovered.length,
    },
    skills: discovered,
  };
}

async function buildLayersFromOptions({
  layers,
  root,
  pluginRoots = [],
  userHome,
  hostId,
  hostsRoot,
}) {
  let canonicalHostId = null;
  let descriptor = null;
  if (hostId !== undefined) {
    descriptor = await describeHost({
      hostId,
      hostsRoot: hostsRoot ?? bundledHostProfilesRoot(),
    });
    canonicalHostId = descriptor.hostId;
  }

  if (Array.isArray(layers) && layers.length > 0) {
    const normalized = layers.map((entry, idx) => {
      if (!entry || typeof entry !== "object") {
        throw invalidParamsError(`layers[${idx}] 必须是对象`);
      }
      const scope = entry.scope ?? "custom";
      if (!ALLOWED_SCOPES.has(scope)) {
        throw invalidParamsError(
          `layers[${idx}].scope "${String(scope)}" 不合法（允许值：project、plugin、user、custom）`,
          { scope },
        );
      }
      if (typeof entry.root !== "string" || entry.root.length === 0) {
        throw invalidParamsError(`layers[${idx}].root 必须是非空目录路径`);
      }
      const id = typeof entry.id === "string" && entry.id.length > 0
        ? entry.id
        : `${scope}-${idx + 1}`;
      const label = typeof entry.label === "string" && entry.label.length > 0
        ? entry.label
        : `<${scope}:${id}>`;
      const role = entry.role === "plugin-root" ? "plugin-root" : "skill-root";
      return { id, scope, role, root: entry.root, label };
    });
    return { canonicalHostId, layers: normalized, hostPluginConfigMap: null };
  }

  let hostPluginConfigMap = null;
  if (typeof userHome === "string" && userHome.length > 0) {
    const agyConfig = await readJsonFileIfPresent(path.join(path.resolve(userHome), ".gemini", "config", "config.json"));
    if (agyConfig && typeof agyConfig === "object" && agyConfig.plugins && typeof agyConfig.plugins === "object") {
      hostPluginConfigMap = agyConfig.plugins;
    }
  }

  const assembled = [];
  if (root !== undefined) {
    const projectAbs = path.resolve(root);
    if (descriptor) {
      const projectCats = descriptor.pathCategories.filter((c) => c.scope === "project");
      for (const cat of projectCats) {
        assembled.push({
          id: cat.id,
          scope: "project",
          role: cat.role ?? "skill-root",
          root: path.join(projectAbs, cat.relPath),
          label: `<project-root>/${cat.relPath}`,
        });
      }
    } else {
      assembled.push({
        id: "project-agents-skills",
        scope: "project",
        role: "skill-root",
        root: path.join(projectAbs, ".agents", "skills"),
        label: "<project-root>/.agents/skills",
      });
      assembled.push({
        id: "project-skills",
        scope: "project",
        role: "skill-root",
        root: path.join(projectAbs, "skills"),
        label: "<project-root>/skills",
      });
    }
  }

  for (let i = 0; i < pluginRoots.length; i += 1) {
    const pluginRoot = pluginRoots[i];
    if (typeof pluginRoot !== "string" || pluginRoot.length === 0) {
      throw invalidParamsError("pluginRoots 中的每项必须是非空目录路径");
    }
    const resolvedPlugin = path.resolve(pluginRoot);
    const hasSkillsSubdir = path.basename(resolvedPlugin) === "skills";
    assembled.push({
      id: `plugin-${i + 1}`,
      scope: "plugin",
      role: "skill-root",
      root: hasSkillsSubdir ? resolvedPlugin : path.join(resolvedPlugin, "skills"),
      label: hasSkillsSubdir ? `<plugin-${i + 1}>` : `<plugin-${i + 1}>/skills`,
    });
  }

  if (userHome !== undefined) {
    if (typeof userHome !== "string" || userHome.length === 0) {
      throw invalidParamsError("userHome 必须是非空目录路径");
    }
    const userAbs = path.resolve(userHome);
    if (descriptor) {
      const userCats = descriptor.pathCategories.filter((c) => c.scope === "user");
      if (userCats.length > 0) {
        for (const cat of userCats) {
          assembled.push({
            id: cat.id,
            scope: "user",
            role: cat.role ?? "skill-root",
            root: path.join(userAbs, cat.relPath),
            label: `<user-home>/${cat.relPath}`,
          });
        }
      } else {
        assembled.push({
          id: `${descriptor.hostId}-user-agents-skills`,
          scope: "user",
          role: "skill-root",
          root: path.join(userAbs, ".agents", "skills"),
          label: "<user-home>/.agents/skills",
        });
      }
    } else {
      assembled.push({
        id: "user-agents-skills",
        scope: "user",
        role: "skill-root",
        root: path.join(userAbs, ".agents", "skills"),
        label: "<user-home>/.agents/skills",
      });
    }
  }

  if (assembled.length === 0) {
    throw invalidParamsError(
      "checkSkillShadowing 需要至少提供一个技能层级（可通过 --root / --plugin-root / --user-home 或显式 --layer 指定）",
    );
  }
  return { canonicalHostId, layers: assembled, hostPluginConfigMap };
}

function buildRemediationSteps(skillName, winner, shadowedList, classification) {
  const steps = [];
  if (classification === "same-layer-collision") {
    steps.push(
      `在同一层级（${winner.layerLabel}）内发现了多个均声明为 "${skillName}" 的技能入口；请修改其中一个入口 SKILL.md 的 frontmatter name 字段或合并重复目录，确保同层技能名唯一。`,
    );
  }
  const shadowedScopes = new Set(shadowedList.map((s) => s.scope));
  if (classification === "divergent-shadowing") {
    if (winner.scope === "project" && (shadowedScopes.has("plugin") || shadowedScopes.has("user"))) {
      steps.push(
        `当前项目层副本（${winner.displayLocation}）优先于低优先级层生效，且内容摘要与被遮蔽副本不一致；若希望启用新版插件或用户全局技能，请移除或重命名项目层旧副本。`,
      );
      steps.push(
        `若项目层定制版确需长期保留且职责不同，请为其改用带项目或领域前缀的独立技能名（避免与 "${skillName}" 同名）。`,
      );
    } else if (winner.scope === "plugin" && shadowedScopes.has("user")) {
      steps.push(
        `插件层技能（${winner.displayLocation}）遮蔽了用户全局层同名副本且内容不同；请清理 <user-home> 下过期的手工副本，统一由插件分发管理。`,
      );
    } else {
      steps.push(
        `高优先级层（${winner.displayLocation}）遮蔽了低优先级同名副本且内容已分叉；请核对预期生效版本，删除多余层级的陈旧副本或拆分技能命名。`,
      );
    }
  } else if (classification === "redundant-duplicate") {
    steps.push(
      `各层 "${skillName}" 副本内容当前完全一致，但后续单边升级极易演变为隐性版本漂移；建议仅保留单一权威安装层（推荐保留插件层或项目受管层）并移除重复副本。`,
    );
  }
  return steps;
}

/**
 * 只读扫描多层技能根目录（项目层 > 插件层 > 用户全局层或调用方自定义顺序），
 * 检测同名技能遮蔽、内容分叉与同层重名冲突，并给出清晰的修复建议。
 */
export async function checkSkillShadowing(options = {}) {
  const { canonicalHostId, layers, hostPluginConfigMap } = await buildLayersFromOptions(options);
  const precedenceOrder = [];
  const allDiscovered = [];

  for (let idx = 0; idx < layers.length; idx += 1) {
    const scanned = await scanSingleLayer(layers[idx], idx, hostPluginConfigMap);
    precedenceOrder.push(scanned.meta);
    allDiscovered.push(...scanned.skills);
  }

  const byName = new Map();
  for (const item of allDiscovered) {
    if (!byName.has(item.skillName)) byName.set(item.skillName, []);
    byName.get(item.skillName).push(item);
  }

  const sortedNames = [...byName.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const conflicts = [];

  for (const skillName of sortedNames) {
    const occurrences = byName.get(skillName);
    if (occurrences.length <= 1) continue;
    const winner = occurrences[0];
    const shadowed = occurrences.slice(1);
    const sameLayer = shadowed.some((item) => item.layerId === winner.layerId);
    const divergent = shadowed.some((item) => item.closureSha256 !== winner.closureSha256);

    let classification = "redundant-duplicate";
    let severity = "warning";
    if (sameLayer) {
      classification = "same-layer-collision";
      severity = "error";
    } else if (divergent) {
      classification = "divergent-shadowing";
      severity = "error";
    }

    const shadowedDesc = shadowed
      .map((s) => `${s.scope} 层（${s.displayLocation}）`)
      .join("、");
    const diffLabel = sameLayer
      ? "同层重名冲突"
      : divergent
        ? "内容摘要不一致，存在功能偏离风险"
        : "内容摘要一致，属于冗余重复部署";
    const summary = `技能 "${skillName}" 在 ${occurrences.length} 个位置重复出现：当前优先命中 ${winner.scope} 层（${winner.displayLocation}），遮蔽了 ${shadowedDesc}（${diffLabel}）。`;
    const remediation = buildRemediationSteps(skillName, winner, shadowed, classification);

    conflicts.push({
      kind: KIT_ERROR_KINDS.SKILL_SHADOWING_DETECTED,
      skillName,
      classification,
      severity,
      winner,
      shadowed,
      summary,
      remediation,
    });
  }

  const ok = conflicts.length === 0;
  const overallSummary = ok
    ? `已按优先级扫描 ${precedenceOrder.length} 个技能层级（共发现 ${allDiscovered.length} 个技能），未检出同名技能遮蔽冲突。`
    : `已按优先级扫描 ${precedenceOrder.length} 个技能层级（共发现 ${allDiscovered.length} 个技能），检出 ${conflicts.length} 组同名技能遮蔽或重名冲突。`;

  return Object.freeze({
    schemaVersion: 1,
    kind: SKILL_SHADOWING_REPORT_KIND,
    ok,
    status: ok ? "ok" : "findings",
    hostId: canonicalHostId,
    precedenceOrder,
    totalSkillsDiscovered: allDiscovered.length,
    uniqueSkillNames: byName.size,
    conflicts,
    summary: overallSummary,
  });
}

/**
 * 将同名技能遮蔽检查结果渲染为面向开发者阅读的中文排障摘要。
 */
export function formatSkillShadowingReport(report) {
  const lines = [
    `# 同名技能遮蔽与加载优先级诊断报告`,
    "",
    `- 诊断结论：${report.ok ? "通过（无同名遮蔽）" : `发现 ${report.conflicts.length} 组遮蔽冲突`}`,
    `- 目标宿主：${report.hostId ?? "通用多层扫描"}`,
    `- 扫描概况：${report.summary}`,
    "",
    "## 加载优先级顺序（由高到低）",
  ];
  for (const layer of report.precedenceOrder) {
    const stateText = layer.exists ? `存在，发现 ${layer.skillCount} 个技能` : "目录不存在（已跳过）";
    lines.push(`${layer.priority}. [${layer.scope}] ${layer.label} —— ${stateText}`);
  }
  if (report.conflicts.length > 0) {
    lines.push("", "## 遮蔽冲突明细与修复建议");
    for (const conflict of report.conflicts) {
      lines.push("", `### 技能 \`${conflict.skillName}\`（${conflict.classification}）`);
      lines.push(`- 现象说明：${conflict.summary}`);
      lines.push(`- 当前生效：\`${conflict.winner.displayLocation}\`（闭包摘要 \`${conflict.winner.closureSha256.slice(0, 12)}…\`）`);
      for (const item of conflict.shadowed) {
        lines.push(`- 被遮蔽项：\`${item.displayLocation}\`（闭包摘要 \`${item.closureSha256.slice(0, 12)}…\`）`);
      }
      for (const step of conflict.remediation) {
        lines.push(`- 修复建议：${step}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}
