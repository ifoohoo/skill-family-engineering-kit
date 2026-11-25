// @feature FND-FR-038
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import YAML from "yaml";
import { publishFileOrReplace } from "skill-family-harness-node";
import { invalidParamsError, KIT_ERROR_KINDS, kitError } from "./errors.mjs";
import {
  CLAUDE_DRIVER,
  CODEBUDDY_DRIVER,
  CODEX_DRIVER,
  CONTROLLED_NATIVE_LIFECYCLE_FIXTURE_PROTOCOL,
  CURSOR_DRIVER,
  evaluateControlledNativeLifecycleFixture,
  evaluateDriverStreamProtocol,
  KIMI_DRIVER,
  QODER_DRIVER,
  WORKBUDDY_DRIVER,
} from "./host-verification-drivers.mjs";
import { bundledHostProfilesRoot, resolveHostId } from "./host-profiles.mjs";

/** 受控模拟宿主夹具执行模式标识（严禁伪装为真实厂商在线鉴权收据）。 */
export const SIMULATED_EXECUTION_MODE = "foundation-simulated-fixture";

/** 多宿主生命周期模拟验证报告契约标识。 */
export const HOST_SIMULATOR_REPORT_KIND = "skill-family.host-simulator-report";

/** 伪宿主二进制垫片物化收据标识。 */
export const HOST_SIMULATOR_SHIMS_KIND = "skill-family.host-simulator-shims";

/** 支持零真机 CLI / 零账号登录全生命周期模拟的十大规范宿主。 */
export const SIMULATED_HOST_IDS = Object.freeze([
  "claude",
  "codex",
  "kimi-code",
  "qoder",
  "workbuddy",
  "codebuddy",
  "cursor",
  "deepseek-harness",
  "antigravity",
  "grok",
]);

export const SIMULATED_LIFECYCLE_STAGES = Object.freeze([
  "install-v1",
  "discover-v1",
  "invoke-v1",
  "disable",
  "enable",
  "update-v2",
  "invoke-v2",
  "uninstall",
]);

const HONESTY_BOUNDARY_NOTE =
  "本收据由 Foundation 本地确定性多宿主模拟器（foundation-simulated-fixture）生成，仅验证跨宿主物理目录布局、YAML frontmatter、plugin.json 清单、启停配置与流式输出协议接线，不代表真实厂商 CLI 云端登录鉴权或线上模型推理结果。";

const SIMULATED_HOST_SPECS = Object.freeze({
  claude: Object.freeze({
    hostId: "claude",
    displayName: "Claude Code",
    executableBasename: "claude",
    extraBinaries: Object.freeze([]),
    versionOutput: "2.1.233 (Claude Code)",
    versionPattern: CLAUDE_DRIVER.versionPattern,
    driver: CLAUDE_DRIVER,
    pluginSubdir: ".claude-plugin",
    installRelDir: (bundleId) => ({ anchor: "home", rel: `.claude/plugins/${bundleId}` }),
    configRelPath: ".claude/settings.json",
  }),
  codex: Object.freeze({
    hostId: "codex",
    displayName: "Codex",
    executableBasename: "codex",
    extraBinaries: Object.freeze([]),
    versionOutput: "codex-cli 0.154.0",
    versionPattern: CODEX_DRIVER.versionPattern,
    driver: CODEX_DRIVER,
    pluginSubdir: ".codex-plugin",
    installRelDir: () => ({ anchor: "workspace", rel: ".agents/skills" }),
    configRelPath: ".codex/config.json",
  }),
  "kimi-code": Object.freeze({
    hostId: "kimi-code",
    displayName: "Kimi Code",
    executableBasename: "kimi",
    extraBinaries: Object.freeze([]),
    versionOutput: "0.39.1",
    versionPattern: KIMI_DRIVER.versionPattern,
    driver: KIMI_DRIVER,
    pluginSubdir: ".kimi-plugin",
    installRelDir: () => ({ anchor: "workspace", rel: ".kimi-code/skills" }),
    configRelPath: ".kimi/config.json",
  }),
  qoder: Object.freeze({
    hostId: "qoder",
    displayName: "Qoder",
    executableBasename: "qoder",
    extraBinaries: Object.freeze(["qodercli"]),
    versionOutput: "0.18.0",
    versionPattern: QODER_DRIVER.versionPattern,
    driver: QODER_DRIVER,
    pluginSubdir: ".qoder-plugin",
    installRelDir: () => ({ anchor: "workspace", rel: ".qoder/skills" }),
    configRelPath: ".qoder/plugins.json",
  }),
  workbuddy: Object.freeze({
    hostId: "workbuddy",
    displayName: "WorkBuddy",
    executableBasename: "codebuddy",
    extraBinaries: Object.freeze([]),
    versionOutput: "1.2.0",
    versionPattern: WORKBUDDY_DRIVER.versionPattern,
    driver: WORKBUDDY_DRIVER,
    pluginSubdir: null,
    installRelDir: () => ({ anchor: "wb-config", rel: "skills" }),
    configRelPath: "config.json",
  }),
  codebuddy: Object.freeze({
    hostId: "codebuddy",
    displayName: "CodeBuddy",
    executableBasename: "codebuddy",
    extraBinaries: Object.freeze([]),
    versionOutput: "1.2.0",
    versionPattern: CODEBUDDY_DRIVER.versionPattern,
    driver: CODEBUDDY_DRIVER,
    pluginSubdir: null,
    installRelDir: () => ({ anchor: "workspace", rel: ".codebuddy/skills" }),
    configRelPath: ".codebuddy/config.json",
  }),
  cursor: Object.freeze({
    hostId: "cursor",
    displayName: "Cursor",
    executableBasename: "cursor-agent",
    extraBinaries: Object.freeze([]),
    versionOutput: "2026.09.08-6caf4ff",
    versionPattern: CURSOR_DRIVER.versionPattern,
    driver: CURSOR_DRIVER,
    pluginSubdir: null,
    installRelDir: () => ({ anchor: "workspace", rel: ".cursor/skills" }),
    configRelPath: ".cursor/config.json",
  }),
  "deepseek-harness": Object.freeze({
    hostId: "deepseek-harness",
    displayName: "DeepSeek Harness",
    executableBasename: "dsh",
    extraBinaries: Object.freeze([]),
    versionOutput: "0.1.1-rc.2",
    versionPattern: /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u,
    driver: null,
    pluginSubdir: null,
    installRelDir: () => ({ anchor: "workspace", rel: ".dsh/skills" }),
    configRelPath: ".dsh/config.json",
  }),
  antigravity: Object.freeze({
    hostId: "antigravity",
    displayName: "Antigravity",
    executableBasename: "agy",
    extraBinaries: Object.freeze([]),
    versionOutput: "agy 2.0.0",
    versionPattern: /^agy (0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u,
    driver: null,
    pluginSubdir: null,
    installRelDir: (bundleId) => ({ anchor: "home", rel: `.gemini/config/plugins/${bundleId}` }),
    configRelPath: ".gemini/config/config.json",
    cliSettingsRelPath: ".gemini/antigravity-cli/settings.json",
  }),
  grok: Object.freeze({
    hostId: "grok",
    displayName: "Grok Build",
    executableBasename: "grok",
    extraBinaries: Object.freeze([]),
    versionOutput: "0.4.0",
    versionPattern: /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u,
    driver: null,
    pluginSubdir: null,
    installRelDir: () => ({ anchor: "workspace", rel: ".grok/skills" }),
    configRelPath: ".grok/config.json",
  }),
});

function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

const ANTIGRAVITY_ALLOWED_PLUGIN_KEYS = new Set([
  "name",
  "description",
  "logo",
  "suggestedPrompts",
  "displayName",
  "version",
  "author",
  "homepage",
  "repository",
  "disabled",
]);

function isValidHttpsUrl(value) {
  if (typeof value !== "string" || !value.startsWith("https://")) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

function validateAntigravityRootManifest(parsed, label) {
  const errors = [];
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    errors.push(`[SFC2004] Antigravity 根插件清单 ${label} 顶层必须是合法 JSON 对象`);
    return errors;
  }
  const extraKeys = Object.keys(parsed).filter((key) => !ANTIGRAVITY_ALLOWED_PLUGIN_KEYS.has(key)).sort();
  if (extraKeys.length > 0) {
    errors.push(
      `[SFC2004] Antigravity 根插件清单 ${label} 包含非官方白名单顶层字段 (${extraKeys.join(", ")})；仅允许 ${Array.from(ANTIGRAVITY_ALLOWED_PLUGIN_KEYS).join(", ")}`,
    );
  }
  if (typeof parsed.name !== "string" || parsed.name.trim().length === 0) {
    errors.push(`[SFC2004] Antigravity 根插件清单 ${label} 缺少必填的非空字符串字段 name`);
  }
  if ("version" in parsed && (typeof parsed.version !== "string" || parsed.version.trim().length === 0)) {
    errors.push(`[SFC2004] Antigravity 根插件清单 ${label} 字段 version 必须是非空字符串`);
  }
  if ("displayName" in parsed && (typeof parsed.displayName !== "string" || parsed.displayName.trim().length === 0)) {
    errors.push(`[SFC2004] Antigravity 根插件清单 ${label} 字段 displayName 必须是非空字符串`);
  }
  if ("description" in parsed && typeof parsed.description !== "string") {
    errors.push(`[SFC2004] Antigravity 根插件清单 ${label} 字段 description 必须是字符串`);
  }
  if ("logo" in parsed && (typeof parsed.logo !== "string" || parsed.logo.trim().length === 0)) {
    errors.push(`[SFC2004] Antigravity 根插件清单 ${label} 字段 logo 必须是非空字符串`);
  }
  if (
    "suggestedPrompts" in parsed
    && !(Array.isArray(parsed.suggestedPrompts) && parsed.suggestedPrompts.every((p) => typeof p === "string" && p.trim().length > 0))
  ) {
    errors.push(`[SFC2004] Antigravity 根插件清单 ${label} 字段 suggestedPrompts 必须是非空字符串数组`);
  }
  if ("author" in parsed) {
    const validStr = typeof parsed.author === "string" && parsed.author.trim().length > 0;
    const validObj = Boolean(
      parsed.author
      && typeof parsed.author === "object"
      && !Array.isArray(parsed.author)
      && typeof parsed.author.name === "string"
      && parsed.author.name.trim().length > 0
      && Object.keys(parsed.author).every((k) => k === "name" || k === "url")
      && (!("url" in parsed.author) || isValidHttpsUrl(parsed.author.url)),
    );
    if (!validStr && !validObj) {
      errors.push(`[SFC2004] Antigravity 根插件清单 ${label} 字段 author 必须是非空字符串或仅含 name 与可选 https:// url 的对象`);
    }
  }
  if ("homepage" in parsed && !isValidHttpsUrl(parsed.homepage)) {
    errors.push(`[SFC2004] Antigravity 根插件清单 ${label} 字段 homepage 必须是合法 https:// URL`);
  }
  if ("repository" in parsed) {
    const validStr = isValidHttpsUrl(parsed.repository);
    const validObj = Boolean(
      parsed.repository
      && typeof parsed.repository === "object"
      && !Array.isArray(parsed.repository)
      && Object.keys(parsed.repository).every((k) => k === "type" || k === "url")
      && typeof parsed.repository.url === "string"
      && (isValidHttpsUrl(parsed.repository.url) || /^git\+https:\/\/\S+$/iu.test(parsed.repository.url))
      && (!("type" in parsed.repository) || (typeof parsed.repository.type === "string" && parsed.repository.type.trim().length > 0)),
    );
    if (!validStr && !validObj) {
      errors.push(`[SFC2004] Antigravity 根插件清单 ${label} 字段 repository 必须是 https:// URL 字符串或 { type, url } 对象`);
    }
  }
  if ("disabled" in parsed && typeof parsed.disabled !== "boolean") {
    errors.push(`[SFC2004] Antigravity 根插件清单 ${label} 字段 disabled 必须是布尔值`);
  }
  return errors;
}

export async function normalizeSimulatedHosts(hostsInput = "all", { hostsRoot } = {}) {
  const effectiveHostsRoot = hostsRoot ?? bundledHostProfilesRoot();
  if (hostsInput === undefined || hostsInput === null || hostsInput === "all") {
    return [...SIMULATED_HOST_IDS];
  }
  const rawList = Array.isArray(hostsInput)
    ? hostsInput
    : String(hostsInput)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  if (rawList.length === 0) {
    throw invalidParamsError("host-sim 至少需要指定一个目标宿主（可使用 all 或逗号分隔宿主列表）");
  }
  if (rawList.includes("all")) {
    return [...SIMULATED_HOST_IDS];
  }
  const resolved = [];
  for (const token of rawList) {
    const canonical = await resolveHostId({ hostId: token, hostsRoot: effectiveHostsRoot });
    if (!SIMULATED_HOST_SPECS[canonical]) {
      throw invalidParamsError(
        `宿主 "${token}"（规范 ID: "${canonical}"）不在 host-sim 支持的十大规范宿主集合内（支持：${SIMULATED_HOST_IDS.join(", ")}）`,
        { hostId: canonical },
      );
    }
    if (!resolved.includes(canonical)) resolved.push(canonical);
  }
  return resolved;
}

export function listSimulatedHosts() {
  return Object.freeze({
    schemaVersion: 1,
    kind: "skill-family.host-simulator-hosts",
    executionMode: SIMULATED_EXECUTION_MODE,
    hosts: Object.freeze(
      SIMULATED_HOST_IDS.map((hostId) => {
        const spec = SIMULATED_HOST_SPECS[hostId];
        return Object.freeze({
          hostId: spec.hostId,
          displayName: spec.displayName,
          executable: spec.executableBasename,
          extraBinaries: spec.extraBinaries,
          versionOutput: spec.versionOutput,
          configRelPath: spec.configRelPath,
        });
      }),
    ),
  });
}

function renderShimHeader(binaryName, defaultHostId) {
  return `#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const BINARY_NAME = ${JSON.stringify(binaryName)};
const DEFAULT_HOST_ID = ${JSON.stringify(defaultHostId)};
const EXECUTION_MODE = ${JSON.stringify(SIMULATED_EXECUTION_MODE)};
const CONTROLLED_PROTOCOL = ${JSON.stringify(CONTROLLED_NATIVE_LIFECYCLE_FIXTURE_PROTOCOL)};

const VERSION_BY_HOST = {
  claude: "2.1.233 (Claude Code)",
  codex: "codex-cli 0.154.0",
  "kimi-code": "0.39.1",
  qoder: "0.18.0",
  workbuddy: "1.2.0",
  codebuddy: "1.2.0",
  cursor: "2026.09.08-6caf4ff",
  "deepseek-harness": "0.1.1-rc.2",
  antigravity: "agy 2.0.0",
  grok: "0.4.0",
};

function resolveActiveHostId() {
  if (process.env.SF_SIM_HOST_ID && VERSION_BY_HOST[process.env.SF_SIM_HOST_ID]) {
    return process.env.SF_SIM_HOST_ID;
  }
  if (BINARY_NAME === "codebuddy") {
    if (process.env.WORKBUDDY_CONFIG_DIR || process.env.CODEBUDDY_CONFIG_DIR) return "workbuddy";
    return "codebuddy";
  }
  return DEFAULT_HOST_ID;
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const st = fs.lstatSync(filePath);
    if (!st.isFile() || st.isSymbolicLink()) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new Error(\`配置文件 JSON 解析失败 (\${filePath}): \${err.message}\`);
  }
}

function writeJsonEnsureDir(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + "\\n", "utf8");
}

function parseStrictSkillFrontmatter(mdText, fileLabel) {
  if (mdText.charCodeAt(0) === 0xfeff) {
    throw new Error(\`SKILL.md 不允许携带 UTF-8 BOM，缺少合法 YAML frontmatter 定界符 ---: \${fileLabel}\`);
  }
  const match = /^---\\r?\\n([\\s\\S]*?)\\r?\\n---(?:\\r?\\n|$)/u.exec(mdText);
  if (!match) {
    throw new Error(\`SKILL.md 缺少由 --- 包裹的 YAML frontmatter: \${fileLabel}\`);
  }
  const block = match[1];
  const lines = block.split(/\\r?\\n/u);
  let name = "";
  let description = "";
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const nameMatch = /^name\\s*:\\s*(.*)$/u.exec(line);
    if (nameMatch) {
      let val = nameMatch[1].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1).trim();
      }
      name = val;
      continue;
    }
    const descMatch = /^description\\s*:\\s*(.*)$/u.exec(line);
    if (descMatch) {
      let val = descMatch[1].trim();
      if (val === ">" || val === ">-" || val === "|" || val === "|-") {
        const folded = [];
        while (i + 1 < lines.length && /^[ \\t]+\\S/u.test(lines[i + 1])) {
          i += 1;
          folded.push(lines[i].trim());
        }
        val = folded.join(" ").trim();
      } else if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1).trim();
      }
      description = val;
    }
  }
  if (!name || !description) {
    throw new Error(\`SKILL.md frontmatter 必须同时包含非空 name 与 description 字段: \${fileLabel}\`);
  }
  if (name.length > 64) {
    throw new Error(\`SKILL.md frontmatter name 长度超过 64 字符上限: \${fileLabel}\`);
  }
  return { name, description };
}
`;
}

function renderShimBody() {
  return `
function resolveConfigFilePath(hostId, homeDir, configDirOverride) {
  if (configDirOverride) {
    if (hostId === "qoder") return path.join(configDirOverride, "plugins.json");
    return path.join(configDirOverride, "config.json");
  }
  switch (hostId) {
    case "claude":
      return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homeDir, ".claude"), "settings.json");
    case "codex":
      return path.join(process.env.CODEX_HOME || path.join(homeDir, ".codex"), "config.json");
    case "kimi-code":
      return path.join(process.env.KIMI_CODE_HOME || path.join(homeDir, ".kimi"), "config.json");
    case "qoder":
      return path.join(homeDir, ".qoder", "plugins.json");
    case "workbuddy":
      return path.join(process.env.WORKBUDDY_CONFIG_DIR || process.env.CODEBUDDY_CONFIG_DIR || path.join(homeDir, ".workbuddy"), "config.json");
    case "codebuddy":
      return path.join(homeDir, ".codebuddy", "config.json");
    case "cursor":
      return path.join(homeDir, ".cursor", "config.json");
    case "deepseek-harness":
      return path.join(homeDir, ".dsh", "config.json");
    case "antigravity":
      return path.join(homeDir, ".gemini", "config", "config.json");
    case "grok":
      return path.join(homeDir, ".grok", "config.json");
    default:
      return path.join(homeDir, ".config.json");
  }
}

function loadEnablementState(configFilePath) {
  const cfg = readJsonSafe(configFilePath) || {};
  const disabledPlugins = new Set();
  const enabledPlugins = new Set();
  const disabledSkills = new Set(Array.isArray(cfg?.skills?.disabled) ? cfg.skills.disabled : []);
  const pluginsMap = cfg.plugins && typeof cfg.plugins === "object" ? cfg.plugins : {};
  for (const [id, entry] of Object.entries(pluginsMap)) {
    const enabled = typeof entry === "boolean" ? entry : entry?.enabled;
    if (enabled === false) disabledPlugins.add(id);
    else if (enabled === true) enabledPlugins.add(id);
  }
  if (cfg.enabledPlugins && typeof cfg.enabledPlugins === "object") {
    for (const [id, val] of Object.entries(cfg.enabledPlugins)) {
      if (val === false) disabledPlugins.add(id);
      else if (val === true) enabledPlugins.add(id);
    }
  }
  return { raw: cfg, disabledPlugins, enabledPlugins, disabledSkills };
}

function scanSkillContainer(dirAbs, sourceLabel, state, discovered, disabledItems) {
  if (!dirAbs || !fs.existsSync(dirAbs)) return;
  const rootSt = fs.lstatSync(dirAbs);
  if (!rootSt.isDirectory() || rootSt.isSymbolicLink()) return;
  const entries = fs.readdirSync(dirAbs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const skillDir = path.join(dirAbs, entry.name);
    const st = fs.lstatSync(skillDir);
    if (st.isSymbolicLink() || !st.isDirectory()) continue;
    const skillMdPath = path.join(skillDir, "SKILL.md");
    if (!fs.existsSync(skillMdPath)) continue;
    const mdSt = fs.lstatSync(skillMdPath);
    if (!mdSt.isFile() || mdSt.isSymbolicLink()) continue;
    const bytes = fs.readFileSync(skillMdPath);
    const fm = parseStrictSkillFrontmatter(bytes.toString("utf8"), skillMdPath);
    if (state.disabledSkills.has(fm.name) || state.disabledSkills.has(entry.name) || state.disabledPlugins.has(fm.name) || state.disabledPlugins.has(entry.name)) {
      disabledItems.push({ kind: "skill", name: fm.name, dirName: entry.name, location: skillMdPath });
      continue;
    }
    discovered.push({
      name: fm.name,
      description: fm.description,
      source: sourceLabel,
      skillMdPath,
      sha256: sha256(bytes),
    });
  }
}

const ANTIGRAVITY_ALLOWED_PLUGIN_KEYS = new Set(${JSON.stringify([...ANTIGRAVITY_ALLOWED_PLUGIN_KEYS])});
${isValidHttpsUrl.toString()}
${validateAntigravityRootManifest.toString()}

function validateParsedPluginManifest(parsed, label) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(\`插件清单顶层必须是合法 JSON 对象: \${label}\`);
  }
  if (typeof parsed.name !== "string" || parsed.name.trim().length === 0) {
    throw new Error(\`插件清单缺少必填的非空字符串字段 name: \${label}\`);
  }
  if ("version" in parsed && (typeof parsed.version !== "string" || parsed.version.trim().length === 0)) {
    throw new Error(\`插件清单字段 version 必须是非空字符串: \${label}\`);
  }
  if ("displayName" in parsed && (typeof parsed.displayName !== "string" || parsed.displayName.trim().length === 0)) {
    throw new Error(\`插件清单字段 displayName 必须是非空字符串: \${label}\`);
  }
  if ("description" in parsed && typeof parsed.description !== "string") {
    throw new Error(\`插件清单字段 description 必须是字符串: \${label}\`);
  }
  if ("author" in parsed) {
    const validStrAuthor = typeof parsed.author === "string" && parsed.author.trim().length > 0;
    const validObjAuthor = Boolean(parsed.author && typeof parsed.author === "object" && !Array.isArray(parsed.author)
      && typeof parsed.author.name === "string" && parsed.author.name.trim().length > 0);
    if (!validStrAuthor && !validObjAuthor) {
      throw new Error(\`插件清单字段 author 必须是非空字符串或包含 name 的对象: \${label}\`);
    }
  }
  if ("repository" in parsed) {
    const validStrRepo = typeof parsed.repository === "string" && parsed.repository.trim().length > 0;
    const validObjRepo = Boolean(parsed.repository && typeof parsed.repository === "object" && !Array.isArray(parsed.repository)
      && typeof parsed.repository.url === "string" && parsed.repository.url.trim().length > 0);
    if (!validStrRepo && !validObjRepo) {
      throw new Error(\`插件清单字段 repository 必须是非空字符串或包含 url 的对象: \${label}\`);
    }
  }
  if ("homepage" in parsed && (typeof parsed.homepage !== "string" || parsed.homepage.trim().length === 0)) {
    throw new Error(\`插件清单字段 homepage 必须是非空字符串: \${label}\`);
  }
  if ("disabled" in parsed && typeof parsed.disabled !== "boolean") {
    throw new Error(\`插件清单字段 disabled 必须是布尔值: \${label}\`);
  }
  if (
    "skills" in parsed
    && typeof parsed.skills !== "string"
    && !(Array.isArray(parsed.skills) && parsed.skills.every((s) => typeof s === "string" && s.trim().length > 0))
  ) {
    throw new Error(\`插件清单字段 skills 必须是字符串或非空字符串数组: \${label}\`);
  }
}

function readPluginManifestStrict(pluginDir, activeHostId) {
  const candidates = [
    "plugin.json",
    ".antigravity-plugin/plugin.json",
    ".gemini-plugin/plugin.json",
    "gemini-extension.json",
    ".claude-plugin/plugin.json",
    ".codex-plugin/plugin.json",
    ".kimi-plugin/plugin.json",
    ".qoder-plugin/plugin.json",
    ".workbuddy-plugin/plugin.json",
    ".codebuddy-plugin/plugin.json",
    ".cursor-plugin/plugin.json",
    ".grok-plugin/plugin.json",
  ];
  let primary = null;
  for (const rel of candidates) {
    const abs = path.join(pluginDir, rel);
    let st = null;
    try {
      st = fs.lstatSync(abs);
    } catch (err) {
      if (err?.code === "ENOENT") continue;
      throw new Error(\`无法读取插件清单 (\${abs}): \${err.message}\`);
    }
    if (activeHostId === "antigravity" && rel === ".antigravity-plugin/plugin.json") {
      throw new Error(\`[SFC2004] Antigravity 禁止使用非官方路径清单 (\${abs})，仅支持根目录 plugin.json\`);
    }
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new Error(\`插件清单必须是真实普通文件 (\${abs})\`);
    }
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(abs, "utf8"));
    } catch (err) {
      throw new Error(\`插件清单 JSON 解析失败 (\${abs}): \${err.message}\`);
    }
    validateParsedPluginManifest(parsed, abs);
    if (activeHostId === "antigravity" && rel === "plugin.json") {
      const agyErrors = validateAntigravityRootManifest(parsed, abs);
      if (agyErrors.length > 0) {
        throw new Error(agyErrors[0]);
      }
    }
    if (!primary) primary = { manifestPath: abs, manifest: parsed };
  }
  return primary;
}

function scanSinglePluginBundle(pluginDir, dirKey, state, discovered, disabledItems, activeHostId) {
  if (!pluginDir || !fs.existsSync(pluginDir)) return;
  const st = fs.lstatSync(pluginDir);
  if (!st.isDirectory() || st.isSymbolicLink()) return;
  const found = readPluginManifestStrict(pluginDir, activeHostId);
  const pluginName = found?.manifest?.name || dirKey;
  const explicitlyDisabled = state.disabledPlugins.has(dirKey) || state.disabledPlugins.has(pluginName);
  const explicitlyEnabled = state.enabledPlugins.has(dirKey) || state.enabledPlugins.has(pluginName);
  const shipDisabled = found?.manifest?.disabled === true;
  if (explicitlyDisabled || (shipDisabled && !explicitlyEnabled)) {
    disabledItems.push({ kind: "plugin", name: pluginName, dirName: dirKey, location: pluginDir });
    const pSkillsDir = path.join(pluginDir, "skills");
    if (fs.existsSync(pSkillsDir) && fs.lstatSync(pSkillsDir).isDirectory()) {
      for (const sEntry of fs.readdirSync(pSkillsDir, { withFileTypes: true })) {
        if (sEntry.name.startsWith(".") || !sEntry.isDirectory()) continue;
        const sMd = path.join(pSkillsDir, sEntry.name, "SKILL.md");
        let sName = sEntry.name;
        if (fs.existsSync(sMd) && fs.lstatSync(sMd).isFile()) {
          try { sName = parseStrictSkillFrontmatter(fs.readFileSync(sMd, "utf8"), sMd).name; } catch {}
        }
        disabledItems.push({ kind: "plugin-skill", name: sName, dirName: sEntry.name, pluginName, location: sMd });
      }
    }
    return;
  }
  scanSkillContainer(path.join(pluginDir, "skills"), \`plugin:\${dirKey}\`, state, discovered, disabledItems);
}

function scanPluginContainer(pluginsRoot, state, discovered, disabledItems, activeHostId) {
  if (!pluginsRoot || !fs.existsSync(pluginsRoot)) return;
  const rootSt = fs.lstatSync(pluginsRoot);
  if (!rootSt.isDirectory() || rootSt.isSymbolicLink()) return;
  const entries = fs.readdirSync(pluginsRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    scanSinglePluginBundle(path.join(pluginsRoot, entry.name), entry.name, state, discovered, disabledItems, activeHostId);
  }
}
`;
}

function renderShimFooter() {
  return `
function discoverHostAssets({ hostId, workspaceDir, homeDir, pluginDirFlag, skillsDirFlag, configDirOverride }) {
  const configFilePath = resolveConfigFilePath(hostId, homeDir, configDirOverride);
  const state = loadEnablementState(configFilePath);
  const discovered = [];
  const disabledItems = [];

  if (pluginDirFlag) {
    scanSinglePluginBundle(path.resolve(pluginDirFlag), path.basename(path.resolve(pluginDirFlag)), state, discovered, disabledItems, hostId);
  }
  if (skillsDirFlag) {
    scanSkillContainer(path.resolve(skillsDirFlag), "flag-skills-dir", state, discovered, disabledItems);
  }

  switch (hostId) {
    case "claude":
      scanSkillContainer(path.join(workspaceDir, ".claude", "skills"), "project-skills", state, discovered, disabledItems);
      scanPluginContainer(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homeDir, ".claude"), "plugins"), state, discovered, disabledItems, hostId);
      scanSkillContainer(path.join(homeDir, ".claude", "skills"), "user-skills", state, discovered, disabledItems);
      break;
    case "codex":
      scanSkillContainer(path.join(workspaceDir, ".agents", "skills"), "project-agents-skills", state, discovered, disabledItems);
      scanSkillContainer(path.join(workspaceDir, ".codex", "skills"), "project-codex-skills", state, discovered, disabledItems);
      scanPluginContainer(path.join(process.env.CODEX_HOME || path.join(homeDir, ".codex"), "plugins"), state, discovered, disabledItems, hostId);
      scanSkillContainer(path.join(homeDir, ".agents", "skills"), "user-agents-skills", state, discovered, disabledItems);
      break;
    case "kimi-code":
      scanSkillContainer(path.join(workspaceDir, ".kimi-code", "skills"), "project-skills", state, discovered, disabledItems);
      scanSkillContainer(path.join(workspaceDir, "skills"), "plugin-adapter-skills", state, discovered, disabledItems);
      scanPluginContainer(path.join(process.env.KIMI_CODE_HOME || path.join(homeDir, ".kimi"), "plugins"), state, discovered, disabledItems, hostId);
      scanSkillContainer(path.join(process.env.KIMI_CODE_HOME || path.join(homeDir, ".kimi"), "skills"), "user-skills", state, discovered, disabledItems);
      break;
    case "qoder":
      scanSkillContainer(path.join(workspaceDir, ".qoder", "skills"), "project-skills", state, discovered, disabledItems);
      scanPluginContainer(path.join(configDirOverride || path.join(homeDir, ".qoder"), "plugins"), state, discovered, disabledItems, hostId);
      break;
    case "workbuddy": {
      const wbRoot = process.env.WORKBUDDY_CONFIG_DIR || process.env.CODEBUDDY_CONFIG_DIR || path.join(homeDir, ".workbuddy");
      scanSkillContainer(path.join(wbRoot, "skills"), "wb-config-skills", state, discovered, disabledItems);
      scanSkillContainer(path.join(workspaceDir, ".workbuddy", "skills"), "project-skills", state, discovered, disabledItems);
      scanPluginContainer(path.join(wbRoot, "plugins"), state, discovered, disabledItems, hostId);
      break;
    }
    case "codebuddy":
      scanSkillContainer(path.join(workspaceDir, ".codebuddy", "skills"), "project-skills", state, discovered, disabledItems);
      scanPluginContainer(path.join(homeDir, ".codebuddy", "plugins"), state, discovered, disabledItems, hostId);
      break;
    case "cursor":
      scanSkillContainer(path.join(workspaceDir, ".cursor", "skills"), "project-skills", state, discovered, disabledItems);
      scanPluginContainer(path.join(workspaceDir, ".cursor", "plugins"), state, discovered, disabledItems, hostId);
      break;
    case "deepseek-harness":
      scanSkillContainer(path.join(workspaceDir, ".dsh", "skills"), "project-skills", state, discovered, disabledItems);
      scanSkillContainer(path.join(homeDir, ".dsh", "skills"), "user-skills", state, discovered, disabledItems);
      scanPluginContainer(path.join(homeDir, ".dsh", "plugins"), state, discovered, disabledItems, hostId);
      break;
    case "antigravity":
      scanSkillContainer(path.join(workspaceDir, ".agents", "skills"), "project-agents-skills", state, discovered, disabledItems);
      scanSkillContainer(path.join(workspaceDir, ".agent", "skills"), "project-compat-skills", state, discovered, disabledItems);
      scanPluginContainer(path.join(workspaceDir, ".agents", "plugins"), state, discovered, disabledItems, hostId);
      scanSkillContainer(path.join(homeDir, ".gemini", "config", "skills"), "user-skills", state, discovered, disabledItems);
      scanPluginContainer(path.join(homeDir, ".gemini", "config", "plugins"), state, discovered, disabledItems, hostId);
      break;
    case "grok":
      scanSkillContainer(path.join(workspaceDir, ".grok", "skills"), "project-skills", state, discovered, disabledItems);
      scanSkillContainer(path.join(homeDir, ".grok", "skills"), "user-skills", state, discovered, disabledItems);
      scanPluginContainer(path.join(homeDir, ".grok", "plugins"), state, discovered, disabledItems, hostId);
      break;
    default:
      break;
  }

  const seen = new Set();
  const deduped = [];
  for (const item of discovered) {
    if (!seen.has(item.name)) {
      seen.add(item.name);
      deduped.push(item);
    }
  }
  return { configFilePath, discovered: deduped, disabledItems };
}

function parseShimArgs(argv) {
  const opts = {
    version: false,
    subcommands: [],
    prompt: null,
    workspaceDir: null,
    pluginDir: null,
    skillsDir: null,
    configDir: null,
    outputFormat: null,
    targetSkill: null,
    requireDiscovered: process.env.SF_SIM_REQUIRE_DISCOVERED === "1",
    controlledStage: process.env.SF_CONTROLLED_LIFECYCLE_STAGE || null,
    controlledStep: process.env.SF_CONTROLLED_LIFECYCLE_STEP || null,
  };
  const valueFlags = new Set([
    "--cwd", "--workspace", "--plugin-dir", "--skills-dir", "--config-dir",
    "--output-format", "-o", "--mode", "--sandbox", "--permission-mode",
    "--scope", "--name", "--ref", "--skill", "--controlled-stage", "--controlled-step",
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--version" || arg === "-v") { opts.version = true; continue; }
    if (arg === "--require-discovered") { opts.requireDiscovered = true; continue; }
    if (arg === "-p" || arg === "--print") {
      if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
        opts.prompt = argv[++i];
      }
      continue;
    }
    if (valueFlags.has(arg)) {
      const val = argv[++i] ?? "";
      if (arg === "--cwd" || arg === "--workspace") opts.workspaceDir = val;
      else if (arg === "--plugin-dir") opts.pluginDir = val;
      else if (arg === "--skills-dir") opts.skillsDir = val;
      else if (arg === "--config-dir") opts.configDir = val;
      else if (arg === "--output-format" || arg === "-o") opts.outputFormat = val;
      else if (arg === "--skill") opts.targetSkill = val;
      else if (arg === "--controlled-stage") opts.controlledStage = val;
      else if (arg === "--controlled-step") opts.controlledStep = val;
      continue;
    }
    if (arg.startsWith("-")) continue;
    opts.subcommands.push(arg);
  }
  if (opts.prompt === null && opts.subcommands.length > 0) {
    const first = opts.subcommands[0];
    if (first === "exec" && opts.subcommands.length >= 2) {
      opts.prompt = opts.subcommands[opts.subcommands.length - 1];
    } else if (!["plugin", "plugins", "discover"].includes(first)) {
      opts.prompt = opts.subcommands[opts.subcommands.length - 1];
    }
  }
  return opts;
}
`;
}

function renderShimEntryMain() {
  return `
function emitControlledFixture(hostId, stage, step, outcomeOverride = null) {
  const isInvoke = step.includes("invoke");
  const outcome = outcomeOverride || (step === "plugin-invoke-negative" ? "blocked" : "succeeded");
  const invocation = isInvoke
    ? [{ callId: "sim-call-1", result: { callId: "sim-call-1", outcome } }]
    : [];
  const payload = {
    hostId,
    invocation,
    protocol: CONTROLLED_PROTOCOL,
    stage,
    stageCode: \`\${stage}:ok\`,
    step,
  };
  process.stdout.write(JSON.stringify(payload) + "\\n");
}

function emitHostInvocationStream(hostId, discovered, promptText) {
  const summaryPayload = {
    executionMode: EXECUTION_MODE,
    hostId,
    prompt: promptText || "",
    skillCount: discovered.length,
    skills: discovered.map((s) => ({ name: s.name, sha256: s.sha256, source: s.source })),
  };
  const summaryText = JSON.stringify(summaryPayload);

  if (hostId === "claude") {
    const lines = [
      JSON.stringify({ type: "system", subtype: "init", executionMode: EXECUTION_MODE, hostId, skills: summaryPayload.skills }),
      JSON.stringify({ type: "assistant", executionMode: EXECUTION_MODE, message: { role: "assistant", content: [{ type: "text", text: summaryText }] } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, executionMode: EXECUTION_MODE, hostId, result: summaryText, discoveredSkills: summaryPayload.skills }),
    ];
    process.stdout.write(lines.join("\\n") + "\\n");
    return;
  }
  if (hostId === "codex") {
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "sim-codex-thread", executionMode: EXECUTION_MODE }),
      JSON.stringify({ type: "turn.started", executionMode: EXECUTION_MODE }),
      JSON.stringify({ type: "item.completed", executionMode: EXECUTION_MODE, item: { id: "msg-1", type: "agent_message", text: summaryText } }),
      JSON.stringify({ type: "turn.completed", executionMode: EXECUTION_MODE, usage: { input_tokens: 12, output_tokens: 24 } }),
    ];
    process.stdout.write(lines.join("\\n") + "\\n");
    return;
  }
  if (hostId === "qoder") {
    process.stdout.write(JSON.stringify({
      type: "result",
      is_error: false,
      executionMode: EXECUTION_MODE,
      hostId,
      result: summaryText,
      discoveredSkills: summaryPayload.skills,
    }) + "\\n");
    return;
  }
  if (hostId === "cursor") {
    process.stdout.write(JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      executionMode: EXECUTION_MODE,
      hostId,
      result: summaryText,
      discoveredSkills: summaryPayload.skills,
    }) + "\\n");
    return;
  }
  process.stdout.write(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    executionMode: EXECUTION_MODE,
    hostId,
    result: summaryText,
    discoveredSkills: summaryPayload.skills,
  }) + "\\n");
}

try {
  const hostId = resolveActiveHostId();
  const opts = parseShimArgs(process.argv.slice(2));
  const homeDir = process.env.HOME || process.env.USERPROFILE || process.cwd();
  const workspaceDir = opts.workspaceDir ? path.resolve(opts.workspaceDir) : process.cwd();

  if (opts.version && !opts.controlledStage) {
    process.stdout.write((VERSION_BY_HOST[hostId] || "1.0.0") + "\\n");
    process.exit(0);
  }

  const configFilePath = resolveConfigFilePath(hostId, homeDir, opts.configDir);
  if (opts.subcommands[0] === "plugin" || opts.subcommands[0] === "plugins") {
    const action = opts.subcommands[1] || "list";
    const targetId = (opts.subcommands[2] || "").split("@")[0];
    if (action === "disable" && targetId) {
      const cfg = readJsonSafe(configFilePath) || {};
      cfg.plugins = cfg.plugins && typeof cfg.plugins === "object" ? cfg.plugins : {};
      cfg.plugins[targetId] = { enabled: false };
      writeJsonEnsureDir(configFilePath, cfg);
      if (opts.controlledStage) { emitControlledFixture(hostId, opts.controlledStage, opts.controlledStep || "plugin-disable"); process.exit(0); }
      process.stdout.write(JSON.stringify({ ok: true, executionMode: EXECUTION_MODE, hostId, action: "disable", targetId, configFilePath }) + "\\n");
      process.exit(0);
    }
    if (action === "enable" && targetId) {
      const cfg = readJsonSafe(configFilePath) || {};
      cfg.plugins = cfg.plugins && typeof cfg.plugins === "object" ? cfg.plugins : {};
      cfg.plugins[targetId] = { enabled: true };
      writeJsonEnsureDir(configFilePath, cfg);
      if (opts.controlledStage) { emitControlledFixture(hostId, opts.controlledStage, opts.controlledStep || "plugin-enable"); process.exit(0); }
      process.stdout.write(JSON.stringify({ ok: true, executionMode: EXECUTION_MODE, hostId, action: "enable", targetId, configFilePath }) + "\\n");
      process.exit(0);
    }
    const scan = discoverHostAssets({ hostId, workspaceDir, homeDir, pluginDirFlag: opts.pluginDir, skillsDirFlag: opts.skillsDir, configDirOverride: opts.configDir });
    if (opts.controlledStage) { emitControlledFixture(hostId, opts.controlledStage, opts.controlledStep || "plugin-list"); process.exit(0); }
    process.stdout.write(JSON.stringify({ ok: true, executionMode: EXECUTION_MODE, hostId, discoveredSkills: scan.discovered, disabledItems: scan.disabledItems }) + "\\n");
    process.exit(0);
  }

  const scan = discoverHostAssets({ hostId, workspaceDir, homeDir, pluginDirFlag: opts.pluginDir, skillsDirFlag: opts.skillsDir, configDirOverride: opts.configDir });
  if (opts.subcommands[0] === "discover") {
    process.stdout.write(JSON.stringify({ ok: true, executionMode: EXECUTION_MODE, hostId, discoveredSkills: scan.discovered, disabledItems: scan.disabledItems }) + "\\n");
    process.exit(0);
  }

  const requestedSkill = opts.targetSkill || (/\\$skill:([a-z0-9_:-]+)/iu.exec(opts.prompt || "")?.[1] ?? null);
  const isDisabledTarget = requestedSkill
    ? scan.disabledItems.some((d) => d.name === requestedSkill || d.dirName === requestedSkill)
    : scan.discovered.length === 0 && scan.disabledItems.length > 0;

  if (opts.controlledStage) {
    if (opts.controlledStep === "plugin-invoke-negative") {
      if (!isDisabledTarget) {
        process.stdout.write(JSON.stringify({ hostId, invocation: [{ callId: "sim-call-1", result: { callId: "sim-call-1", outcome: "succeeded" } }], protocol: CONTROLLED_PROTOCOL, stage: opts.controlledStage, stageCode: "disable:call-succeeded", step: opts.controlledStep }) + "\\n");
        process.exit(0);
      }
      emitControlledFixture(hostId, opts.controlledStage, opts.controlledStep, "blocked");
      process.exit(0);
    }
    emitControlledFixture(hostId, opts.controlledStage, opts.controlledStep || "plugin-invoke", "succeeded");
    process.exit(0);
  }

  if (isDisabledTarget) {
    process.stderr.write(\`[host-sim:\${BINARY_NAME}] 目标技能或插件已被宿主禁用，拒绝调用: \${requestedSkill || "bundle"}\\n\`);
    process.exit(1);
  }
  if (requestedSkill && !scan.discovered.some((s) => s.name === requestedSkill)) {
    process.stderr.write(\`[host-sim:\${BINARY_NAME}] 未发现已启用的目标技能: \${requestedSkill}\\n\`);
    process.exit(1);
  }
  if (opts.requireDiscovered && scan.discovered.length === 0) {
    process.stderr.write(\`[host-sim:\${BINARY_NAME}] 当前宿主沙箱未发现任何可用技能\\n\`);
    process.exit(1);
  }
  emitHostInvocationStream(hostId, scan.discovered, opts.prompt);
} catch (err) {
  process.stderr.write(\`[host-sim:\${BINARY_NAME}] \${err?.message || String(err)}\\n\`);
  process.exit(2);
}
`;
}

function buildShimScriptSource(binaryName, defaultHostId) {
  return `${renderShimHeader(binaryName, defaultHostId)}${renderShimBody()}${renderShimFooter()}${renderShimEntryMain()}`;
}

/**
 * 在指定输出目录生成十大规范宿主的确定性 Node 伪宿主可执行垫片脚本。
 */
export async function materializeSimulatedHostShims({
  outputDir,
  hosts = "all",
  hostsRoot,
} = {}) {
  if (typeof outputDir !== "string" || outputDir.trim().length === 0) {
    throw invalidParamsError("materializeSimulatedHostShims 需要非空 --output-dir 目录路径");
  }
  const selectedHosts = await normalizeSimulatedHosts(hosts, { hostsRoot });
  const targetAbs = path.resolve(outputDir);
  await mkdir(targetAbs, { recursive: true });

  const writtenBinaries = new Map();
  const shimsByHost = {};

  for (const hostId of selectedHosts) {
    const spec = SIMULATED_HOST_SPECS[hostId];
    const binaries = [spec.executableBasename, ...spec.extraBinaries];
    const hostPaths = [];
    for (const binName of binaries) {
      const binAbs = path.join(targetAbs, binName);
      if (!writtenBinaries.has(binName)) {
        const scriptSource = buildShimScriptSource(binName, hostId);
        await writeFile(binAbs, scriptSource, { encoding: "utf8", mode: 0o755 });
        await chmod(binAbs, 0o755);
        if (process.platform === "win32") {
          const cmdAbs = `${binAbs}.cmd`;
          await writeFile(cmdAbs, `@ECHO OFF\r\n"${process.execPath}" "${binAbs}" %*\r\n`, "utf8");
        }
        writtenBinaries.set(binName, {
          binary: binName,
          path: binAbs,
          sha256: sha256Hex(scriptSource),
        });
      }
      hostPaths.push(binAbs);
    }
    shimsByHost[hostId] = {
      hostId,
      executable: hostPaths[0],
      allBinaries: hostPaths,
      versionOutput: spec.versionOutput,
    };
  }

  return Object.freeze({
    schemaVersion: 1,
    kind: HOST_SIMULATOR_SHIMS_KIND,
    executionMode: SIMULATED_EXECUTION_MODE,
    outputDir: targetAbs,
    hosts: selectedHosts,
    binaries: [...writtenBinaries.values()],
    shimsByHost,
  });
}

/**
 * 创建隔离的多宿主模拟沙箱环境（含独立 HOME、工作区、证据目录与已物化的伪宿主二进制 PATH）。
 */
export async function createSimulatedHostEnvironment({
  baseDir,
  hosts = "all",
  hostsRoot,
} = {}) {
  const parentTmp = baseDir ? path.resolve(baseDir) : await realpath(os.tmpdir());
  await mkdir(parentTmp, { recursive: true });
  const rootDir = await mkdtemp(path.join(parentTmp, "sf-host-sim-"));
  const shimsDir = path.join(rootDir, "shims");
  const homeDir = path.join(rootDir, "home");
  const workspaceDir = path.join(rootDir, "workspace");
  const wbConfigDir = path.join(rootDir, "workbuddy-config");
  const evidenceDir = path.join(rootDir, "evidence");

  await mkdir(shimsDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(wbConfigDir, { recursive: true });
  await mkdir(evidenceDir, { recursive: true });

  await mkdir(path.join(homeDir, ".gemini", "antigravity-cli"), { recursive: true });
  await writeFile(
    path.join(homeDir, ".gemini", "antigravity-cli", "settings.json"),
    `${JSON.stringify({ executionMode: SIMULATED_EXECUTION_MODE, telemetry: false }, null, 2)}\n`,
    "utf8",
  );
  await mkdir(path.join(homeDir, ".gemini", "config"), { recursive: true });
  await writeFile(
    path.join(homeDir, ".gemini", "config", "config.json"),
    `${JSON.stringify({ plugins: {} }, null, 2)}\n`,
    "utf8",
  );

  const shimsReceipt = await materializeSimulatedHostShims({
    outputDir: shimsDir,
    hosts,
    hostsRoot,
  });

  const nodeBinDir = path.dirname(process.execPath);
  const pathSep = process.platform === "win32" ? ";" : ":";
  const env = {
    NO_COLOR: "1",
    HOME: homeDir,
    USERPROFILE: homeDir,
    TMPDIR: evidenceDir,
    PATH: [shimsDir, nodeBinDir, process.env.PATH || ""].filter(Boolean).join(pathSep),
    CLAUDE_CONFIG_DIR: path.join(homeDir, ".claude"),
    CODEX_HOME: path.join(homeDir, ".codex"),
    KIMI_CODE_HOME: path.join(homeDir, ".kimi"),
    WORKBUDDY_CONFIG_DIR: wbConfigDir,
    CODEBUDDY_CONFIG_DIR: wbConfigDir,
  };

  return {
    executionMode: SIMULATED_EXECUTION_MODE,
    rootDir,
    shimsDir,
    homeDir,
    workspaceDir,
    wbConfigDir,
    evidenceDir,
    shims: shimsReceipt,
    env,
    async cleanup() {
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

const SKIP_CANDIDATE_DIRS = new Set(["node_modules", ".git", ".artifacts", "dist", "coverage", ".task-state"]);

async function computeDirectoryDigest(dirAbs) {
  let rootSt = null;
  try {
    rootSt = await lstat(dirAbs);
  } catch {
    return null;
  }
  if (!rootSt.isDirectory()) return null;
  const records = [];
  async function walk(cur) {
    const entries = await readdir(cur, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (SKIP_CANDIDATE_DIRS.has(entry.name)) continue;
      const child = path.join(cur, entry.name);
      const rel = path.relative(dirAbs, child).split(path.sep).join("/");
      const st = await lstat(child);
      if (st.isSymbolicLink()) {
        records.push(`symlink:${rel}`);
      } else if (st.isDirectory()) {
        await walk(child);
      } else if (st.isFile()) {
        const bytes = await readFile(child);
        records.push(`file:${rel}:${sha256Hex(bytes)}`);
      }
    }
  }
  await walk(dirAbs);
  return sha256Hex(records.join("\n"));
}

const EXTRA_DISCOVERY_SKIP_DIRS = new Set([
  ...SKIP_CANDIDATE_DIRS,
  "tests",
  "test",
  "__tests__",
  "fixtures",
  "evidence",
  "runs",
  "generated",
  "versions",
]);

function sanitizeDirName(name, fallback = "sim-skill") {
  const cleaned = String(name || "").replace(/[^a-zA-Z0-9_.-]/gu, "-");
  return cleaned || fallback;
}

async function lstatNoSymlink(targetAbs, label = targetAbs) {
  let st;
  try {
    st = await lstat(targetAbs);
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw kitError(KIT_ERROR_KINDS.HOST_SIMULATOR_FAILED, `无法读取候选路径 "${label}": ${err.message}`);
  }
  if (st.isSymbolicLink()) {
    throw kitError(KIT_ERROR_KINDS.HOST_SIMULATOR_FAILED, `候选目录安全边界拒绝符号链接: ${label}`);
  }
  return st;
}

async function resolveContainedSubdir(baseAbs, relInput) {
  if (typeof relInput !== "string" || relInput.trim().length === 0) return null;
  const raw = relInput.trim();
  if (raw.includes("\0") || raw.includes("\\") || path.isAbsolute(raw)) {
    throw kitError(KIT_ERROR_KINDS.HOST_SIMULATOR_FAILED, `候选子路径禁止绝对路径或非法字符: ${relInput}`);
  }
  const normalized = raw.replace(/^\.\/+/u, "").replace(/\/+$/u, "");
  if (normalized === "" || normalized === ".") {
    const baseSt = await lstatNoSymlink(baseAbs, baseAbs);
    return baseSt?.isDirectory() ? baseAbs : null;
  }
  const segments = normalized.split("/");
  let cur = baseAbs;
  for (const seg of segments) {
    if (!seg || seg === "." || seg === "..") {
      throw kitError(KIT_ERROR_KINDS.HOST_SIMULATOR_FAILED, `候选子路径禁止越界段: ${relInput}`);
    }
    cur = path.join(cur, seg);
    const st = await lstatNoSymlink(cur, cur);
    if (!st) return null;
    if (!st.isDirectory()) return null;
  }
  const [realBase, realCur] = await Promise.all([realpath(baseAbs), realpath(cur)]);
  const relBack = path.relative(realBase, realCur);
  if (relBack !== "" && (relBack.startsWith("..") || path.isAbsolute(relBack))) {
    throw kitError(KIT_ERROR_KINDS.HOST_SIMULATOR_FAILED, `候选子路径越出根目录边界: ${relInput}`);
  }
  return cur;
}

async function collectSkillAtDir(skillDirAbs, preferredDirName, skills, seenSourceDirs) {
  const st = await lstatNoSymlink(skillDirAbs, skillDirAbs);
  if (!st?.isDirectory()) return false;
  const mdAbs = path.join(skillDirAbs, "SKILL.md");
  const mdSt = await lstatNoSymlink(mdAbs, mdAbs);
  if (!mdSt?.isFile()) return false;
  const key = await realpath(skillDirAbs);
  if (seenSourceDirs.has(key)) return false;
  seenSourceDirs.add(key);
  let dirName = sanitizeDirName(preferredDirName || path.basename(skillDirAbs));
  if (skills.some((s) => s.dirName === dirName)) {
    dirName = sanitizeDirName(`${path.basename(path.dirname(skillDirAbs))}--${dirName}`, dirName);
  }
  skills.push({ dirName, sourceDir: skillDirAbs, skillMdPath: mdAbs });
  return true;
}

async function collectOneLevelContainer(containerAbs, skills, seenSourceDirs, skipDot = true) {
  const st = await lstatNoSymlink(containerAbs, containerAbs);
  if (!st?.isDirectory()) return;
  const entries = (await readdir(containerAbs, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (skipDot && entry.name.startsWith(".")) continue;
    if (EXTRA_DISCOVERY_SKIP_DIRS.has(entry.name)) continue;
    await collectSkillAtDir(path.join(containerAbs, entry.name), entry.name, skills, seenSourceDirs);
  }
}

async function collectPlaybooksContainer(playbooksAbs, skills, seenSourceDirs) {
  const st = await lstatNoSymlink(playbooksAbs, playbooksAbs);
  if (!st?.isDirectory()) return;
  const categories = (await readdir(playbooksAbs, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const cat of categories) {
    if (cat.name.startsWith(".") || EXTRA_DISCOVERY_SKIP_DIRS.has(cat.name)) continue;
    const catAbs = path.join(playbooksAbs, cat.name);
    const catSt = await lstatNoSymlink(catAbs, catAbs);
    if (!catSt?.isDirectory()) continue;
    await collectOneLevelContainer(catAbs, skills, seenSourceDirs);
  }
}

async function collectRecursiveSourceContainer(srcAbs, packageName, skills, seenSourceDirs, depth = 0) {
  if (depth > 5) return;
  const st = await lstatNoSymlink(srcAbs, srcAbs);
  if (!st?.isDirectory()) return;
  const dirBase = path.basename(srcAbs);
  const preferredName = dirBase === "core" && packageName ? packageName : dirBase;
  await collectSkillAtDir(srcAbs, preferredName, skills, seenSourceDirs);
  const entries = (await readdir(srcAbs, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name.startsWith(".") || EXTRA_DISCOVERY_SKIP_DIRS.has(entry.name)) continue;
    const childAbs = path.join(srcAbs, entry.name);
    const childSt = await lstatNoSymlink(childAbs, childAbs);
    if (childSt?.isDirectory()) {
      await collectRecursiveSourceContainer(childAbs, packageName, skills, seenSourceDirs, depth + 1);
    }
  }
}

async function extractPackageSkills(pkgAbs, pkgName, seenSourceDirs, { includeRootChildren = true } = {}) {
  const pkgSkills = [];
  await collectSkillAtDir(pkgAbs, pkgName, pkgSkills, seenSourceDirs);
  if (pkgSkills.length > 0) return pkgSkills;

  for (const rel of ["skills", "skills-src"]) {
    await collectOneLevelContainer(path.join(pkgAbs, rel), pkgSkills, seenSourceDirs);
    if (pkgSkills.length > 0) return pkgSkills;
  }
  for (const rel of ["plugin-src", "families-src"]) {
    await collectRecursiveSourceContainer(path.join(pkgAbs, rel), pkgName, pkgSkills, seenSourceDirs, 0);
    if (pkgSkills.length > 0) return pkgSkills;
  }
  await collectPlaybooksContainer(path.join(pkgAbs, "playbooks"), pkgSkills, seenSourceDirs);
  if (pkgSkills.length > 0) return pkgSkills;

  for (const hiddenContainer of [".agents/skills", ".claude/skills", ".codex/skills"]) {
    const subAbs = await resolveContainedSubdir(pkgAbs, hiddenContainer);
    if (subAbs) {
      await collectOneLevelContainer(subAbs, pkgSkills, seenSourceDirs);
      if (pkgSkills.length > 0) return pkgSkills;
    }
  }
  if (includeRootChildren) {
    await collectOneLevelContainer(pkgAbs, pkgSkills, seenSourceDirs);
  }
  return pkgSkills;
}

async function readReleaseProjectUnits(rootAbs) {
  const rsDir = path.join(rootAbs, ".release-skill");
  const rsSt = await lstatNoSymlink(rsDir, ".release-skill");
  if (!rsSt?.isDirectory()) return [];
  const yamlAbs = path.join(rsDir, "project.yaml");
  const yamlSt = await lstatNoSymlink(yamlAbs, ".release-skill/project.yaml");
  if (!yamlSt?.isFile()) return [];
  let parsed;
  try {
    parsed = YAML.parse(await readFile(yamlAbs, "utf8"));
  } catch (err) {
    throw kitError(KIT_ERROR_KINDS.HOST_SIMULATOR_FAILED, `.release-skill/project.yaml 解析失败: ${err.message}`);
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.releaseUnits)) return [];
  return parsed.releaseUnits;
}

async function inspectCandidateSource(rootInput) {
  if (typeof rootInput !== "string" || rootInput.trim().length === 0) {
    throw invalidParamsError("host-sim run 需要提供非空 --root <skill-or-plugin-dir>");
  }
  const rootAbs = path.resolve(rootInput);
  let rootSt;
  try {
    rootSt = await lstat(rootAbs);
  } catch {
    throw kitError(KIT_ERROR_KINDS.HOST_SIMULATOR_FAILED, `候选目录不存在或不可读取: ${rootAbs}`);
  }
  if (!rootSt.isDirectory() || rootSt.isSymbolicLink()) {
    throw kitError(KIT_ERROR_KINDS.HOST_SIMULATOR_FAILED, `候选路径必须是真实目录: ${rootAbs}`);
  }

  const bundleId = sanitizeDirName(path.basename(rootAbs), "sim-bundle");
  const seenSourceDirs = new Set();
  let skills = [];
  let resolvedCandidateRoot = rootAbs;
  const validatedUnitDirs = [];
  const additionalPkgDirs = [];

  // 1. 直接单技能入口：<root>/SKILL.md
  await collectSkillAtDir(rootAbs, bundleId, skills, seenSourceDirs);

  // 2. .release-skill/project.yaml releaseUnits[].source（优先于工作区根辅助 skills/，且全量遍历不早停）
  const units = await readReleaseProjectUnits(rootAbs);
  for (const unit of units) {
    if (typeof unit?.source !== "string" || unit.source.trim().length === 0) continue;
    const unitAbs = await resolveContainedSubdir(rootAbs, unit.source.trim());
    if (!unitAbs) continue;
    const unitRelPrefix = path.relative(rootAbs, unitAbs).split(path.sep).join("/") || ".";
    validatedUnitDirs.push({ dirAbs: unitAbs, relPrefix: unitRelPrefix });
    if (skills.length === 0) {
      const unitName = unitAbs === rootAbs ? bundleId : path.basename(unitAbs);
      const found = await extractPackageSkills(unitAbs, unitName, seenSourceDirs);
      if (found.length > 0) {
        skills = found;
        resolvedCandidateRoot = unitAbs;
      }
    }
  }

  // 3. 工作区根级 skills/*/SKILL.md
  if (skills.length === 0) {
    await collectOneLevelContainer(path.join(rootAbs, "skills"), skills, seenSourceDirs);
  }

  // 4. 标准多包/源码容器：public-source、packages/*、plugins/*（全量检查边界与清单，禁止早停）
  const publicAbs = path.join(rootAbs, "public-source");
  const publicSt = await lstatNoSymlink(publicAbs, "public-source");
  if (publicSt?.isDirectory()) {
    additionalPkgDirs.push({ dirAbs: publicAbs, relPrefix: "public-source" });
    if (skills.length === 0) {
      const found = await extractPackageSkills(publicAbs, bundleId, seenSourceDirs);
      if (found.length > 0) {
        skills = found;
        resolvedCandidateRoot = publicAbs;
      }
    }
  }
  for (const parentRel of ["packages", "plugins"]) {
    const parentAbs = path.join(rootAbs, parentRel);
    const parentSt = await lstatNoSymlink(parentAbs, parentRel);
    if (!parentSt?.isDirectory()) continue;
    const pkgEntries = (await readdir(parentAbs, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of pkgEntries) {
      if (entry.name.startsWith(".") || EXTRA_DISCOVERY_SKIP_DIRS.has(entry.name)) continue;
      const pkgAbs = path.join(parentAbs, entry.name);
      const pkgRelPrefix = `${parentRel}/${entry.name}`;
      const pkgSt = await lstatNoSymlink(pkgAbs, pkgRelPrefix);
      if (!pkgSt?.isDirectory()) continue;
      additionalPkgDirs.push({ dirAbs: pkgAbs, relPrefix: pkgRelPrefix });
      if (skills.length === 0) {
        const found = await extractPackageSkills(pkgAbs, entry.name, seenSourceDirs);
        if (found.length > 0) {
          skills = found;
          resolvedCandidateRoot = pkgAbs;
        }
      }
    }
  }

  // 5. 根级逻辑技能容器与向后兼容直属子目录
  if (skills.length === 0) {
    await collectOneLevelContainer(path.join(rootAbs, "skills-src"), skills, seenSourceDirs);
  }
  if (skills.length === 0) {
    await collectPlaybooksContainer(path.join(rootAbs, "playbooks"), skills, seenSourceDirs);
  }
  if (skills.length === 0) {
    for (const relContainer of [".agents/skills", ".claude/skills", ".codex/skills"]) {
      const subAbs = await resolveContainedSubdir(rootAbs, relContainer);
      if (subAbs) {
        await collectOneLevelContainer(subAbs, skills, seenSourceDirs);
        if (skills.length > 0) break;
      }
    }
  }
  if (skills.length === 0) {
    await collectOneLevelContainer(rootAbs, skills, seenSourceDirs);
  }

  if (skills.length === 0) {
    throw kitError(
      KIT_ERROR_KINDS.HOST_SIMULATOR_FAILED,
      `在候选目录 "${rootAbs}" 中未找到任何包含 SKILL.md 的技能入口（支持单技能目录、skills/*、.release-skill/project.yaml、public-source/packages/*/plugins/*、skills-src、playbooks 及 .agents/.claude/.codex 技能容器）`,
    );
  }

  const baseManifestRels = [
    "plugin.json",
    ".antigravity-plugin/plugin.json",
    ".gemini-plugin/plugin.json",
    "gemini-extension.json",
    ".claude-plugin/plugin.json",
    ".codex-plugin/plugin.json",
    ".kimi-plugin/plugin.json",
    ".qoder-plugin/plugin.json",
    ".workbuddy-plugin/plugin.json",
    ".codebuddy-plugin/plugin.json",
    ".cursor-plugin/plugin.json",
    ".grok-plugin/plugin.json",
  ];
  let pluginManifest = null;
  const manifestFiles = [];
  const manifestErrors = [];
  const antigravityManifestErrors = [];
  const addedRels = new Set();
  const scannedDirAbs = new Set();

  async function scanManifestsAt(scanDirAbs, { includeInBundle = true, relPrefix = "" } = {}) {
    scannedDirAbs.add(scanDirAbs);
    const formatRel = (rel) => (relPrefix && relPrefix !== "." ? `${relPrefix}/${rel}` : rel);
    try {
      const agyDirSt = await lstat(path.join(scanDirAbs, ".antigravity-plugin"));
      if (agyDirSt.isSymbolicLink()) {
        antigravityManifestErrors.push(
          `[SFC2004] Antigravity 禁止使用非官方路径 ${formatRel(".antigravity-plugin")}（禁止符号链接）`,
        );
      }
    } catch {}
    const relSet = new Set(baseManifestRels);
    try {
      const entries = await readdir(scanDirAbs, { withFileTypes: true });
      for (const ent of entries) {
        if (/^\.[a-z0-9_-]+-plugin$/i.test(ent.name)) {
          relSet.add(`${ent.name}/plugin.json`);
        }
      }
    } catch {}
    for (const rel of relSet) {
      const displayRel = formatRel(rel);
      const abs = path.join(scanDirAbs, rel);
      let st = null;
      try {
        st = await lstat(abs);
      } catch (err) {
        if (err?.code === "ENOENT") continue;
        manifestErrors.push(`无法读取插件清单 ${displayRel}: ${err.message}`);
        continue;
      }
      if (rel === ".antigravity-plugin/plugin.json") {
        antigravityManifestErrors.push(
          `[SFC2004] Antigravity 禁止使用非官方路径清单 ${displayRel}，仅支持根目录 plugin.json`,
        );
      }
      if (st.isSymbolicLink() || !st.isFile()) {
        manifestErrors.push(`插件清单 ${displayRel} 必须是真实普通文件，禁止符号链接或目录`);
        continue;
      }
      if (includeInBundle && !addedRels.has(rel)) {
        manifestFiles.push({ rel, abs });
        addedRels.add(rel);
      }
      let rawText = "";
      try {
        rawText = await readFile(abs, "utf8");
      } catch (err) {
        manifestErrors.push(`无法读取插件清单 ${displayRel}: ${err.message}`);
        continue;
      }
      let parsed = null;
      try {
        parsed = JSON.parse(rawText);
      } catch (err) {
        manifestErrors.push(`插件清单 ${displayRel} JSON 语法损坏: ${err.message}`);
        continue;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        manifestErrors.push(`插件清单 ${displayRel} 顶层必须是合法 JSON 对象`);
        continue;
      }
      if (
        Object.prototype.hasOwnProperty.call(parsed, "__proto__")
        || Object.prototype.hasOwnProperty.call(parsed, "constructor")
        || Object.prototype.hasOwnProperty.call(parsed, "prototype")
      ) {
        manifestErrors.push(`插件清单 ${displayRel} 包含受保护的原型属性名`);
        continue;
      }
      if (typeof parsed.name !== "string" || parsed.name.trim().length === 0) {
        manifestErrors.push(`插件清单 ${displayRel} 缺少必填的非空字符串字段 name`);
        continue;
      }
      if ("version" in parsed && (typeof parsed.version !== "string" || parsed.version.trim().length === 0)) {
        manifestErrors.push(`插件清单 ${displayRel} 字段 version 必须是非空字符串`);
        continue;
      }
      if ("displayName" in parsed && (typeof parsed.displayName !== "string" || parsed.displayName.trim().length === 0)) {
        manifestErrors.push(`插件清单 ${displayRel} 字段 displayName 必须是非空字符串`);
        continue;
      }
      if ("description" in parsed && typeof parsed.description !== "string") {
        manifestErrors.push(`插件清单 ${displayRel} 字段 description 必须是字符串`);
        continue;
      }
      if ("author" in parsed) {
        const validStrAuthor = typeof parsed.author === "string" && parsed.author.trim().length > 0;
        const validObjAuthor = Boolean(parsed.author && typeof parsed.author === "object" && !Array.isArray(parsed.author)
          && typeof parsed.author.name === "string" && parsed.author.name.trim().length > 0);
        if (!validStrAuthor && !validObjAuthor) {
          manifestErrors.push(`插件清单 ${displayRel} 字段 author 必须是非空字符串或包含 name 的对象`);
          continue;
        }
      }
      if ("repository" in parsed) {
        const validStrRepo = typeof parsed.repository === "string" && parsed.repository.trim().length > 0;
        const validObjRepo = Boolean(parsed.repository && typeof parsed.repository === "object" && !Array.isArray(parsed.repository)
          && typeof parsed.repository.url === "string" && parsed.repository.url.trim().length > 0);
        if (!validStrRepo && !validObjRepo) {
          manifestErrors.push(`插件清单 ${displayRel} 字段 repository 必须是非空字符串或包含 url 的对象`);
          continue;
        }
      }
      if ("homepage" in parsed && (typeof parsed.homepage !== "string" || parsed.homepage.trim().length === 0)) {
        manifestErrors.push(`插件清单 ${displayRel} 字段 homepage 必须是非空字符串`);
        continue;
      }
      if ("disabled" in parsed && typeof parsed.disabled !== "boolean") {
        manifestErrors.push(`插件清单 ${displayRel} 字段 disabled 必须是布尔值`);
        continue;
      }
      if (
        "skills" in parsed
        && typeof parsed.skills !== "string"
        && !(Array.isArray(parsed.skills) && parsed.skills.every((s) => typeof s === "string" && s.trim().length > 0))
      ) {
        manifestErrors.push(`插件清单 ${displayRel} 字段 skills 必须是字符串或非空字符串数组`);
        continue;
      }
      if (rel === "plugin.json") {
        antigravityManifestErrors.push(...validateAntigravityRootManifest(parsed, displayRel));
      }
      if (includeInBundle && !pluginManifest) pluginManifest = parsed;
    }
  }

  await scanManifestsAt(resolvedCandidateRoot, { includeInBundle: true, relPrefix: "" });
  if (resolvedCandidateRoot !== rootAbs) {
    await scanManifestsAt(rootAbs, { includeInBundle: true, relPrefix: "" });
  }
  for (const extraTarget of [...validatedUnitDirs, ...additionalPkgDirs]) {
    if (scannedDirAbs.has(extraTarget.dirAbs)) continue;
    await scanManifestsAt(extraTarget.dirAbs, { includeInBundle: false, relPrefix: extraTarget.relPrefix });
  }

  return {
    rootAbs,
    resolvedCandidateRoot,
    bundleId,
    skills,
    pluginManifest,
    manifestFiles,
    manifestErrors,
    antigravityManifestErrors,
  };
}

function spawnShimProcess(executable, args, { cwd, env, timeoutMs = 10_000 }) {
  return new Promise((resolveRun) => {
    const childCmd = process.platform === "win32" ? process.execPath : executable;
    const childArgs = process.platform === "win32" ? [executable, ...args] : args;
    const child = spawn(childCmd, childArgs, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const outChunks = [];
    const errChunks = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (c) => outChunks.push(c));
    child.stderr.on("data", (c) => errChunks.push(c));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({
        exitCode: timedOut ? 124 : (code ?? 1),
        timedOut,
        stdout: Buffer.concat(outChunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
      });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolveRun({ exitCode: 127, timedOut: false, stdout: "", stderr: err.message });
    });
  });
}

async function installCandidateIntoHostSandbox(spec, candidate, envCtx) {
  const layout = spec.installRelDir(candidate.bundleId);
  const anchorRoot = layout.anchor === "home"
    ? envCtx.homeDir
    : layout.anchor === "wb-config"
      ? envCtx.wbConfigDir
      : envCtx.workspaceDir;
  const installTargetAbs = path.join(anchorRoot, layout.rel);
  await mkdir(installTargetAbs, { recursive: true });

  const isPluginBundleHost = spec.hostId === "claude" || spec.hostId === "antigravity";
  if (isPluginBundleHost) {
    const existingRels = new Set((candidate.manifestFiles ?? []).map((m) => m.rel));
    for (const mf of candidate.manifestFiles ?? []) {
      const dst = path.join(installTargetAbs, mf.rel);
      await mkdir(path.dirname(dst), { recursive: true });
      await writeFile(dst, await readFile(mf.abs));
    }
    if ((candidate.manifestErrors?.length ?? 0) === 0) {
      const manifestObj = {
        name: candidate.pluginManifest?.name || candidate.bundleId,
        version: candidate.pluginManifest?.version || "1.0.0",
        ...(typeof candidate.pluginManifest?.description === "string" && candidate.pluginManifest.description.trim().length > 0
          ? { description: candidate.pluginManifest.description }
          : {}),
        ...(candidate.pluginManifest?.disabled === true ? { disabled: true } : {}),
      };
      if (!existingRels.has("plugin.json")) {
        await writeFile(path.join(installTargetAbs, "plugin.json"), `${JSON.stringify(manifestObj, null, 2)}\n`, "utf8");
      }
      if (spec.pluginSubdir && !existingRels.has(`${spec.pluginSubdir}/plugin.json`)) {
        await mkdir(path.join(installTargetAbs, spec.pluginSubdir), { recursive: true });
        await writeFile(
          path.join(installTargetAbs, spec.pluginSubdir, "plugin.json"),
          `${JSON.stringify({ ...manifestObj, skills: "./skills/" }, null, 2)}\n`,
          "utf8",
        );
      }
    }
    for (const extraRel of ["rules", "hooks.json", "mcp_config.json"]) {
      const srcExtra = path.join(candidate.resolvedCandidateRoot ?? candidate.rootAbs, extraRel);
      try {
        await lstat(srcExtra);
        await cp(srcExtra, path.join(installTargetAbs, extraRel), { recursive: true });
      } catch {}
    }
    const pluginSkillsDir = path.join(installTargetAbs, "skills");
    await mkdir(pluginSkillsDir, { recursive: true });
    for (const skill of candidate.skills) {
      await cp(skill.sourceDir, path.join(pluginSkillsDir, skill.dirName), { recursive: true });
    }
    return {
      installTargetAbs,
      isPluginBundleHost: true,
      disableKey: candidate.bundleId,
      installedSkillMdPaths: candidate.skills.map((s) => path.join(pluginSkillsDir, s.dirName, "SKILL.md")),
    };
  }

  for (const skill of candidate.skills) {
    await cp(skill.sourceDir, path.join(installTargetAbs, skill.dirName), { recursive: true });
  }
  return {
    installTargetAbs,
    isPluginBundleHost: false,
    disableKey: candidate.skills[0].dirName,
    installedSkillMdPaths: candidate.skills.map((s) => path.join(installTargetAbs, s.dirName, "SKILL.md")),
  };
}

function buildHostInvocationArgv(spec, installed, envCtx, promptText, extraFlags = []) {
  switch (spec.hostId) {
    case "claude":
      return ["-p", "--verbose", "--no-session-persistence", "--output-format", "stream-json", promptText, "--plugin-dir", installed.installTargetAbs, ...extraFlags];
    case "codex":
      return ["exec", "--json", "--ephemeral", promptText, ...extraFlags];
    case "kimi-code":
      return ["-p", promptText, "--output-format", "stream-json", "--skills-dir", installed.installTargetAbs, ...extraFlags];
    case "qoder":
      return ["-p", "-o", "json", "--no-session-persistence", "--cwd", envCtx.workspaceDir, promptText, ...extraFlags];
    case "workbuddy":
    case "codebuddy":
      return ["-p", promptText, "--output-format", "stream-json", "--permission-mode", "dontAsk", "--no-session-persistence", ...extraFlags];
    case "cursor":
      return ["--print", "--output-format", "json", "--mode", "ask", "--sandbox", "enabled", "--workspace", envCtx.workspaceDir, promptText, ...extraFlags];
    case "deepseek-harness":
    case "antigravity":
    case "grok":
      return ["-p", promptText, "--output-format", "json", ...extraFlags];
    default:
      return ["-p", promptText, ...extraFlags];
  }
}

function extractObservedSkillsFromStdout(hostId, stdoutText) {
  const lines = stdoutText.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (Array.isArray(parsed.discoveredSkills)) return parsed.discoveredSkills;
      if (parsed.type === "item.completed" && typeof parsed.item?.text === "string") {
        const inner = JSON.parse(parsed.item.text);
        if (Array.isArray(inner.skills)) return inner.skills;
      }
      if (typeof parsed.result === "string") {
        const inner = JSON.parse(parsed.result);
        if (Array.isArray(inner.skills)) return inner.skills;
      }
    } catch {}
  }
  return [];
}

async function runSingleHostSimulatedLifecycle(hostId, candidate, baseTmpDir, promptText) {
  const spec = SIMULATED_HOST_SPECS[hostId];
  const envCtx = await createSimulatedHostEnvironment({ baseDir: baseTmpDir, hosts: [hostId] });
  const executable = envCtx.shims.shimsByHost[hostId].executable;
  const hostEnv = { ...envCtx.env, SF_SIM_HOST_ID: hostId };
  if (hostId !== "workbuddy") {
    delete hostEnv.WORKBUDDY_CONFIG_DIR;
    delete hostEnv.CODEBUDDY_CONFIG_DIR;
  }

  const stages = [];
  const pushRemainingSkipped = () => {
    while (stages.length < SIMULATED_LIFECYCLE_STAGES.length) {
      stages.push({
        stage: SIMULATED_LIFECYCLE_STAGES[stages.length],
        status: "not-performed",
        detail: "前置阶段未通过，跳过后续阶段",
      });
    }
  };

  try {
    const versionRun = await spawnShimProcess(executable, ["--version"], { cwd: envCtx.workspaceDir, env: hostEnv });
    const versionObserved = versionRun.stdout.trim();
    if (versionRun.exitCode !== 0 || !spec.versionPattern.test(versionObserved)) {
      stages.push({ stage: "install-v1", status: "failed", detail: `版本探针不匹配: "${versionObserved}"` });
      pushRemainingSkipped();
      return { hostId, displayName: spec.displayName, ok: false, versionObserved, stages };
    }

    const installed = await installCandidateIntoHostSandbox(spec, candidate, envCtx);
    const v1ClosureDigest = await computeDirectoryDigest(installed.installTargetAbs);
    stages.push({
      stage: "install-v1",
      status: "passed",
      versionObserved,
      installTarget: path.relative(envCtx.rootDir, installed.installTargetAbs).split(path.sep).join("/"),
      closureSha256: v1ClosureDigest,
    });

    const hostManifestErrors = [
      ...(Array.isArray(candidate.manifestErrors) ? candidate.manifestErrors : []),
      ...(hostId === "antigravity" && Array.isArray(candidate.antigravityManifestErrors)
        ? candidate.antigravityManifestErrors
        : []),
    ];
    if (hostManifestErrors.length > 0) {
      stages.push({
        stage: "discover-v1",
        status: "failed",
        detail: hostManifestErrors.join("；"),
      });
      pushRemainingSkipped();
      return { hostId, displayName: spec.displayName, ok: false, versionObserved, stages };
    }

    const discoverArgs = spec.hostId === "claude"
      ? ["discover", "--plugin-dir", installed.installTargetAbs]
      : spec.hostId === "kimi-code"
        ? ["discover", "--skills-dir", installed.installTargetAbs]
        : ["discover"];
    const discoverRun = await spawnShimProcess(executable, discoverArgs, { cwd: envCtx.workspaceDir, env: hostEnv });
    if (discoverRun.exitCode !== 0) {
      stages.push({ stage: "discover-v1", status: "failed", detail: discoverRun.stderr.trim() || "发现校验失败" });
      pushRemainingSkipped();
      return { hostId, displayName: spec.displayName, ok: false, versionObserved, stages };
    }
    const discoverJson = JSON.parse(discoverRun.stdout);
    const discoveredV1 = Array.isArray(discoverJson.discoveredSkills) ? discoverJson.discoveredSkills : [];
    if (discoveredV1.length < candidate.skills.length) {
      stages.push({ stage: "discover-v1", status: "failed", detail: `期望至少发现 ${candidate.skills.length} 个技能，实际发现 ${discoveredV1.length} 个` });
      pushRemainingSkipped();
      return { hostId, displayName: spec.displayName, ok: false, versionObserved, stages };
    }
    const primarySkillName = discoveredV1[0].name;
    const v1PrimarySha256 = discoveredV1[0].sha256;
    stages.push({
      stage: "discover-v1",
      status: "passed",
      discoveredCount: discoveredV1.length,
      primarySkillName,
      primarySkillSha256: v1PrimarySha256,
    });

    const invokeV1Args = buildHostInvocationArgv(spec, installed, envCtx, promptText, ["--skill", primarySkillName]);
    const invokeV1Run = await spawnShimProcess(executable, invokeV1Args, { cwd: envCtx.workspaceDir, env: hostEnv });
    const streamV1Ok = spec.driver
      ? evaluateDriverStreamProtocol({ driver: spec.driver, stdoutText: invokeV1Run.stdout, exitOk: invokeV1Run.exitCode === 0 })
      : invokeV1Run.exitCode === 0 && invokeV1Run.stdout.includes(SIMULATED_EXECUTION_MODE);
    const observedV1Skills = extractObservedSkillsFromStdout(hostId, invokeV1Run.stdout);
    const ctrlV1Run = await spawnShimProcess(
      executable,
      [...invokeV1Args, "--controlled-stage", "invoke-v1", "--controlled-step", "plugin-invoke"],
      { cwd: envCtx.workspaceDir, env: hostEnv },
    );
    const ctrlV1Eval = evaluateControlledNativeLifecycleFixture({
      bytes: Buffer.from(ctrlV1Run.stdout, "utf8"),
      hostId,
      stage: "invoke-v1",
      step: "plugin-invoke",
    });
    if (!streamV1Ok || ctrlV1Eval.status !== "observed" || !observedV1Skills.some((s) => s.name === primarySkillName && s.sha256 === v1PrimarySha256)) {
      stages.push({ stage: "invoke-v1", status: "failed", detail: invokeV1Run.stderr.trim() || "v1 流式协议或摘要校验未通过" });
      pushRemainingSkipped();
      return { hostId, displayName: spec.displayName, ok: false, versionObserved, stages };
    }
    stages.push({
      stage: "invoke-v1",
      status: "passed",
      streamProtocolVerified: true,
      controlledFixtureStatus: ctrlV1Eval.status,
      observedSkillSha256: v1PrimarySha256,
    });

    const disableSubcmd = hostId === "qoder" ? "plugins" : "plugin";
    await spawnShimProcess(executable, [disableSubcmd, "disable", installed.disableKey], { cwd: envCtx.workspaceDir, env: hostEnv });
    const blockedRun = await spawnShimProcess(executable, invokeV1Args, { cwd: envCtx.workspaceDir, env: hostEnv });
    const ctrlDisableRun = await spawnShimProcess(
      executable,
      [...invokeV1Args, "--controlled-stage", "disable", "--controlled-step", "plugin-invoke-negative"],
      { cwd: envCtx.workspaceDir, env: hostEnv },
    );
    const ctrlDisableEval = evaluateControlledNativeLifecycleFixture({
      bytes: Buffer.from(ctrlDisableRun.stdout, "utf8"),
      hostId,
      stage: "disable",
      step: "plugin-invoke-negative",
    });
    if (blockedRun.exitCode === 0 || ctrlDisableEval.status !== "observed") {
      stages.push({ stage: "disable", status: "failed", detail: "禁用后调用未被成功拦截" });
      pushRemainingSkipped();
      return { hostId, displayName: spec.displayName, ok: false, versionObserved, stages };
    }
    stages.push({ stage: "disable", status: "passed", negativeInvocationBlocked: true, controlledFixtureStatus: ctrlDisableEval.status });

    await spawnShimProcess(executable, [disableSubcmd, "enable", installed.disableKey], { cwd: envCtx.workspaceDir, env: hostEnv });
    const reenabledRun = await spawnShimProcess(executable, invokeV1Args, { cwd: envCtx.workspaceDir, env: hostEnv });
    if (reenabledRun.exitCode !== 0) {
      stages.push({ stage: "enable", status: "failed", detail: reenabledRun.stderr.trim() || "重新启用后调用失败" });
      pushRemainingSkipped();
      return { hostId, displayName: spec.displayName, ok: false, versionObserved, stages };
    }
    stages.push({ stage: "enable", status: "passed" });

    for (const mdPath of installed.installedSkillMdPaths) {
      await chmod(mdPath, 0o644).catch(() => {});
      const prevText = await readFile(mdPath, "utf8");
      await writeFile(mdPath, `${prevText}\n<!-- simulated-v2-upgrade -->\n`, "utf8");
    }
    if (installed.isPluginBundleHost) {
      const pjPath = path.join(installed.installTargetAbs, "plugin.json");
      await chmod(pjPath, 0o644).catch(() => {});
      const pj = JSON.parse(await readFile(pjPath, "utf8"));
      pj.version = "2.0.0";
      await writeFile(pjPath, `${JSON.stringify(pj, null, 2)}\n`, "utf8");
    }
    const v2ClosureDigest = await computeDirectoryDigest(installed.installTargetAbs);
    const v2PrimarySha256 = sha256Hex(await readFile(installed.installedSkillMdPaths[0]));
    if (v2ClosureDigest === v1ClosureDigest || v2PrimarySha256 === v1PrimarySha256) {
      stages.push({ stage: "update-v2", status: "failed", detail: "升级后 v2 摘要未发生变化" });
      pushRemainingSkipped();
      return { hostId, displayName: spec.displayName, ok: false, versionObserved, stages };
    }
    stages.push({ stage: "update-v2", status: "passed", v1ClosureSha256: v1ClosureDigest, v2ClosureSha256: v2ClosureDigest });

    const invokeV2Run = await spawnShimProcess(executable, invokeV1Args, { cwd: envCtx.workspaceDir, env: hostEnv });
    const streamV2Ok = spec.driver
      ? evaluateDriverStreamProtocol({ driver: spec.driver, stdoutText: invokeV2Run.stdout, exitOk: invokeV2Run.exitCode === 0 })
      : invokeV2Run.exitCode === 0 && invokeV2Run.stdout.includes(SIMULATED_EXECUTION_MODE);
    const observedV2Skills = extractObservedSkillsFromStdout(hostId, invokeV2Run.stdout);
    if (!streamV2Ok || !observedV2Skills.some((s) => s.name === primarySkillName && s.sha256 === v2PrimarySha256)) {
      stages.push({ stage: "invoke-v2", status: "failed", detail: "v2 调用未观测到更新后的技能摘要" });
      pushRemainingSkipped();
      return { hostId, displayName: spec.displayName, ok: false, versionObserved, stages };
    }
    stages.push({ stage: "invoke-v2", status: "passed", streamProtocolVerified: true, observedSkillSha256: v2PrimarySha256 });

    if (installed.isPluginBundleHost) {
      await rm(installed.installTargetAbs, { recursive: true, force: true });
    } else {
      for (const skill of candidate.skills) {
        await rm(path.join(installed.installTargetAbs, skill.dirName), { recursive: true, force: true });
      }
    }
    const postDiscoverRun = await spawnShimProcess(executable, discoverArgs, { cwd: envCtx.workspaceDir, env: hostEnv });
    const postDiscoverJson = postDiscoverRun.exitCode === 0 ? JSON.parse(postDiscoverRun.stdout) : { discoveredSkills: [] };
    const postInvokeRun = await spawnShimProcess(
      executable,
      [...invokeV1Args, "--require-discovered"],
      { cwd: envCtx.workspaceDir, env: hostEnv },
    );
    const remainingCount = Array.isArray(postDiscoverJson.discoveredSkills) ? postDiscoverJson.discoveredSkills.length : 0;
    if (remainingCount !== 0 || postInvokeRun.exitCode === 0) {
      stages.push({ stage: "uninstall", status: "failed", detail: `卸载后仍残留 ${remainingCount} 个技能入口` });
      return { hostId, displayName: spec.displayName, ok: false, versionObserved, stages };
    }
    stages.push({ stage: "uninstall", status: "passed", remainingSkills: 0, postUninstallInvokeBlocked: true });

    return {
      hostId,
      displayName: spec.displayName,
      ok: true,
      versionObserved,
      v1ClosureSha256: v1ClosureDigest,
      v2ClosureSha256: v2ClosureDigest,
      stages,
    };
  } finally {
    await envCtx.cleanup();
  }
}

const SENSITIVE_OUTPUT_SEGMENTS = new Set([
  ".git",
  ".ssh",
  ".gnupg",
  ".aws",
  ".kube",
  ".docker",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  "keychains",
]);

function hasSensitiveOutputSegment(targetPath) {
  const segments = String(targetPath ?? "").split(/[\\/]+/u).filter(Boolean);
  for (const seg of segments) {
    const lower = seg.toLowerCase();
    if (SENSITIVE_OUTPUT_SEGMENTS.has(lower) || lower === ".env" || lower.startsWith(".env.")) {
      return true;
    }
  }
  return false;
}

async function validateOutputTarget(output) {
  if (output === undefined || output === null) return null;
  if (typeof output !== "string" || output.trim().length === 0) {
    throw invalidParamsError("host-sim --output 需要非空文件路径");
  }
  const raw = output.trim();
  if (raw.includes("\0") || /[\\/]$/u.test(raw)) {
    throw kitError(KIT_ERROR_KINDS.HOST_SIMULATOR_FAILED, `--output 路径格式非法或指向目录: ${raw}`, { output: raw });
  }
  const outAbs = path.resolve(raw);
  const fileName = path.basename(outAbs);
  const parentAbs = path.dirname(outAbs);
  if (!fileName || fileName === "." || fileName === ".." || parentAbs === outAbs) {
    throw kitError(KIT_ERROR_KINDS.HOST_SIMULATOR_FAILED, `--output 必须是具体文件路径: ${raw}`, { output: raw });
  }
  if (hasSensitiveOutputSegment(outAbs)) {
    throw kitError(KIT_ERROR_KINDS.HOST_SIMULATOR_FAILED, `--output 安全边界拒绝写入敏感隐藏目录: ${raw}`, { output: raw });
  }

  const parsed = path.parse(outAbs);
  const segments = outAbs.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let cur = parsed.root;
  let existingAncestor = parsed.root;
  const missingParentSegments = [];

  for (let i = 0; i < segments.length; i += 1) {
    cur = path.join(cur, segments[i]);
    const isLast = i === segments.length - 1;
    let st = null;
    try {
      st = await lstat(cur);
    } catch (err) {
      if (err?.code === "ENOENT") {
        for (let j = i; j < segments.length - 1; j += 1) {
          missingParentSegments.push(segments[j]);
        }
        break;
      }
      throw kitError(KIT_ERROR_KINDS.HOST_SIMULATOR_FAILED, `无法检查 --output 路径 "${cur}": ${err.message}`, { output: raw });
    }
    const isDarwinRootLink =
      process.platform === "darwin"
      && i === 0
      && !isLast
      && (cur === "/tmp" || cur === "/var" || cur === "/etc");
    if (st.isSymbolicLink() && !isDarwinRootLink) {
      throw kitError(KIT_ERROR_KINDS.HOST_SIMULATOR_FAILED, `--output 安全边界拒绝符号链接路径: ${cur}`, { output: raw });
    }
    if (isLast) {
      if (!st.isFile() || st.nlink !== 1) {
        throw kitError(
          KIT_ERROR_KINDS.HOST_SIMULATOR_FAILED,
          `--output 目标必须是普通单链接文件，拒绝目录、硬链接或特殊文件: ${outAbs}`,
          { output: raw },
        );
      }
    } else {
      const dirStat = isDarwinRootLink ? await stat(cur) : st;
      if (!dirStat.isDirectory()) {
        throw kitError(KIT_ERROR_KINDS.HOST_SIMULATOR_FAILED, `--output 父路径组件不是目录: ${cur}`, { output: raw });
      }
      existingAncestor = cur;
    }
  }

  const realExistingAncestor = await realpath(existingAncestor);
  if (hasSensitiveOutputSegment(realExistingAncestor)) {
    throw kitError(KIT_ERROR_KINDS.HOST_SIMULATOR_FAILED, `--output 安全边界拒绝解析到敏感目录: ${realExistingAncestor}`, { output: raw });
  }
  return { outAbs, fileName, existingAncestor, realExistingAncestor, missingParentSegments };
}

async function writeValidatedOutput(targetPlan, report) {
  let currentDir = targetPlan.realExistingAncestor;
  for (const seg of targetPlan.missingParentSegments) {
    currentDir = path.join(currentDir, seg);
    await mkdir(currentDir, { recursive: true });
    const dirSt = await lstat(currentDir);
    if (dirSt.isSymbolicLink() || !dirSt.isDirectory()) {
      throw kitError(KIT_ERROR_KINDS.HOST_SIMULATOR_FAILED, `--output 父目录安全校验失败: ${currentDir}`);
    }
  }
  const realParentDir = await realpath(currentDir);
  if (realParentDir !== currentDir) {
    throw kitError(KIT_ERROR_KINDS.HOST_SIMULATOR_FAILED, `--output 父目录包含非规范符号链接: ${currentDir}`);
  }
  const targetFile = path.join(realParentDir, targetPlan.fileName);
  try {
    const existingSt = await lstat(targetFile);
    if (existingSt.isSymbolicLink() || !existingSt.isFile() || existingSt.nlink !== 1) {
      throw kitError(KIT_ERROR_KINDS.HOST_SIMULATOR_FAILED, `--output 目标文件安全校验失败: ${targetFile}`);
    }
  } catch (err) {
    if (err?.code?.startsWith?.("SFC")) throw err;
    if (err?.code !== "ENOENT") {
      throw kitError(KIT_ERROR_KINDS.HOST_SIMULATOR_FAILED, `无法核验 --output 目标文件: ${err.message}`);
    }
  }
  await publishFileOrReplace(realParentDir, targetPlan.fileName, Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8"));
}

/**
 * 在本地隔离沙箱内对任意业务域技能目录或插件目录执行十大规范宿主全生命周期模拟验证矩阵。
 */
export async function runSimulatedHostMatrix({
  root = ".",
  hosts = "all",
  output,
  prompt = "Verify simulated skill lifecycle execution",
  hostsRoot,
  baseTempDir,
} = {}) {
  const outputPlan = await validateOutputTarget(output);
  const selectedHosts = await normalizeSimulatedHosts(hosts, { hostsRoot });
  const candidate = await inspectCandidateSource(root);
  const preCallerDigest = await computeDirectoryDigest(candidate.rootAbs);

  const tmpRoot = baseTempDir ? path.resolve(baseTempDir) : await realpath(os.tmpdir());
  const matrixSandbox = await mkdtemp(path.join(tmpRoot, "sf-host-sim-matrix-"));

  let hostResults = [];
  try {
    hostResults = await Promise.all(
      selectedHosts.map((hostId) => runSingleHostSimulatedLifecycle(hostId, candidate, matrixSandbox, prompt)),
    );
  } finally {
    await rm(matrixSandbox, { recursive: true, force: true });
  }

  const postCallerDigest = await computeDirectoryDigest(candidate.rootAbs);
  const callerRootMutated = preCallerDigest !== postCallerDigest;
  const passedHosts = hostResults.filter((r) => r.ok).length;
  const failedHosts = hostResults.length - passedHosts;
  const ok = failedHosts === 0 && !callerRootMutated;

  const resolvedCandidateRel = path.relative(candidate.rootAbs, candidate.resolvedCandidateRoot || candidate.rootAbs).split(path.sep).join("/") || ".";
  const report = Object.freeze({
    schemaVersion: 1,
    kind: HOST_SIMULATOR_REPORT_KIND,
    executionMode: SIMULATED_EXECUTION_MODE,
    fixtureProtocol: CONTROLLED_NATIVE_LIFECYCLE_FIXTURE_PROTOCOL,
    honestyBoundary: HONESTY_BOUNDARY_NOTE,
    ok,
    status: ok ? "passed" : "failed",
    totalHosts: hostResults.length,
    passedHosts,
    resolvedCandidateRoot: resolvedCandidateRel,
    skillCount: candidate.skills.length,
    candidate: Object.freeze({
      bundleId: candidate.bundleId,
      resolvedCandidateRoot: resolvedCandidateRel,
      skillCount: candidate.skills.length,
      skills: candidate.skills.map((s) => s.dirName),
      callerRootMutated,
      sourceClosureSha256: preCallerDigest,
    }),
    summary: Object.freeze({
      totalHosts: hostResults.length,
      passedHosts,
      failedHosts,
      stagesPerHost: SIMULATED_LIFECYCLE_STAGES.length,
    }),
    hosts: hostResults,
  });

  if (outputPlan) {
    await writeValidatedOutput(outputPlan, report);
  }

  return report;
}

export function formatSimulatedHostReport(report) {
  const resolvedLabel = report.candidate?.resolvedCandidateRoot && report.candidate.resolvedCandidateRoot !== "."
    ? `，解析载荷根：\`${report.candidate.resolvedCandidateRoot}\``
    : "";
  const lines = [
    "# Foundation 多宿主全生命周期模拟验证报告",
    "",
    `- 执行模式：\`${report.executionMode}\`（受控本地模拟夹具，零真机 CLI / 零在线账号依赖）`,
    `- 总体结论：${report.ok ? "全部通过" : "存在未通过宿主"}（${report.summary.passedHosts}/${report.summary.totalHosts} 宿主通过）`,
    `- 候选载荷：\`${report.candidate.bundleId}\`（共 ${report.candidate.skillCount} 个技能${resolvedLabel}，源目录零改动：\`${!report.candidate.callerRootMutated}\`）`,
    `- 诚实边界：${report.honestyBoundary}`,
    "",
    "## 各宿主八阶段核验明细",
  ];
  for (const h of report.hosts) {
    const stageSummary = h.stages.map((s) => `${s.stage}:${s.status}`).join(" -> ");
    lines.push(`- **${h.displayName}** (\`${h.hostId}\`, \`${h.versionObserved || "n/a"}\`): ${h.ok ? "PASS" : "FAIL"} | ${stageSummary}`);
  }
  return `${lines.join("\n")}\n`;
}
