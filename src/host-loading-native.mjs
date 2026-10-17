import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";
import { readFileBound } from "skill-family-harness-node";

/**
 * Limited seven-host project-skill loading check.
 * Daily run is read-only: existing root binding, no spawn, network, or writes.
 * Exact native versions only; not a host adapter SPI or registry.
 */

const MAX_SKILLS_DIRS_PER_ROOT = 2000;
const MAX_SKILLS_ENTRIES_PER_ROOT = 20_000;
const CLAUDE_MAX_BYTES = 1_000_000;
const CURSOR_MAX_DEPTH = 10;
const KIMI_MAX_DEPTH = 9;
const WORKBUDDY_MAX_DEPTH = 6;
const CODEBUDDY_MAX_DEPTH = 5;
const QODER_MAX_DEPTH = 4;
const CURSOR_DESC_MAX = 1536;
const WORKBUDDY_BODY_DESC = 100;
const CURSOR_SKIP_DIR_NAMES = new Set(["node_modules", "__pycache__", "dist", "build"]);
const CURSOR_PARSE_FAILURE = "Failed to read skill file";
const DSH_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const WORKBUDDY_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const WORKBUDDY_META_FILES = [
  "_skillhub_meta.json",
  "_marketplace_meta.json",
  "_knot_meta.json",
  "_builtin_market_meta.json",
  "_user_meta.json",
];
const CURSOR_EVIDENCE = "源码核实、未作原生运行校准";

export const NATIVE_HOSTS = Object.freeze({
  claude: Object.freeze({
    hostId: "claude",
    hostVersion: "2.1.233",
    pathCategory: "claude-project-skills",
    relPath: ".claude/skills",
  }),
  cursor: Object.freeze({
    hostId: "cursor",
    hostVersion: "2026.09.10-fd3934a",
    pathCategory: "cursor-project-skills",
    relPath: ".cursor/skills",
  }),
  "kimi-code": Object.freeze({
    hostId: "kimi-code",
    hostVersion: "2.2.0",
    pathCategory: "kimi-code-project-skills",
    relPath: ".kimi-code/skills",
  }),
  workbuddy: Object.freeze({
    hostId: "workbuddy",
    hostVersion: "5.8.2",
    pathCategory: "workbuddy-project-skills",
    relPath: ".workbuddy/skills",
  }),
  codebuddy: Object.freeze({
    hostId: "codebuddy",
    hostVersion: "2.158.0",
    pathCategory: "codebuddy-project-skills",
    relPath: ".codebuddy/skills",
  }),
  qoder: Object.freeze({
    hostId: "qoder",
    hostVersion: "1.1.51",
    pathCategory: "qoder-project-skills",
    relPath: ".qoder/skills",
  }),
  "deepseek-harness": Object.freeze({
    hostId: "deepseek-harness",
    hostVersion: "0.1.1-rc.2",
    pathCategory: "deepseek-harness-project-skills",
    relPath: ".dsh/skills",
  }),
});

const RULE_SOURCES = Object.freeze({
  claude: Object.freeze([
    Object.freeze({
      id: "claude-code",
      version: "2.1.233",
      source: "claude",
      sha256: "bc466b6cde63edafc773f471a1fb98787fabb31f52240c8616ce7e1f587b212d",
    }),
  ]),
  cursor: Object.freeze([
    Object.freeze({
      id: "cursor-agent-index",
      version: "2026.09.10-fd3934a",
      source: "index.js",
      sha256: "230df5356d29c26fae77aeed83bd705b2ddd5fd5d1abccd3eb8c8b8c24e23468",
    }),
    Object.freeze({
      id: "cursor-agent-8060",
      version: "2026.09.10-fd3934a",
      source: "8060.index.js",
      sha256: "aed953660e1a5190eef2127d0124dbb39dc3913c4084d1c404aea39b9b9594ae",
    }),
  ]),
  "kimi-code": Object.freeze([
    Object.freeze({
      id: "kimi",
      version: "2.2.0",
      source: "kimi",
      sha256: "dab42ead275f8a49e9ce30a6263f614fce5926455bed103d0d16940655619bf5",
    }),
  ]),
  workbuddy: Object.freeze([
    Object.freeze({
      id: "workbuddy-app-asar",
      version: "5.8.2",
      source: "app.asar",
      sha256: "b7dee8481e5106f6cfcea1b20cf66c07a103be793333ed45b164aede41cdcce0",
    }),
    Object.freeze({
      id: "workbuddy-netdrive-env-route",
      version: "5.8.2",
      source: "main/netdrive-env-route.js",
      sha256: "e37e21bed8d05d6665a32feccf16c8db2891fbfa26ea6570395da0af78a5e0ef",
    }),
  ]),
  codebuddy: Object.freeze([
    Object.freeze({
      id: "codebuddy-headless",
      version: "2.158.0",
      source: "@tencent-ai/codebuddy-code/dist/codebuddy-headless.js",
      sha256: "9249eedc33a1e6406bff37add7fe92787cf1490eb8261b478d43e3c11b02c84f",
    }),
  ]),
  qoder: Object.freeze([
    Object.freeze({
      id: "qodercli",
      version: "1.1.51",
      source: "qodercli",
      sha256: "82fd756e711bcaeb6ae2ebbd0401a45d71ae54545f408d8867bf61f645b46e3c",
    }),
  ]),
  "deepseek-harness": Object.freeze([
    Object.freeze({
      id: "dsh-skill-filesystem",
      version: "0.1.1-rc.2",
      source: "@deepseek-ai/dsh-skill-filesystem",
      sha256: "1aea87781ba5b4d44c7cfd6184d933a1c171a3fd2791456b65ebfc8b255f1221",
    }),
    Object.freeze({
      id: "dsh-skill",
      version: "0.1.1-rc.2",
      source: "@deepseek-ai/dsh-skill",
      sha256: "5402787cbc95b4586e2c3aa4b0129e91094ad368b428aa19bcbbd8553bbfa9d7",
    }),
  ]),
});

const HOST_LIMITATIONS = Object.freeze({
  claude: Object.freeze([
    "Only Claude Code 2.1.233 and pathCategory claude-project-skills are calibrated.",
    "The check covers one explicit project root/.claude/skills; it does not claim default automatic discovery or ordinary-session paths activation.",
    "Directory and file symlinks are recorded as uncovered because this slice does not follow them.",
    "User-command visibility is a local scan projection; it does not prove model invocation.",
  ]),
  cursor: Object.freeze([
    "Only Cursor CLI 2026.09.10-fd3934a and pathCategory cursor-project-skills are calibrated.",
    "Menu, completion, and model metadata are independent surfaces.",
    "modelMetadata.* values use source-reviewed-unexecuted evidence and do not prove server filtering or model trigger.",
    "Directory and file symlinks are recorded as uncovered because this slice does not follow them.",
  ]),
  "kimi-code": Object.freeze([
    "Only Kimi Code 2.2.0 and pathCategory kimi-code-project-skills are calibrated.",
    "The check covers one project root/.kimi-code/skills workspace collection.",
    "Directory and file symlinks are recorded as uncovered because this slice does not follow them.",
    "disable_model_invocation is a file marker; it does not prove user invocability or model execution.",
  ]),
  workbuddy: Object.freeze([
    "Only WorkBuddy desktop 5.8.2 original scan component and pathCategory workbuddy-project-skills are calibrated.",
    "The check does not merge desktop, account, or session overlays, and does not cover embedded CLI 2.161.0.",
    "iconLocalPath asset resolution is uncovered.",
    "Directory and file symlinks are recorded as uncovered because this slice does not follow them.",
  ]),
  codebuddy: Object.freeze([
    "Only CodeBuddy 2.158.0 and pathCategory codebuddy-project-skills are calibrated.",
    "The check reproduces the local project provider and menu projection; it does not read skillOverrides.",
    "ACP menu suffixes are display-only and are not reported as local description.",
    "Directory and file symlinks are recorded as uncovered because this slice does not follow them.",
  ]),
  qoder: Object.freeze([
    "Only Qoder CLI 1.1.51 and pathCategory qoder-project-skills are calibrated.",
    "Same-basename candidates keep path observations and return uncovered 2; this slice does not guess a winner.",
    "Final enablement is unknown; workspace disable configuration is not read.",
    "Directory and file symlinks are recorded as uncovered because this slice does not follow them.",
  ]),
  "deepseek-harness": Object.freeze([
    "Only DeepSeek Harness 0.1.1-rc.2 filesystem and skill registry components and pathCategory deepseek-harness-project-skills are calibrated.",
    "The check does not cover full CLI ctx.fs, multi-root ranking, or runtime invocation.",
    "Native out-of-project symlink follow is not reproduced; containment is preserved as uncovered 2.",
    "Directory and file symlinks are recorded as uncovered because this slice does not follow them.",
  ]),
});

export function matchNativeHost({ hostId, hostVersion, pathCategory, relPath }) {
  const spec = NATIVE_HOSTS[hostId];
  if (!spec) return null;
  if (spec.hostVersion !== hostVersion) return null;
  if (spec.pathCategory !== pathCategory) return null;
  if (path.posix.normalize(String(relPath ?? "")) !== spec.relPath) return null;
  return spec;
}

export function nativeRuleSources(hostId) {
  return RULE_SOURCES[hostId] ? [...RULE_SOURCES[hostId]] : [];
}

export function nativeLimitations(hostId) {
  return HOST_LIMITATIONS[hostId] ? [...HOST_LIMITATIONS[hostId]] : [];
}

function uncovered(kind, message, extra = {}) {
  return { class: "host-loading", kind, message, ...extra };
}

function finding(kind, message, extra = {}) {
  return { class: "host-loading", kind, message, blocking: true, ...extra };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function posixRelative(rootAbs, absolute) {
  return path.relative(rootAbs, absolute).split(path.sep).join("/");
}

function boundReadKind(error) {
  return error?.details?.kind ?? error?.details?.boundReadDisposition ?? error?.code ?? "unknown";
}

function decodeUtf8PreserveBom(bytes) {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

function observation(field, value, sourceId, extra = {}) {
  const item = {
    field,
    value,
    basis: extra.basis ?? "native-observed",
    sourceId,
  };
  if (item.basis === "source-reviewed-unexecuted") {
    item.evidenceLabel = extra.evidenceLabel ?? CURSOR_EVIDENCE;
  }
  return item;
}

function sourceIdFor(hostId) {
  return RULE_SOURCES[hostId][0].id;
}

function nativeSkillBase(pathAbs, extra = {}) {
  return {
    path: pathAbs,
    name: extra.name ?? null,
    description: extra.description ?? null,
    shortDescription: null,
    parse: extra.parse ?? null,
    enabled: null,
    disabled: null,
    ignored: extra.ignored ?? [],
    filtered: extra.filtered ?? null,
    implicitInvocation: null,
    interface: null,
    observations: extra.observations ?? [],
    retained: extra.retained ?? null,
    supersededBy: extra.supersededBy ?? null,
    ...(extra.error !== undefined ? { error: extra.error } : {}),
  };
}

function firstLine(text) {
  const match = String(text ?? "").match(/^[^\r\n]*/);
  return match ? match[0] : "";
}

function stripHeading(line) {
  return line.startsWith("# ") ? line.slice(2) : line.startsWith("#") ? line.slice(1).trimStart() : line;
}

function bodyFirstLine(body) {
  return stripHeading(firstLine(body ?? ""));
}

function stringifyJs(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (Array.isArray(value)) return String(value);
  return null;
}

function jsonStringifyFallback(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function isAsciiText(value) {
  return typeof value === "string" && /^[\u0000-\u007F]*$/.test(value);
}

function isJsonCompatible(value, seen = new Set()) {
  if (value === null) return true;
  const type = typeof value;
  if (type === "string" || type === "boolean") return true;
  if (type === "number") return Number.isFinite(value);
  if (type !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.every((item) => isJsonCompatible(item, seen));
  if (!isPlainObject(value)) return false;
  return Object.values(value).every((item) => isJsonCompatible(item, seen));
}

function systemErrorCode(error) {
  return error?.code ?? error?.cause?.code ?? null;
}

function trimBody(text) {
  return String(text ?? "").replace(/^\uFEFF/, "").trim();
}

function cursorSkipDirName(name) {
  return name.startsWith(".") || CURSOR_SKIP_DIR_NAMES.has(name);
}

async function lstatMissingOrUncovered(absPath, ctx) {
  try {
    return { stat: await lstat(absPath) };
  } catch (cause) {
    if (systemErrorCode(cause) === "ENOENT") return { missing: true };
    ctx.uncoveredItems.push(uncovered(
      "unread-entry",
      "a skills file could not be lstat'd",
      { path: absPath, causeKind: boundReadKind(cause) },
    ));
    return { unread: true };
  }
}

function splitLines(text) {
  return String(text).split(/\r?\n/);
}

function splitFrontmatter(text, options = {}) {
  const allowBom = options.allowBom !== false;
  const firstLineExact = options.firstLineExact === true;
  if (text.length === 0) return { kind: "no-fm", body: text, dataText: null };
  let source = text;
  const hasBom = source.charCodeAt(0) === 0xfeff;
  if (hasBom) {
    if (!allowBom) return { kind: "no-fm", body: text, dataText: null, bom: true };
    source = source.slice(1);
  }
  const lines = splitLines(source);
  const opener = lines[0] ?? "";
  if (firstLineExact && opener !== "---") return { kind: "no-fm", body: text, dataText: null };
  if (opener !== "---") return { kind: "no-fm", body: text, dataText: null };
  let close = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === "---") {
      close = index;
      break;
    }
  }
  if (close < 0) return { kind: "unclosed", body: text, dataText: null, opener: true };
  return {
    kind: "fm",
    dataText: lines.slice(1, close).join("\n"),
    body: lines.slice(close + 1).join("\n"),
    bom: hasBom,
  };
}

function parseYamlMap(text, { uniqueKeys = false } = {}) {
  try {
    const document = parseDocument(text, { uniqueKeys, prettyErrors: false });
    if (document.errors.length > 0) return { ok: false, reason: "yaml-error" };
    const data = document.toJS({ maxAliasCount: 0 });
    if (data === null || data === undefined) return { ok: true, data: {} };
    if (!isPlainObject(data)) return { ok: false, reason: "not-map" };
    return { ok: true, data };
  } catch {
    return { ok: false, reason: "yaml-error" };
  }
}

function parseLineMap(text) {
  const data = {};
  for (const line of splitLines(text)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    data[match[1]] = match[2];
  }
  return data;
}

function dirDepth(skillsRootAbs, directoryAbs) {
  const relative = posixRelative(skillsRootAbs, directoryAbs);
  if (!relative || relative === "." || relative.startsWith("..")) return 0;
  return relative.split("/").filter(Boolean).length;
}

async function listDir(directoryAbs, ctx) {
  ctx.directoryCount += 1;
  if (ctx.directoryCount > MAX_SKILLS_DIRS_PER_ROOT) {
    ctx.truncated = true;
    return null;
  }
  let names;
  try {
    names = await readdir(directoryAbs);
  } catch (cause) {
    ctx.uncoveredItems.push(uncovered(
      "unread-directory",
      "a skills directory could not be read during finite discovery",
      { path: directoryAbs, causeKind: boundReadKind(cause) },
    ));
    return null;
  }
  const entries = [];
  for (const name of names) {
    ctx.entryCount += 1;
    if (ctx.entryCount > MAX_SKILLS_ENTRIES_PER_ROOT) {
      ctx.truncated = true;
      break;
    }
    const abs = path.join(directoryAbs, name);
    let st;
    try {
      st = await lstat(abs);
    } catch (cause) {
      ctx.uncoveredItems.push(uncovered(
        "unread-entry",
        "a skills entry could not be lstat'd during finite discovery",
        { path: abs, causeKind: boundReadKind(cause) },
      ));
      continue;
    }
    entries.push({ name, abs, st });
  }
  return entries;
}

async function readBoundText(rootAbs, rootBinding, absPath, ctx) {
  let st;
  try {
    st = await lstat(absPath);
  } catch (cause) {
    ctx.uncoveredItems.push(uncovered(
      "unread-entry",
      "a skills file could not be lstat'd",
      { path: absPath, causeKind: boundReadKind(cause) },
    ));
    return null;
  }
  if (st.isSymbolicLink()) {
    ctx.uncoveredItems.push(uncovered(
      "file-symlink-unfollowed",
      "a file symlink was not followed; native loading is not claimed",
      { path: absPath },
    ));
    return null;
  }
  if (!st.isFile()) {
    ctx.uncoveredItems.push(uncovered(
      "unread-entry",
      "a skills path exists but is not a regular file",
      { path: absPath },
    ));
    return null;
  }
  try {
    const receipt = await readFileBound(rootAbs, posixRelative(rootAbs, absPath), { rootBinding });
    return { text: decodeUtf8PreserveBom(receipt.content), bytes: receipt.content.length, st };
  } catch (cause) {
    if (cause instanceof TypeError && /UTF-8|encoding/i.test(String(cause.message))) {
      ctx.uncoveredItems.push(uncovered("undecodable-skill", "file is not valid UTF-8", { path: absPath }));
      return null;
    }
    try {
      const receipt = await readFileBound(rootAbs, posixRelative(rootAbs, absPath), { rootBinding });
      decodeUtf8PreserveBom(receipt.content);
    } catch (inner) {
      if (inner instanceof TypeError) {
        ctx.uncoveredItems.push(uncovered("undecodable-skill", "file is not valid UTF-8", { path: absPath }));
        return null;
      }
    }
    ctx.uncoveredItems.push(uncovered(
      "bound-read-boundary",
      "file could not be read through the existing root binding",
      { path: absPath, causeKind: boundReadKind(cause) },
    ));
    return null;
  }
}

function recordSymlink(entry, ctx, message) {
  ctx.uncoveredItems.push(uncovered(
    "directory-symlink-unfollowed",
    message ?? "a directory or file symlink was not followed; native follow is not reproduced",
    { path: entry.abs },
  ));
}

function utf16Sort(entries) {
  return [...entries].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

function localeSort(entries) {
  return [...entries].sort((left, right) => left.name.localeCompare(right.name));
}

function nameAmbiguitiesFrom(skills, predicate) {
  const groups = new Map();
  for (const skill of skills) {
    if (!predicate(skill) || skill.name == null) continue;
    const list = groups.get(skill.name) ?? [];
    list.push(skill.path);
    groups.set(skill.name, list);
  }
  return [...groups.entries()]
    .filter(([, paths]) => paths.length > 1)
    .map(([name, paths]) => ({ name, paths }));
}

function finalizeNative({
  hostId,
  skills,
  findings,
  uncoveredItems,
  nameAmbiguities,
}) {
  const retained = skills.filter((item) => item.retained === true);
  if (uncoveredItems.length === 0 && findings.length === 0 && retained.length === 0) {
    const scanned = skills.length > 0;
    findings.push(finding(
      scanned ? "no-discoverable-target" : "no-skill-entry",
      scanned
        ? "local filtering left no retained skill target"
        : "no skill entries under the calibrated project skill root",
    ));
  }
  return {
    skills,
    findings,
    uncoveredItems,
    nameAmbiguities,
    ruleSources: nativeRuleSources(hostId),
    limitations: nativeLimitations(hostId),
  };
}

async function runClaude(ctx) {
  const { skillsRootAbs, rootAbs, rootBinding } = ctx;
  const sourceId = sourceIdFor("claude");
  const skills = [];
  const findings = [];
  const entries = await listDir(skillsRootAbs, ctx);
  if (!entries) return finalizeNative({ hostId: "claude", skills, findings, uncoveredItems: ctx.uncoveredItems, nameAmbiguities: [] });
  for (const entry of entries) {
    if (ctx.truncated) break;
    if (entry.st.isSymbolicLink()) {
      recordSymlink(entry, ctx);
      continue;
    }
    if (!entry.st.isDirectory()) continue;
    if (entry.name === "synced") {
      const skillPath = path.join(entry.abs, "SKILL.md");
      const looked = await lstatMissingOrUncovered(skillPath, ctx);
      if (!looked.stat) continue;
      const skillStat = looked.stat;
      if (skillStat.isFile() || skillStat.isSymbolicLink()) {
        skills.push(nativeSkillBase(skillPath, {
          name: entry.name,
          parse: "ok",
          filtered: true,
          retained: false,
          observations: [
            observation("discovered", false, sourceId),
            observation("menuVisible", false, sourceId),
          ],
        }));
      }
      continue;
    }
    const skillPath = path.join(entry.abs, "SKILL.md");
    const looked = await lstatMissingOrUncovered(skillPath, ctx);
    if (!looked.stat) continue;
    const skillStat = looked.stat;
    if (skillStat.isSymbolicLink()) {
      ctx.uncoveredItems.push(uncovered("file-symlink-unfollowed", "SKILL.md is a symlink and is not followed", { path: skillPath }));
      continue;
    }
    if (!skillStat.isFile()) continue;
    if (skillStat.size > CLAUDE_MAX_BYTES) {
      skills.push(nativeSkillBase(skillPath, {
        name: entry.name,
        parse: "ok",
        filtered: true,
        retained: false,
        observations: [
          observation("discovered", false, sourceId),
          observation("menuVisible", false, sourceId),
        ],
      }));
      continue;
    }
    const read = await readBoundText(rootAbs, rootBinding, skillPath, ctx);
    if (!read) continue;
    const split = splitFrontmatter(read.text);
    let name = entry.name;
    let description = bodyFirstLine(split.kind === "fm" ? split.body : read.text);
    let userInvocable = null;
    if (split.kind === "unclosed" || split.kind === "no-fm") {
      name = entry.name;
      description = split.kind === "unclosed" ? "---" : bodyFirstLine(read.text);
    } else {
      const parsed = parseYamlMap(split.dataText, { uniqueKeys: false });
      const data = parsed.ok ? parsed.data : parseLineMap(split.dataText);
      if (Object.hasOwn(data, "name") && data.name !== undefined && data.name !== null && data.name !== "") {
        const asString = stringifyJs(data.name);
        if (asString !== null) name = asString;
      }
      if (typeof data.description === "string") {
        description = data.description;
      } else if (Object.hasOwn(data, "description")) {
        const asString = stringifyJs(data.description);
        description = typeof data.description === "boolean" || typeof data.description === "number"
          ? asString
          : bodyFirstLine(split.body);
      } else {
        description = bodyFirstLine(split.body);
      }
      if (data["user-invocable"] === false) userInvocable = false;
    }
    const menuVisible = userInvocable !== false;
    skills.push(nativeSkillBase(skillPath, {
      name,
      description,
      parse: "ok",
      filtered: menuVisible ? false : true,
      retained: menuVisible,
      observations: [
        observation("discovered", true, sourceId),
        observation("menuVisible", menuVisible, sourceId),
      ],
    }));
  }
  return finalizeNative({
    hostId: "claude",
    skills,
    findings,
    uncoveredItems: ctx.uncoveredItems,
    nameAmbiguities: nameAmbiguitiesFrom(skills, (item) => item.retained === true),
  });
}

function cursorParseFrontmatter(text) {
  const split = splitFrontmatter(text);
  if (split.kind !== "fm") return { kind: split.kind, data: null, body: split.kind === "fm" ? split.body : text };
  const parsed = parseYamlMap(split.dataText, { uniqueKeys: false });
  if (!parsed.ok) return { kind: "broken", data: null, body: split.body };
  return { kind: "fm", data: parsed.data, body: split.body };
}

function cursorCompletionDescription(data, body) {
  if (data && typeof data.description === "string") return data.description;
  return bodyFirstLine(body);
}

function splitSurfaceString(raw) {
  return raw.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
}

function cursorModelSurfaces(data) {
  const metadata = data?.metadata;
  if (!isPlainObject(metadata) || !Object.hasOwn(metadata, "surfaces")) {
    return { ok: true, present: false, value: [] };
  }
  const raw = metadata.surfaces;
  if (typeof raw === "string") {
    return { ok: true, present: true, value: splitSurfaceString(raw) };
  }
  if (Array.isArray(raw)) {
    if (!isJsonCompatible(raw)) return { ok: false, present: true, value: null };
    return { ok: true, present: true, value: raw, isArray: true };
  }
  return { ok: true, present: true, value: [] };
}

function cursorCompletionSurfacesAllowed(data) {
  const raw = data?.metadata?.surfaces;
  if (Array.isArray(raw)) {
    const strings = raw.filter((item) => typeof item === "string");
    if (strings.length > 0 && !strings.includes("cli")) return false;
    return true;
  }
  if (typeof raw === "string") {
    const strings = splitSurfaceString(raw);
    if (strings.length > 0 && !strings.includes("cli")) return false;
  }
  return true;
}

function cursorCompletionUserInvocable(data) {
  if (data?.["user-invocable"] === false) return { allowed: false };
  if (typeof data?.["user-invocable"] === "string" && data["user-invocable"].trim().toLowerCase() === "false") {
    return { unknown: true };
  }
  return { allowed: true };
}

async function runCursor(ctx) {
  const { skillsRootAbs, rootAbs, rootBinding } = ctx;
  const nativeSource = sourceIdFor("cursor");
  const modelSource = "cursor-agent-index";
  const skills = [];
  const findings = [];
  const candidates = [];

  async function walk(directoryAbs, depth, skipModelCompletion) {
    if (ctx.truncated) return;
    const entries = await listDir(directoryAbs, ctx);
    if (!entries) return;
    const skillFile = entries.find((item) => item.name === "SKILL.md" && (item.st.isFile() || item.st.isSymbolicLink()));
    if (skillFile) {
      candidates.push({
        skillPath: skillFile.abs,
        dirAbs: directoryAbs,
        depth,
        skipModelCompletion: skipModelCompletion === true || (depth > 0 && cursorSkipDirName(path.basename(directoryAbs))),
        directChild: depth === 1,
        containerRoot: depth === 0,
        symlink: skillFile.st.isSymbolicLink(),
      });
    }
    for (const entry of entries) {
      if (ctx.truncated) break;
      if (entry.st.isSymbolicLink()) {
        recordSymlink(entry, ctx);
        continue;
      }
      if (!entry.st.isDirectory()) continue;
      const nextDepth = depth + 1;
      if (nextDepth > CURSOR_MAX_DEPTH) continue;
      const childSkip = skipModelCompletion || cursorSkipDirName(entry.name);
      if (childSkip && nextDepth > 1) continue;
      await walk(entry.abs, nextDepth, childSkip);
    }
  }

  await walk(skillsRootAbs, 0, false);

  const completionNames = [];
  for (const candidate of candidates) {
    if (candidate.symlink) {
      ctx.uncoveredItems.push(uncovered("file-symlink-unfollowed", "SKILL.md is a symlink and is not followed", { path: candidate.skillPath }));
      continue;
    }
    const read = await readBoundText(rootAbs, rootBinding, candidate.skillPath, ctx);
    if (!read) continue;
    const parsed = cursorParseFrontmatter(read.text);
    const basename = candidate.containerRoot ? "skills" : path.basename(candidate.dirAbs);
    const menuVisible = candidate.directChild === true;
    const broken = parsed.kind === "broken" || parsed.kind === "unclosed";
    const data = parsed.data;

    let completionVisible = false;
    let completionUnknown = false;
    if (!candidate.skipModelCompletion && !broken) {
      const invocability = cursorCompletionUserInvocable(data);
      if (invocability.unknown) {
        completionUnknown = true;
        ctx.uncoveredItems.push(uncovered(
          "cursor-completion-unproven-user-invocable",
          "Cursor completion string user-invocable false is outside the calibrated native boolean sample",
          { path: candidate.skillPath },
        ));
      } else if (invocability.allowed !== false && cursorCompletionSurfacesAllowed(data)) {
        completionVisible = true;
      }
    }

    const completionOk = completionVisible === true;
    const completionDescription = completionOk
      ? (parsed.kind === "fm" ? cursorCompletionDescription(data, parsed.body) : bodyFirstLine(parsed.body ?? read.text))
      : null;
    const completionTitle = completionOk ? (typeof data?.name === "string" && data.name !== "" ? data.name : basename) : null;

    const modelObs = [];
    const pushModel = (field, value) => {
      modelObs.push(observation(field, value, modelSource, { basis: "source-reviewed-unexecuted", evidenceLabel: CURSOR_EVIDENCE }));
    };

    let parse = null;
    let filtered = null;
    let retained = null;
    let error;
    let modelDescription = null;

    if (candidate.skipModelCompletion) {
      parse = null;
      filtered = true;
      retained = false;
      pushModel("modelMetadata.surfaces", null);
      pushModel("modelMetadata.kind", null);
      pushModel("modelMetadata.description", null);
      pushModel("modelMetadata.parseError", null);
      pushModel("modelMetadata.disableModelInvocation", null);
    } else if (broken) {
      parse = "error";
      filtered = false;
      retained = true;
      error = CURSOR_PARSE_FAILURE;
      findings.push(finding("skill-parse-error", CURSOR_PARSE_FAILURE, { path: candidate.skillPath }));
      pushModel("modelMetadata.surfaces", null);
      pushModel("modelMetadata.kind", "AgentSkill");
      pushModel("modelMetadata.description", null);
      pushModel("modelMetadata.parseError", CURSOR_PARSE_FAILURE);
      pushModel("modelMetadata.disableModelInvocation", null);
    } else if (parsed.kind === "fm" && data) {
      const surfacesInfo = cursorModelSurfaces(data);
      if (!surfacesInfo.ok) {
        ctx.uncoveredItems.push(uncovered(
          "unproven-yaml-shape",
          "Cursor metadata.surfaces is not JSON-compatible",
          { path: candidate.skillPath },
        ));
        parse = null;
        filtered = null;
        retained = null;
        pushModel("modelMetadata.surfaces", null);
        pushModel("modelMetadata.kind", null);
        pushModel("modelMetadata.description", null);
        pushModel("modelMetadata.parseError", null);
        pushModel("modelMetadata.disableModelInvocation", null);
      } else {
        const surfaces = surfacesInfo.value;
        const hasCli = Array.isArray(surfaces) && surfaces.includes("cli");
        const nonemptyWithoutCli = surfaces.length > 0 && !hasCli;
        if (nonemptyWithoutCli) {
          parse = null;
          filtered = true;
          retained = false;
          pushModel("modelMetadata.surfaces", surfaces);
          pushModel("modelMetadata.kind", null);
          pushModel("modelMetadata.description", null);
          pushModel("modelMetadata.parseError", null);
          pushModel("modelMetadata.disableModelInvocation", null);
        } else if (data.alwaysApply === true) {
          parse = "ok";
          filtered = true;
          retained = false;
          pushModel("modelMetadata.surfaces", surfaces);
          pushModel("modelMetadata.kind", "globalCursorRule");
          pushModel("modelMetadata.description", null);
          pushModel("modelMetadata.parseError", null);
          pushModel("modelMetadata.disableModelInvocation", null);
        } else {
          const desc = data.description;
          const valid = typeof desc === "string" && desc.length > 0;
          const sliced = valid ? desc.slice(0, CURSOR_DESC_MAX) : null;
          modelDescription = sliced;
          parse = valid ? "ok" : "error";
          filtered = false;
          retained = true;
          if (!valid) {
            error = "Description is required";
            findings.push(finding("skill-parse-error", "Description is required", { path: candidate.skillPath }));
          }
          pushModel("modelMetadata.surfaces", surfaces);
          pushModel("modelMetadata.kind", "AgentSkill");
          pushModel("modelMetadata.description", sliced);
          pushModel("modelMetadata.parseError", valid ? null : "Description is required");
          pushModel("modelMetadata.disableModelInvocation", data["disable-model-invocation"] === true);
        }
      }
    } else {
      parse = "error";
      filtered = false;
      retained = true;
      error = "Description is required";
      findings.push(finding("skill-parse-error", "Description is required", { path: candidate.skillPath }));
      pushModel("modelMetadata.surfaces", []);
      pushModel("modelMetadata.kind", "AgentSkill");
      pushModel("modelMetadata.description", null);
      pushModel("modelMetadata.parseError", "Description is required");
      pushModel("modelMetadata.disableModelInvocation", false);
    }

    if (completionOk) completionNames.push({ basename, path: candidate.skillPath });

    const observations = [
      observation("discovered", menuVisible || completionOk || retained === true, nativeSource),
      observation("menuVisible", menuVisible, nativeSource),
      observation("completion.visible", completionUnknown ? null : completionOk, nativeSource),
      observation("completion.id", completionOk ? basename : null, nativeSource),
      observation("completion.title", completionOk ? completionTitle : null, nativeSource),
      observation("completion.description", completionOk ? completionDescription : null, nativeSource),
      ...modelObs,
    ];

    skills.push(nativeSkillBase(candidate.skillPath, {
      name: basename,
      description: modelDescription,
      parse,
      filtered,
      retained,
      error,
      observations,
    }));
  }

  const completionCounts = new Map();
  for (const item of completionNames) {
    completionCounts.set(item.basename, (completionCounts.get(item.basename) ?? 0) + 1);
  }
  const collisions = [...completionCounts.entries()].filter(([, count]) => count > 1).map(([name]) => name);
  if (collisions.length > 0) {
    for (const skill of skills) {
      const idObs = skill.observations.find((item) => item.field === "completion.id");
      const visible = skill.observations.find((item) => item.field === "completion.visible")?.value === true;
      if (visible && collisions.includes(skill.name)) {
        idObs.value = null;
        ctx.uncoveredItems.push(uncovered(
          "cursor-completion-identity-collision",
          "completion command identity collides on directory basename; this slice does not guess a suffix",
          { path: skill.path, name: skill.name },
        ));
      }
    }
  }

  return finalizeNative({
    hostId: "cursor",
    skills,
    findings,
    uncoveredItems: ctx.uncoveredItems,
    nameAmbiguities: nameAmbiguitiesFrom(skills, (item) => item.retained === true),
  });
}

function kimiDirectoryAccepted(data) {
  if (!isPlainObject(data)) return false;
  const name = typeof data.name === "string" ? data.name.trim() : "";
  const description = typeof data.description === "string" ? data.description : "";
  if (name.length === 0 || description.length === 0) return false;
  if (Object.hasOwn(data, "type") && data.type !== "inline") return false;
  return true;
}

function kimiHasSubSkill(data) {
  return data?.["has-sub-skill"] === true || data?.hasSubSkill === true;
}

function kimiNestedSubSkillMarker(data) {
  if (!isPlainObject(data?.metadata)) return false;
  return Object.hasOwn(data.metadata, "has-sub-skill") || Object.hasOwn(data.metadata, "hasSubSkill");
}

async function kimiDirectoryHasChildSkill(directoryAbs, ctx) {
  const entries = await listDir(directoryAbs, ctx);
  if (!entries) return false;
  for (const entry of entries) {
    if (entry.st.isSymbolicLink() || !entry.st.isDirectory()) continue;
    const childSkill = path.join(entry.abs, "SKILL.md");
    try {
      const stat = await lstat(childSkill);
      if (stat.isFile() || stat.isSymbolicLink()) return true;
    } catch (cause) {
      if (systemErrorCode(cause) !== "ENOENT") return true;
    }
  }
  return false;
}

async function runKimi(ctx) {
  const { skillsRootAbs, rootAbs, rootBinding } = ctx;
  const sourceId = sourceIdFor("kimi-code");
  const skills = [];
  const findings = [];
  const seenKeys = new Map();

  async function processSkillFile({ skillPath, fallbackName, isFlat, parentName, depth, kind }) {
    const read = await readBoundText(rootAbs, rootBinding, skillPath, ctx);
    if (!read) return { discovered: false };
    const split = splitFrontmatter(read.text);
    if (split.kind !== "fm") {
      if (isFlat) {
        const name = fallbackName;
        const description = trimBody(split.body ?? read.text);
        return registerKimi({
          skillPath,
          name,
          description,
          data: {},
          discovered: true,
          depth,
          kind,
        });
      }
      skills.push(nativeSkillBase(skillPath, {
        name: fallbackName,
        parse: "ok",
        filtered: true,
        retained: false,
        observations: [
          observation("discovered", false, sourceId),
          observation("disableModelInvocation", null, sourceId),
        ],
      }));
      return { discovered: false };
    }
    const parsed = parseYamlMap(split.dataText, { uniqueKeys: false });
    if (!parsed.ok) {
      skills.push(nativeSkillBase(skillPath, {
        name: fallbackName,
        parse: "ok",
        filtered: true,
        retained: false,
        observations: [
          observation("discovered", false, sourceId),
          observation("disableModelInvocation", null, sourceId),
        ],
      }));
      return { discovered: false };
    }
    const data = parsed.data;
    if (isFlat) {
      const rawName = typeof data.name === "string" && data.name.trim() !== "" ? data.name.trim() : fallbackName;
      const description = typeof data.description === "string" && data.description !== ""
        ? data.description
        : trimBody(split.body);
      return registerKimi({ skillPath, name: rawName, description, data, discovered: true, depth, kind });
    }
    if (!kimiDirectoryAccepted(data)) {
      skills.push(nativeSkillBase(skillPath, {
        name: fallbackName,
        parse: "ok",
        filtered: true,
        retained: false,
        observations: [
          observation("discovered", false, sourceId),
          observation("disableModelInvocation", null, sourceId),
        ],
      }));
      return { discovered: false, data };
    }
    const childName = data.name.trim();
    const name = parentName ? `${parentName}.${childName}` : childName;
    return registerKimi({
      skillPath,
      name,
      description: data.description,
      data,
      discovered: true,
      depth,
      kind,
    });
  }

  function registerKimi({ skillPath, name, description, data, discovered, depth, kind }) {
    const key = name.toLowerCase();
    const disable = data?.["disable-model-invocation"] === true;
    const previous = seenKeys.get(key);
    if (previous) {
      const calibratedFirstWins = !previous.ambiguous
        && previous.kind === "dir"
        && kind === "dir"
        && previous.depth === depth
        && isAsciiText(name)
        && isAsciiText(previous.name);
      if (!calibratedFirstWins) {
        previous.ambiguous = true;
        for (const candidate of skills) {
          if (candidate.name?.toLowerCase() !== key || !candidate.observations.some((item) => item.field === "discovered" && item.value === true)) continue;
          candidate.retained = null;
          candidate.supersededBy = null;
          candidate.filtered = false;
        }
        ctx.uncoveredItems.push(uncovered(
          "kimi-name-collision-uncovered",
          "Kimi final-name competition is outside the calibrated same-layer ASCII first-wins sample",
          { path: skillPath, name },
        ));
        skills.push(nativeSkillBase(skillPath, {
          name,
          description,
          parse: "ok",
          filtered: false,
          retained: null,
          supersededBy: null,
          observations: [
            observation("discovered", discovered, sourceId),
            observation("disableModelInvocation", disable, sourceId),
          ],
        }));
        return { discovered, data, retained: null };
      }
      skills.push(nativeSkillBase(skillPath, {
        name,
        description,
        parse: "ok",
        filtered: true,
        retained: false,
        supersededBy: previous.skill.path,
        observations: [
          observation("discovered", discovered, sourceId),
          observation("disableModelInvocation", disable, sourceId),
        ],
      }));
      return { discovered, data, retained: false };
    }
    const skill = nativeSkillBase(skillPath, {
      name,
      description,
      parse: "ok",
      filtered: false,
      retained: true,
      observations: [
        observation("discovered", true, sourceId),
        observation("disableModelInvocation", disable, sourceId),
      ],
    });
    seenKeys.set(key, { name, skill, depth, kind });
    skills.push(skill);
    return { discovered: true, data, retained: true, name };
  }

  async function walk(directoryAbs, depth, parentName) {
    if (ctx.truncated) return;
    const entries = await listDir(directoryAbs, ctx);
    if (!entries) return;
    const sorted = utf16Sort(entries);
    const dirs = sorted.filter((item) => item.st.isDirectory() || item.st.isSymbolicLink());
    const files = sorted.filter((item) => item.st.isFile() || (item.st.isSymbolicLink() && !item.st.isDirectory()));
    const skillDirs = [];
    for (const entry of dirs) {
      if (entry.st.isSymbolicLink()) {
        recordSymlink(entry, ctx);
        continue;
      }
      const skillPath = path.join(entry.abs, "SKILL.md");
      let skillStat;
      try {
        skillStat = await lstat(skillPath);
      } catch {
        skillStat = null;
      }
      if (skillStat?.isSymbolicLink()) {
        ctx.uncoveredItems.push(uncovered("file-symlink-unfollowed", "SKILL.md is a symlink and is not followed", { path: skillPath }));
        continue;
      }
      if (skillStat?.isFile()) skillDirs.push(entry);
    }

    const produced = [];
    for (const entry of skillDirs) {
      const nextDepth = depth + 1;
      if (nextDepth > KIMI_MAX_DEPTH) continue;
      const skillPath = path.join(entry.abs, "SKILL.md");
      const result = await processSkillFile({
        skillPath,
        fallbackName: entry.name,
        isFlat: false,
        parentName,
        depth: nextDepth,
        kind: "dir",
      });
      produced.push({ entry, result, nextDepth });
    }

    if (depth === 0) {
      const skillDirNames = new Set(skillDirs.map((item) => item.name));
      for (const entry of files) {
        if (entry.st.isSymbolicLink()) {
          ctx.uncoveredItems.push(uncovered("file-symlink-unfollowed", "a file symlink was not followed", { path: entry.abs }));
          continue;
        }
        if (!entry.name.endsWith(".md") || entry.name === "SKILL.md") continue;
        const base = entry.name.slice(0, -3);
        if (skillDirNames.has(base)) continue;
        await processSkillFile({
          skillPath: entry.abs,
          fallbackName: base,
          isFlat: true,
          parentName: null,
          depth: 0,
          kind: "flat",
        });
      }
    }

    for (const { entry, result, nextDepth } of produced) {
      const hidden = entry.name.startsWith(".") || entry.name === "node_modules";
      if (hidden) continue;
      if (!result.discovered) {
        const nested = await kimiDirectoryHasChildSkill(entry.abs, ctx);
        if (nested) {
          ctx.uncoveredItems.push(uncovered(
            "kimi-invalid-parent-child-uncovered",
            "child skills under a failed Kimi parent directory skill are outside the calibrated set",
            { path: path.join(entry.abs, "SKILL.md") },
          ));
        }
        continue;
      }
      if (kimiNestedSubSkillMarker(result.data)) {
        ctx.uncoveredItems.push(uncovered(
          "kimi-nested-subskill-marker-uncovered",
          "nested metadata has-sub-skill markers are outside the calibrated top-level flag set",
          { path: path.join(entry.abs, "SKILL.md") },
        ));
        continue;
      }
      if (kimiHasSubSkill(result.data)) await walk(entry.abs, nextDepth, result.name);
    }

    for (const entry of dirs) {
      if (entry.st.isSymbolicLink() || !entry.st.isDirectory()) continue;
      if (skillDirs.some((item) => item.abs === entry.abs)) continue;
      const hidden = entry.name.startsWith(".") || entry.name === "node_modules";
      if (hidden) continue;
      const nextDepth = depth + 1;
      if (nextDepth > KIMI_MAX_DEPTH) continue;
      await walk(entry.abs, nextDepth, parentName);
    }
  }

  await walk(skillsRootAbs, 0, null);
  return finalizeNative({
    hostId: "kimi-code",
    skills,
    findings,
    uncoveredItems: ctx.uncoveredItems,
    nameAmbiguities: nameAmbiguitiesFrom(skills, (item) => item.retained === true || item.retained === false),
  });
}

function workbuddyCoerceDisable(value) {
  return value === true;
}

async function readOptionalBound(rootAbs, rootBinding, absPath, ctx) {
  let st;
  try {
    st = await lstat(absPath);
  } catch {
    return { exists: false };
  }
  if (st.isSymbolicLink()) {
    ctx.uncoveredItems.push(uncovered("file-symlink-unfollowed", "optional metadata is a symlink and is not followed", { path: absPath }));
    return { exists: true, unreadable: true };
  }
  if (!st.isFile()) return { exists: false };
  const read = await readBoundText(rootAbs, rootBinding, absPath, ctx);
  if (!read) return { exists: true, unreadable: true };
  return { exists: true, text: read.text };
}

function workbuddyBodyDescription(text, dirName) {
  const sliced = trimBody(text).slice(0, WORKBUDDY_BODY_DESC);
  return sliced || dirName;
}

function workbuddyParseSkill(text, dirName) {
  if (text.charCodeAt(0) === 0xfeff) {
    return { name: dirName, description: workbuddyBodyDescription(text, dirName), data: {}, bom: true };
  }
  if (text.length === 0) {
    return { name: dirName, description: dirName, data: {}, empty: true };
  }
  const split = splitFrontmatter(text);
  if (split.kind !== "fm") {
    return { name: dirName, description: workbuddyBodyDescription(text, dirName), data: {} };
  }
  const parsed = parseYamlMap(split.dataText, { uniqueKeys: false });
  if (!parsed.ok) {
    return { name: dirName, description: dirName, data: {}, fallback: true };
  }
  const data = parsed.data;
  if (isPlainObject(data["allowed-tools"])) {
    return { name: dirName, description: dirName, data: {}, fallback: true };
  }
  let name;
  if (!Object.hasOwn(data, "name") || data.name === undefined || data.name === null || data.name === "") {
    name = dirName;
  } else if (Array.isArray(data.name) || isPlainObject(data.name)) {
    name = jsonStringifyFallback(data.name);
  } else {
    name = stringifyJs(data.name) ?? dirName;
  }
  let description;
  if (!Object.hasOwn(data, "description") || data.description === undefined || data.description === null || data.description === "") {
    description = workbuddyBodyDescription(split.body ?? "", dirName);
  } else if (Array.isArray(data.description) || isPlainObject(data.description)) {
    description = jsonStringifyFallback(data.description);
  } else {
    description = stringifyJs(data.description);
  }
  return { name, description, data };
}

async function runWorkbuddy(ctx) {
  const { skillsRootAbs, rootAbs, rootBinding } = ctx;
  const sourceId = sourceIdFor("workbuddy");
  const skills = [];
  const findings = [];

  async function walk(directoryAbs, depth, parentHasSkill) {
    if (ctx.truncated) return;
    if (depth > WORKBUDDY_MAX_DEPTH) return;
    const entries = await listDir(directoryAbs, ctx);
    if (!entries) return;
    const skillEntry = entries.find((item) => item.name === "SKILL.md");
    const hasSkill = Boolean(skillEntry && (skillEntry.st.isFile() || skillEntry.st.isSymbolicLink()));
    if (hasSkill && depth > 0) {
      if (skillEntry.st.isSymbolicLink()) {
        ctx.uncoveredItems.push(uncovered("file-symlink-unfollowed", "SKILL.md is a symlink and is not followed", { path: skillEntry.abs }));
      } else {
        const dirName = path.basename(directoryAbs);
        const read = await readBoundText(rootAbs, rootBinding, skillEntry.abs, ctx);
        if (read) {
          const parsed = workbuddyParseSkill(read.text, dirName);
          let selectedMeta = null;
          let metaStopped = false;
          for (const fileName of WORKBUDDY_META_FILES) {
            const metaPath = path.join(directoryAbs, fileName);
            const meta = await readOptionalBound(rootAbs, rootBinding, metaPath, ctx);
            if (!meta.exists) continue;
            if (meta.unreadable) {
              metaStopped = true;
              break;
            }
            try {
              const json = JSON.parse(meta.text);
              if (!isPlainObject(json)) {
                metaStopped = true;
                selectedMeta = null;
                break;
              }
              selectedMeta = { fileName, json };
            } catch {
              metaStopped = true;
              selectedMeta = null;
            }
            break;
          }
          let name = parsed.name;
          let retained = true;
          if (!metaStopped && selectedMeta?.fileName === "_user_meta.json") {
            if (Object.hasOwn(selectedMeta.json, "name")) {
              if (typeof selectedMeta.json.name === "string" && selectedMeta.json.name !== "") {
                name = selectedMeta.json.name;
              } else {
                ctx.uncoveredItems.push(uncovered(
                  "workbuddy-uncalibrated-name-type",
                  "install metadata name type is outside the calibrated _user_meta.json non-empty string sample",
                  { path: skillEntry.abs, source: selectedMeta.fileName },
                ));
                name = null;
                retained = null;
              }
            }
          } else if (!metaStopped && selectedMeta) {
            ctx.uncoveredItems.push(uncovered(
              "workbuddy-uncalibrated-name-source",
              "install metadata source is outside the calibrated _user_meta.json string sample",
              { path: skillEntry.abs, source: selectedMeta.fileName },
            ));
            name = null;
            retained = null;
          }

          let version = null;
          const skillJsonPath = path.join(directoryAbs, "skill.json");
          const skillJson = await readOptionalBound(rootAbs, rootBinding, skillJsonPath, ctx);
          let versionChosen = false;
          if (skillJson.exists && skillJson.text) {
            try {
              const json = JSON.parse(skillJson.text);
              if (isPlainObject(json) && Object.hasOwn(json, "version")) {
                versionChosen = true;
                if (typeof json.version === "string" && WORKBUDDY_VERSION.test(json.version)) {
                  version = json.version;
                } else {
                  ctx.uncoveredItems.push(uncovered(
                    "workbuddy-uncalibrated-version-source",
                    "skill.json version is outside the calibrated x.y.z string set",
                    { path: skillJsonPath },
                  ));
                  version = null;
                }
              }
            } catch {
              ctx.uncoveredItems.push(uncovered(
                "workbuddy-uncalibrated-version-source",
                "skill.json could not be parsed for version selection",
                { path: skillJsonPath },
              ));
            }
          }
          if (!versionChosen) {
            for (const fileName of ["manifest.yaml", "manifest.yml"]) {
              const manifest = await readOptionalBound(rootAbs, rootBinding, path.join(directoryAbs, fileName), ctx);
              if (!manifest.exists) continue;
              ctx.uncoveredItems.push(uncovered(
                "workbuddy-uncalibrated-version-source",
                `${fileName} version source is not in the calibrated native set`,
                { path: path.join(directoryAbs, fileName) },
              ));
              versionChosen = true;
              break;
            }
          }
          if (!versionChosen && parsed.data && Object.hasOwn(parsed.data, "version")) {
            ctx.uncoveredItems.push(uncovered(
              "workbuddy-uncalibrated-version-source",
              "SKILL.md frontmatter version is not in the calibrated native set",
              { path: skillEntry.abs },
            ));
            versionChosen = true;
          }
          if (!versionChosen && selectedMeta && Object.hasOwn(selectedMeta.json, "version")) {
            ctx.uncoveredItems.push(uncovered(
              "workbuddy-uncalibrated-version-source",
              "install metadata version is not in the calibrated native set",
              { path: path.join(directoryAbs, selectedMeta.fileName) },
            ));
          }

          const iconFields = [parsed.data?.icon, parsed.data?.iconLocalPath, selectedMeta?.json?.icon, selectedMeta?.json?.iconLocalPath];
          if (iconFields.some((item) => typeof item === "string" && item !== "")) {
            ctx.uncoveredItems.push(uncovered(
              "workbuddy-icon-uncovered",
              "iconLocalPath asset resolution is not calibrated",
              { path: skillEntry.abs },
            ));
          }

          const disable = workbuddyCoerceDisable(parsed.data?.disable);
          const disableModel = parsed.data?.["disable-model-invocation"] === true;
          const userInvocable = parsed.data?.["user-invocable"] === false ? false : null;
          const nested = parentHasSkill && path.basename(directoryAbs) !== path.basename(skillsRootAbs);
          void nested;
          skills.push(nativeSkillBase(skillEntry.abs, {
            name,
            description: parsed.description,
            parse: "ok",
            filtered: false,
            retained,
            observations: [
              observation("discovered", true, sourceId),
              observation("userInvocable", userInvocable, sourceId),
              observation("disableModelInvocation", disableModel, sourceId),
              observation("disabled", disable, sourceId),
              observation("version", version, sourceId),
            ],
          }));
        }
      }
    }

    for (const entry of entries) {
      if (ctx.truncated) break;
      if (entry.st.isSymbolicLink()) {
        recordSymlink(entry, ctx);
        continue;
      }
      if (!entry.st.isDirectory()) continue;
      if (hasSkill && depth > 0 && entry.name !== "skills") continue;
      await walk(entry.abs, depth + 1, depth > 0 && hasSkill);
    }
  }

  await walk(skillsRootAbs, 0, false);
  return finalizeNative({
    hostId: "workbuddy",
    skills,
    findings,
    uncoveredItems: ctx.uncoveredItems,
    nameAmbiguities: nameAmbiguitiesFrom(skills, (item) => item.retained === true),
  });
}

function isBlockScalarIndicator(value) {
  return typeof value === "string" && /^[|>](?:[+-])?(?:\d+)?$/.test(value.trim());
}

function unquoteLineValue(raw) {
  if (typeof raw !== "string" || raw.length < 2) return raw;
  const start = raw[0];
  const end = raw[raw.length - 1];
  if ((start === "\"" && end === "\"") || (start === "'" && end === "'")) return raw.slice(1, -1);
  return raw;
}

function coerceLineValue(raw) {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  return unquoteLineValue(raw);
}

function codebuddyLineParse(text) {
  const split = splitFrontmatter(text);
  if (split.kind !== "fm") return { data: {}, noFm: true, unprovenKeys: [] };
  const raw = parseLineMap(split.dataText);
  const data = {};
  const unprovenKeys = [];
  for (const [key, value] of Object.entries(raw)) {
    if (isBlockScalarIndicator(value)) {
      unprovenKeys.push(key);
      data[key] = value;
      continue;
    }
    data[key] = coerceLineValue(value);
  }
  return { data, body: split.body, unprovenKeys };
}

async function runCodebuddy(ctx) {
  const { skillsRootAbs, rootAbs, rootBinding } = ctx;
  const sourceId = sourceIdFor("codebuddy");
  const skills = [];
  const findings = [];

  async function walk(directoryAbs, depth) {
    if (ctx.truncated) return;
    const entries = await listDir(directoryAbs, ctx);
    if (!entries) return;
    const skillEntry = entries.find((item) => item.name === "SKILL.md");
    if (skillEntry && (skillEntry.st.isFile() || skillEntry.st.isSymbolicLink())) {
      if (skillEntry.st.isSymbolicLink()) {
        ctx.uncoveredItems.push(uncovered("file-symlink-unfollowed", "SKILL.md is a symlink and is not followed", { path: skillEntry.abs }));
      } else {
        const relativeDir = posixRelative(skillsRootAbs, directoryAbs);
        const pathName = !relativeDir || relativeDir === "." ? path.basename(skillsRootAbs) : relativeDir.split("/").join(":");
        const read = await readBoundText(rootAbs, rootBinding, skillEntry.abs, ctx);
        if (read) {
          const parsed = codebuddyLineParse(read.text);
          const data = parsed.data;
          let name;
          let description;
          const rawName = data.name;
          const rawDesc = data.description;
          const numericName = typeof rawName === "string" && /^-?\d+(\.\d+)?$/.test(rawName.trim());
          const typeFallback = numericName || typeof rawName === "number" || Array.isArray(rawName) || Array.isArray(rawDesc);
          const nameUnproven = parsed.unprovenKeys.includes("name");
          const descriptionUnproven = parsed.unprovenKeys.includes("description");
          if (parsed.unprovenKeys.length > 0) {
            ctx.uncoveredItems.push(uncovered(
              "codebuddy-unproven-parser-shape",
              "CodeBuddy simplified parser shape is outside the calibrated single-line field set",
              { path: skillEntry.abs, fields: parsed.unprovenKeys },
            ));
          }
          if (parsed.noFm) {
            name = pathName;
            description = pathName;
          } else if (typeFallback) {
            name = pathName;
            description = pathName;
          } else {
            name = nameUnproven
              ? null
              : typeof rawName === "string" && rawName.trim() !== "" ? rawName : pathName;
            description = descriptionUnproven
              ? null
              : typeof rawDesc === "string" && rawDesc.trim() !== "" ? rawDesc : name;
          }
          const visible = data["user-invocable"] !== false;
          skills.push(nativeSkillBase(skillEntry.abs, {
            name,
            description,
            parse: "ok",
            filtered: visible ? false : true,
            retained: visible,
            observations: [
              observation("discovered", true, sourceId),
              observation("menuVisible", visible, sourceId),
            ],
          }));
        }
      }
    }
    for (const entry of entries) {
      if (ctx.truncated) break;
      if (entry.st.isSymbolicLink()) {
        recordSymlink(entry, ctx);
        continue;
      }
      if (!entry.st.isDirectory()) continue;
      if (depth + 1 > CODEBUDDY_MAX_DEPTH) continue;
      await walk(entry.abs, depth + 1);
    }
  }

  await walk(skillsRootAbs, 0);
  return finalizeNative({
    hostId: "codebuddy",
    skills,
    findings,
    uncoveredItems: ctx.uncoveredItems,
    nameAmbiguities: nameAmbiguitiesFrom(skills, (item) => item.retained === true),
  });
}

async function runQoder(ctx) {
  const { skillsRootAbs, rootAbs, rootBinding } = ctx;
  const sourceId = sourceIdFor("qoder");
  const skills = [];
  const findings = [];
  const byName = new Map();

  async function walk(directoryAbs, depth, stop) {
    if (ctx.truncated || stop) return;
    const entries = await listDir(directoryAbs, ctx);
    if (!entries) return;
    const skillEntry = entries.find((item) => item.name === "SKILL.md");
    let hasSkill = false;
    if (skillEntry && depth > 0) {
      if (skillEntry.st.isSymbolicLink()) {
        ctx.uncoveredItems.push(uncovered("file-symlink-unfollowed", "SKILL.md is a symlink and is not followed", { path: skillEntry.abs }));
      } else if (skillEntry.st.isFile()) {
        hasSkill = true;
        const basename = path.basename(directoryAbs);
        const read = await readBoundText(rootAbs, rootBinding, skillEntry.abs, ctx);
        if (read) {
          const split = splitFrontmatter(read.text);
          let description;
          if (split.kind === "no-fm") description = "No frontmatter";
          else if (split.kind === "unclosed") description = "Invalid yaml";
          else {
            const parsed = parseYamlMap(split.dataText, { uniqueKeys: false });
            if (!parsed.ok) description = "Invalid yaml";
            else if (typeof parsed.data.description === "string") description = parsed.data.description;
            else description = bodyFirstLine(split.body) || "Body";
          }
          const previous = byName.get(basename);
          const skill = nativeSkillBase(skillEntry.abs, {
            name: basename,
            description,
            parse: "ok",
            filtered: false,
            retained: previous ? null : true,
            supersededBy: null,
            observations: [observation("discovered", true, sourceId)],
          });
          if (previous) {
            previous.retained = null;
            previous.supersededBy = null;
            skill.retained = null;
            ctx.uncoveredItems.push(uncovered(
              "qoder-same-basename-uncovered",
              "Qoder same-basename candidates are outside the calibrated winner order",
              { path: skillEntry.abs, name: basename },
            ));
          } else {
            byName.set(basename, skill);
          }
          skills.push(skill);
        }
      }
    }
    if (hasSkill) return;
    for (const entry of entries) {
      if (ctx.truncated) break;
      if (entry.st.isSymbolicLink()) {
        recordSymlink(entry, ctx);
        continue;
      }
      if (!entry.st.isDirectory()) continue;
      if (depth + 1 > QODER_MAX_DEPTH) continue;
      await walk(entry.abs, depth + 1, false);
    }
  }

  await walk(skillsRootAbs, 0, false);
  return finalizeNative({
    hostId: "qoder",
    skills,
    findings,
    uncoveredItems: ctx.uncoveredItems,
    nameAmbiguities: nameAmbiguitiesFrom(skills, (item) => item.name != null),
  });
}

function dshCoerceBool(value) {
  if (value === true || value === 1) return { ok: true, value: true };
  if (value === false || value === 0) return { ok: true, value: false };
  if (value === "YES" || value === "true") return { ok: true, value: true };
  if (value === "OFF" || value === "false") return { ok: true, value: false };
  if (value === null || value === undefined) return { ok: false, nullish: value === null };
  return { ok: false };
}

function dshParseSkill(text) {
  if (text.charCodeAt(0) === 0xfeff) return { discovered: false };
  if (text.startsWith("\n") || text.startsWith("\r\n")) return { discovered: false };
  const split = splitFrontmatter(text, { allowBom: false, firstLineExact: true });
  if (split.kind !== "fm") return { discovered: false };
  const parsed = parseYamlMap(split.dataText, { uniqueKeys: true });
  if (!parsed.ok) return { discovered: false };
  const data = parsed.data;
  if (Object.hasOwn(data, "userInvocable") || Object.hasOwn(data, "modelInvocable") || Object.hasOwn(data, "disableModelInvocation")) {
    return { discovered: false };
  }
  if (typeof data.name !== "string" || !DSH_NAME.test(data.name)) return { discovered: false };
  if (typeof data.description !== "string" || data.description === "") return { discovered: false };
  let userInvocable = true;
  let modelInvocable = true;
  if (Object.hasOwn(data, "user-invocable")) {
    const coerced = dshCoerceBool(data["user-invocable"]);
    if (!coerced.ok) return { discovered: false };
    userInvocable = coerced.value;
  }
  if (Object.hasOwn(data, "disable-model-invocation")) {
    const coerced = dshCoerceBool(data["disable-model-invocation"]);
    if (!coerced.ok) return { discovered: false };
    modelInvocable = coerced.value !== true;
  }
  return {
    discovered: true,
    name: data.name,
    description: data.description,
    userInvocable,
    modelInvocable,
  };
}

async function runDsh(ctx) {
  const { skillsRootAbs, rootAbs, rootBinding } = ctx;
  const sourceId = sourceIdFor("deepseek-harness");
  const skills = [];
  const findings = [];
  const entries = await listDir(skillsRootAbs, ctx);
  if (!entries) {
    return finalizeNative({ hostId: "deepseek-harness", skills, findings, uncoveredItems: ctx.uncoveredItems, nameAmbiguities: [] });
  }
  const sorted = localeSort(entries);
  const seen = new Map();
  let localOrder = 0;
  for (const entry of sorted) {
    if (ctx.truncated) break;
    if (entry.st.isSymbolicLink()) {
      ctx.uncoveredItems.push(uncovered(
        "dsh-external-symlink-unfollowed",
        "native filesystem component may follow this symlink; Foundation containment does not expand it",
        { path: entry.abs },
      ));
      continue;
    }
    if (entry.st.isFile()) {
      if (entry.name === "SKILL.md" || (entry.name.endsWith(".md") && !entry.name.endsWith(".MD") && entry.name.toLowerCase().endsWith(".md") && entry.name.slice(-3) === ".md")) {
        localOrder += 1;
        const read = await readBoundText(rootAbs, rootBinding, entry.abs, ctx);
        if (!read) continue;
        const parsed = dshParseSkill(read.text);
        if (!parsed.discovered) {
          skills.push(nativeSkillBase(entry.abs, {
            parse: "ok",
            filtered: true,
            retained: false,
            observations: [
              observation("discovered", false, sourceId),
              observation("userInvocable", null, sourceId),
              observation("modelInvocable", null, sourceId),
            ],
          }));
          continue;
        }
        registerDsh(entry.abs, parsed, localOrder, { entryName: entry.name, kind: "flat" });
      }
      continue;
    }
    if (!entry.st.isDirectory()) continue;
    const skillPath = path.join(entry.abs, "SKILL.md");
    const looked = await lstatMissingOrUncovered(skillPath, ctx);
    if (!looked.stat) continue;
    const skillStat = looked.stat;
    if (skillStat.isSymbolicLink()) {
      ctx.uncoveredItems.push(uncovered(
        "dsh-external-symlink-unfollowed",
        "native filesystem component may follow this symlink; Foundation containment does not expand it",
        { path: skillPath },
      ));
      continue;
    }
    if (!skillStat.isFile()) continue;
    localOrder += 1;
    const read = await readBoundText(rootAbs, rootBinding, skillPath, ctx);
    if (!read) continue;
    const parsed = dshParseSkill(read.text);
    if (!parsed.discovered) {
      skills.push(nativeSkillBase(skillPath, {
        name: parsed.name ?? null,
        parse: "ok",
        filtered: true,
        retained: false,
        observations: [
          observation("discovered", false, sourceId),
          observation("userInvocable", null, sourceId),
          observation("modelInvocable", null, sourceId),
        ],
      }));
      continue;
    }
    registerDsh(skillPath, parsed, localOrder, { entryName: entry.name, kind: "dir" });
  }

  function registerDsh(skillPath, parsed, order, identity) {
    const previous = seen.get(parsed.name);
    if (previous) {
      const uncalibrated = previous.ambiguous
        || identity.kind !== previous.kind
        || !isAsciiText(identity.entryName)
        || !isAsciiText(previous.entryName)
        || identity.entryName.localeCompare(previous.entryName) === 0;
      if (uncalibrated) {
        previous.ambiguous = true;
        for (const candidate of skills) {
          if (candidate.name !== parsed.name || !candidate.observations.some((item) => item.field === "discovered" && item.value === true)) continue;
          candidate.retained = null;
          candidate.supersededBy = null;
          candidate.filtered = false;
        }
        ctx.uncoveredItems.push(uncovered(
          "dsh-name-collision-uncovered",
          "DeepSeek Harness name competition is outside the calibrated ASCII first-wins sample",
          { path: skillPath, name: parsed.name },
        ));
        skills.push(nativeSkillBase(skillPath, {
          name: parsed.name,
          description: parsed.description,
          parse: "ok",
          filtered: false,
          retained: null,
          supersededBy: null,
          observations: [
            observation("discovered", true, sourceId),
            observation("userInvocable", parsed.userInvocable, sourceId),
            observation("modelInvocable", parsed.modelInvocable, sourceId),
          ],
        }));
        return;
      }
      skills.push(nativeSkillBase(skillPath, {
        name: parsed.name,
        description: parsed.description,
        parse: "ok",
        filtered: true,
        retained: false,
        supersededBy: previous.path,
        observations: [
          observation("discovered", true, sourceId),
          observation("userInvocable", parsed.userInvocable, sourceId),
          observation("modelInvocable", parsed.modelInvocable, sourceId),
        ],
      }));
      return;
    }
    const skill = nativeSkillBase(skillPath, {
      name: parsed.name,
      description: parsed.description,
      parse: "ok",
      filtered: false,
      retained: true,
      observations: [
        observation("discovered", true, sourceId),
        observation("userInvocable", parsed.userInvocable, sourceId),
        observation("modelInvocable", parsed.modelInvocable, sourceId),
      ],
    });
    seen.set(parsed.name, { path: skillPath, order, skill, entryName: identity.entryName, kind: identity.kind });
    skills.push(skill);
  }

  return finalizeNative({
    hostId: "deepseek-harness",
    skills,
    findings,
    uncoveredItems: ctx.uncoveredItems,
    nameAmbiguities: nameAmbiguitiesFrom(skills, (item) => item.name != null),
  });
}

const RUNNERS = {
  claude: runClaude,
  cursor: runCursor,
  "kimi-code": runKimi,
  workbuddy: runWorkbuddy,
  codebuddy: runCodebuddy,
  qoder: runQoder,
  "deepseek-harness": runDsh,
};

export async function runNativeHostLoadingCheck({
  rootAbs,
  skillsRootAbs,
  hostId,
  rootBinding,
}) {
  const ctx = {
    rootAbs,
    skillsRootAbs,
    rootBinding,
    uncoveredItems: [],
    directoryCount: 0,
    entryCount: 0,
    truncated: false,
  };
  const runner = RUNNERS[hostId];
  const result = await runner(ctx);
  if (ctx.truncated) {
    result.uncoveredItems.push(uncovered(
      "scan-limit",
      "native skill discovery hit the calibrated directory or entry capacity",
    ));
  }
  return result;
}
