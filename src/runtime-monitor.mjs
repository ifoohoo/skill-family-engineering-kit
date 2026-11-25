// @feature FND-FR-036
// @decision FND-ADR-037
// @design FND-DES-046
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, realpathSync, statSync, watch as watchFs } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { digestDocument } from "skill-family-contracts";
import {
  FOUNDATION_PACKAGE_VERSION,
  PROCESS_STATUSES,
  STATE_GENESIS_DIGEST,
  acquireFilesystemLock,
  appendEvent,
  closeStateStore,
  inspectFilesystemLock,
  inspectStateStoreLock,
  openStateStore,
  releaseFilesystemLock,
  resolveContained,
  superviseProcess,
  writeFileAtomic,
  writeSnapshot,
} from "skill-family-harness-node";
import { invalidParamsError, KIT_ERROR_KINDS, kitError } from "./errors.mjs";

export const RUNTIME_MONITOR_SNAPSHOT_KIND = "skill-family.runtime-monitor-snapshot";
export const STUDIO_UNAVAILABLE_HINT =
  "未检测到已安装的 skill-family-studio 可视化工作台（可通过环境变量 SKILL_FAMILY_STUDIO_BIN、项目 node_modules/.bin/skill-family-studio、PATH、同级 skill-family-studio-workspace 或 skill-family-studio 目录提供）；Foundation 仅保留无界面运行态 JSON 快照与登记底座，已回退为无界面状态摘要模式。";
export const DEFAULT_MONITOR_PORT = 57631;
export const DEFAULT_REGISTRY_PATH = ".artifacts/runtime-monitor/registry.json";
export const LEGACY_FALLBACK_REGISTRY_PATH = "artifacts/runtime-monitor/registry.json";
export const DEFAULT_LOCK_WARN_MS = 30_000;

const LOOPBACK_IPV4 = "127.0.0.1";
function formatLoopbackUrl(port, suffix = "") {
  return ["http", "://", LOOPBACK_IPV4, ":", String(port), "/", suffix].join("");
}

const DEFAULT_CLI_ENTRY_PATH = fileURLToPath(new URL("./cli.mjs", import.meta.url));
const FORBIDDEN_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SENSITIVE_PATH_SEGMENTS = new Set([
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

const SKIP_SCAN_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "deliveries",
  "files",
  "deleted-from-HEAD",
  "pnpm-store",
  "workspace",
  "tmp",
  ".venv",
  "__pycache__",
  ".cache",
  "r-d",
  "r-v",
]);

const WORKSPACE_PACKAGE_PARENT = resolve(dirname(DEFAULT_CLI_ENTRY_PATH), "../../..");

function createForbiddenPathError(message, statusCode = 403, extra = {}) {
  const err = kitError(KIT_ERROR_KINDS.MONITOR_PATH_FORBIDDEN, message, { statusCode, ...extra });
  err.statusCode = statusCode;
  return err;
}

function createBadRequestError(message, extra = {}) {
  const err = invalidParamsError(message, { statusCode: 400, ...extra });
  err.statusCode = 400;
  return err;
}

function hasSensitiveSegment(pathValue) {
  const segments = String(pathValue ?? "").split(/[\\/]+/).filter(Boolean);
  for (const seg of segments) {
    const lower = seg.toLowerCase();
    if (SENSITIVE_PATH_SEGMENTS.has(lower) || lower === ".env" || lower.startsWith(".env.")) {
      return true;
    }
  }
  return false;
}

function canonicalizeExistingAncestorSync(targetAbs) {
  let current = resolve(targetAbs);
  const tail = [];
  while (true) {
    let st = null;
    try {
      st = lstatSync(current);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw createForbiddenPathError(`无法核验监控目标路径：${error.message}`, 403);
      }
    }
    if (st) {
      try {
        const realBase = realpathSync(current);
        return tail.length > 0 ? resolve(realBase, ...tail.reverse()) : realBase;
      } catch {
        throw createForbiddenPathError(`监控目标路径包含损坏或不可解析的软链接：${targetAbs}`, 403);
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      return tail.length > 0 ? resolve(current, ...tail.reverse()) : current;
    }
    tail.push(basename(current));
    current = parent;
  }
}

function isWithinRoot(candidateAbs, rootAbs) {
  if (!rootAbs) return false;
  if (candidateAbs === rootAbs) return true;
  const prefix = rootAbs.endsWith(sep) ? rootAbs : `${rootAbs}${sep}`;
  return candidateAbs.startsWith(prefix);
}

function normalizeAllowedRoots(baseRoot, customAllowedRoots) {
  const rawRoots = Array.isArray(customAllowedRoots) && customAllowedRoots.length > 0
    ? customAllowedRoots
    : [resolve(baseRoot), tmpdir()];
  const normalized = [];
  const seen = new Set();
  for (const item of rawRoots) {
    if (!item || typeof item !== "string") continue;
    try {
      const canonical = canonicalizeExistingAncestorSync(resolve(item));
      if (!Array.isArray(customAllowedRoots) && canonical === sep) continue;
      if (!seen.has(canonical)) {
        seen.add(canonical);
        normalized.push(canonical);
      }
    } catch {}
  }
  return normalized;
}

export function resolveTargetPath(root, inputPath, { allowedRoots, strict = false } = {}) {
  if (!inputPath || typeof inputPath !== "string") return null;
  const trimmed = inputPath.trim();
  if (!trimmed) return null;

  const fail = (message, statusCode = 403) => {
    if (strict) throw createForbiddenPathError(message, statusCode, { inputPath: trimmed });
    return null;
  };

  if (trimmed.includes("\0") || trimmed.split(/[\\/]+/).includes("..")) {
    return fail(`监控目标路径不允许包含 ".." 上级目录跳转或非法控制字符：${trimmed}`, 403);
  }
  if (hasSensitiveSegment(trimmed)) {
    return fail(`拒绝注册或读取敏感隐藏目录路径：${trimmed}`, 403);
  }

  const baseRoot = resolve(root || ".");
  const rawCandidate = isAbsolute(trimmed) ? resolve(trimmed) : resolve(baseRoot, trimmed);
  let canonicalTarget;
  let canonicalBaseRoot;
  try {
    canonicalTarget = canonicalizeExistingAncestorSync(rawCandidate);
    canonicalBaseRoot = canonicalizeExistingAncestorSync(baseRoot);
  } catch (error) {
    return fail(error.message || `无法解析监控目标路径：${trimmed}`, error.statusCode ?? 403);
  }

  if (hasSensitiveSegment(canonicalTarget)) {
    return fail(`拒绝注册或读取敏感隐藏目录路径：${trimmed}`, 403);
  }
  if (!isAbsolute(trimmed) && !isWithinRoot(canonicalTarget, canonicalBaseRoot)) {
    return fail(`相对监控路径超出当前根目录边界：${trimmed}`, 403);
  }

  const effectiveRoots = normalizeAllowedRoots(baseRoot, allowedRoots);
  if (!effectiveRoots.some((allowed) => isWithinRoot(canonicalTarget, allowed))) {
    return fail(`监控目标路径超出允许观测的根目录边界（仅允许声明的工作区根或系统临时目录）：${trimmed}`, 403);
  }
  return canonicalTarget;
}

async function safeLstat(target) {
  try {
    return await lstat(target);
  } catch {
    return null;
  }
}

async function safeReadJson(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    return { ok: true, value: JSON.parse(raw), raw };
  } catch (error) {
    return { ok: false, error: error?.message ?? "unreadable" };
  }
}

function cleanMarkdownInline(text) {
  return String(text ?? "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/<br\s*\/?>/gi, " · ")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTaskStatus(raw) {
  const text = String(raw ?? "").trim();
  const lower = text.toLowerCase();
  if (!text) return null;
  if (/\[done\]|^done$|^completed?$|^passed?$|^pass$|^succeeded$|^ok$|^exited$/i.test(lower)) return "done";
  if (/\[process\]|\[running\]|\[wip\]|^running$|^in[_-\s]?progress$|^active$|^supervising$/i.test(lower)) return "running";
  if (/\[blocked\]|\[failed\]|^blocked$|^failed$|^error$|^timed_out$|^terminated$/i.test(lower)) return "blocked";
  if (/\[todo\]|^todo$|^pending$|^planned$|^queued$/i.test(lower)) return "todo";
  if (lower.includes("[done]")) return "done";
  if (lower.includes("[process]") || lower.includes("[running]")) return "running";
  if (lower.includes("[blocked]")) return "blocked";
  if (lower.includes("[todo]")) return "todo";
  if (/不适用/.test(text)) return null;
  if (/失败|阻断|异常|超时/.test(text) && !/零失败|0\s*fail|无异常/.test(text)) return "blocked";
  if (/进行中|正在|待授权|待重验|待用户/.test(text)) return "running";
  if (/尚未|待推进|未启动|未完成|待办/.test(text)) return "todo";
  if (/已完成|全部通过|验证通过|核对通过|全绿|完成/.test(text)) return "done";
  return null;
}

function parseCsvRows(csvText) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < csvText.length; i += 1) {
    const ch = csvText[i];
    if (inQuotes) {
      if (ch === '"') {
        if (csvText[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field.trim());
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && csvText[i + 1] === "\n") i += 1;
      row.push(field.trim());
      if (row.some((cell) => cell.length > 0)) rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  row.push(field.trim());
  if (row.some((cell) => cell.length > 0)) rows.push(row);
  return rows;
}

function summarizeMilestones(tasks) {
  const map = new Map();
  for (const task of tasks) {
    const group = task.group || "默认阶段";
    if (!map.has(group)) {
      map.set(group, { name: group, total: 0, done: 0, running: 0, todo: 0, blocked: 0, percent: 0 });
    }
    const item = map.get(group);
    item.total += 1;
    if (task.status === "done") item.done += 1;
    else if (task.status === "running") item.running += 1;
    else if (task.status === "blocked") item.blocked += 1;
    else item.todo += 1;
  }
  const milestones = [...map.values()];
  for (const m of milestones) {
    m.percent = m.total > 0 ? Math.round(((m.done + m.running * 0.5) / m.total) * 100) : 0;
  }
  return milestones;
}

export function parseProgressContent(text, formatHint = ".md", sourceLabel = "plan") {
  const ext = String(formatHint ?? ".md").toLowerCase();
  const tasks = [];

  if (ext.endsWith(".csv") || ext === "csv") {
    const rows = parseCsvRows(text);
    if (rows.length >= 2) {
      const headers = rows[0].map((h) => h.toLowerCase());
      const findIdx = (names) => headers.findIndex((h) => names.some((n) => h === n || h.includes(n)));
      const idIdx = findIdx(["id", "task_id", "编号", "code"]);
      const titleIdx = findIdx(["title", "name", "task", "标题", "任务", "事项"]);
      const statusIdx = findIdx(["status", "state", "phase", "状态", "阶段"]);
      const groupIdx = findIdx(["group", "milestone", "stage", "里程碑", "分组"]);
      const detailIdx = findIdx(["detail", "note", "owner", "说明", "负责人"]);

      for (let i = 1; i < rows.length; i += 1) {
        const cols = rows[i];
        const rawTitle = titleIdx >= 0 ? cols[titleIdx] : cols[1] ?? cols[0];
        if (!rawTitle) continue;
        const rawStatus = statusIdx >= 0 ? cols[statusIdx] : "todo";
        const status = normalizeTaskStatus(rawStatus) ?? "todo";
        tasks.push({
          id: idIdx >= 0 && cols[idIdx] ? cols[idIdx] : `CSV-${i}`,
          title: rawTitle,
          status,
          rawStatus: rawStatus || status,
          group: groupIdx >= 0 && cols[groupIdx] ? cols[groupIdx] : "CSV 进度清单",
          detail: detailIdx >= 0 && cols[detailIdx] ? cols[detailIdx] : "",
          sourceType: "csv",
          sourceLabel,
        });
      }
    }
    return { format: "csv", tasks, milestones: summarizeMilestones(tasks) };
  }

  if (ext.endsWith(".json") || ext === "json") {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { format: "json", tasks: [], milestones: [] };
    }
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.tasks)
        ? parsed.tasks
        : Array.isArray(parsed?.steps)
          ? parsed.steps
          : Array.isArray(parsed?.actual_steps)
            ? parsed.actual_steps
            : [];
    list.forEach((entry, idx) => {
      if (!entry || typeof entry !== "object") return;
      const status = entry.status
        ? (normalizeTaskStatus(entry.status) ?? "todo")
        : typeof entry.exitCode === "number"
          ? (entry.exitCode === 0 ? "done" : "blocked")
          : entry.done === true ? "done" : "todo";
      tasks.push({
        id: String(entry.id ?? entry.code ?? `STEP-${idx + 1}`),
        title: String(entry.title ?? entry.name ?? entry.id ?? `步骤 ${idx + 1}`),
        status,
        rawStatus: String(entry.status ?? (typeof entry.exitCode === "number" ? `exit=${entry.exitCode}` : status)),
        group: String(entry.group ?? entry.milestone ?? "JSON 阶段步骤"),
        detail: typeof entry.durationMs === "number" ? `耗时 ${(entry.durationMs / 1000).toFixed(2)}s` : String(entry.detail ?? ""),
        sourceType: "json",
        sourceLabel,
      });
    });
    if (tasks.length === 0 && parsed && typeof parsed === "object" && Array.isArray(parsed.argv)) {
      const invStatus = normalizeTaskStatus(parsed.status) ?? "todo";
      tasks.push({
        id: parsed.version ? `v${parsed.version}` : `PID-${parsed.pid ?? "run"}`,
        title: parsed.argv.slice(0, 4).join(" "),
        status: parsed.exit_code !== undefined && parsed.exit_code !== 0 ? "blocked" : invStatus,
        rawStatus: String(parsed.status ?? "UNKNOWN"),
        group: "运行调用记录",
        detail: parsed.cwd ? basename(parsed.cwd) : "",
        sourceType: "json-invocation",
        sourceLabel,
      });
    }
    return { format: "json", tasks, milestones: summarizeMilestones(tasks) };
  }

  const lines = String(text ?? "").split(/\r?\n/);
  let inFence = false;
  let currentGroup = "核心待办与执行阶段";
  let checkboxSeq = 0;
  let tableSeq = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const headingMatch = /^(#{1,4})\s+(.+)$/.exec(line);
    if (headingMatch) {
      const cleanHeading = cleanMarkdownInline(headingMatch[2]);
      if (cleanHeading) currentGroup = cleanHeading;
      continue;
    }

    const cbMatch = /^\s*[-*+]\s+\[([ xX/\-~])\]\s+(.+)$/.exec(line);
    if (cbMatch) {
      checkboxSeq += 1;
      const mark = cbMatch[1].toLowerCase();
      const status = mark === "x" ? "done" : mark === "/" || mark === "-" || mark === "~" ? "running" : "todo";
      const cleaned = cleanMarkdownInline(cbMatch[2]);
      const idExtract = /^\[([A-Za-z0-9_.-]+)\]\s*(.+)$/.exec(cleaned);
      tasks.push({
        id: idExtract ? idExtract[1] : `TASK-${String(checkboxSeq).padStart(2, "0")}`,
        title: idExtract ? idExtract[2] : cleaned,
        status,
        rawStatus: mark === "x" ? "[x]" : mark === " " ? "[ ]" : `[${mark}]`,
        group: currentGroup,
        detail: "",
        sourceType: "markdown-checkbox",
        sourceLabel,
      });
      continue;
    }

    if (/^\s*\|.+\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const splitCells = (rowLine) => rowLine.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
      const headers = splitCells(line).map((h) => cleanMarkdownInline(h));
      const statusColIdx = headers.findIndex((h) => /状态|当前安排|本轮本地状态|status|phase|进展/i.test(h));
      i += 2;
      while (i < lines.length && /^\s*\|.+\|\s*$/.test(lines[i])) {
        const rawCells = splitCells(lines[i]);
        const cells = rawCells.map((c) => cleanMarkdownInline(c));
        let detectedStatus = null;
        let rawStatusText = "";
        for (const rawCell of rawCells) {
          if (/\[(done|process|todo|blocked|running)\]/i.test(rawCell)) {
            detectedStatus = normalizeTaskStatus(rawCell);
            rawStatusText = cleanMarkdownInline(rawCell);
            break;
          }
        }
        if (!detectedStatus && statusColIdx >= 0 && statusColIdx < rawCells.length) {
          detectedStatus = normalizeTaskStatus(rawCells[statusColIdx]);
          rawStatusText = cells[statusColIdx];
        }
        if (detectedStatus && cells[0]) {
          tableSeq += 1;
          const titleCell = cells.length >= 2 && cells[0].length <= 16 && !/战线|里程碑/.test(cells[0])
            ? `${cells[0]} · ${cells[1]}`
            : cells[0];
          const detailCell = cells.length >= 3 ? cells[1] : "";
          tasks.push({
            id: `STAGE-${String(tableSeq).padStart(2, "0")}`,
            title: titleCell,
            status: detectedStatus,
            rawStatus: rawStatusText || detectedStatus,
            group: currentGroup,
            detail: detailCell !== titleCell ? detailCell.slice(0, 120) : "",
            sourceType: "markdown-table",
            sourceLabel,
          });
        }
        i += 1;
      }
      i -= 1;
    }
  }

  return { format: "markdown", tasks, milestones: summarizeMilestones(tasks) };
}

async function walkBoundedFiles(rootDir, { maxDepth = 4, maxFiles = 260, acceptFile } = {}) {
  const found = [];
  const rootStat = await safeLstat(rootDir);
  if (!rootStat || !rootStat.isDirectory()) return found;

  async function visit(currentDir, depth) {
    if (depth > maxDepth || found.length >= maxFiles) return;
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (found.length >= maxFiles) break;
      if (entry.isSymbolicLink()) continue;
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_SCAN_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        await visit(fullPath, depth + 1);
      } else if (entry.isFile()) {
        if (!acceptFile || acceptFile(entry.name, fullPath, depth)) {
          found.push(fullPath);
        }
      }
    }
  }

  await visit(rootDir, 0);
  return found;
}

function computeUnsignedEventDigest(record) {
  if (!record || typeof record !== "object") return null;
  const { recordDigest: _ignored, ...unsigned } = record;
  try {
    return digestDocument(unsigned);
  } catch {
    return null;
  }
}

export async function inspectStateStoreReadOnly(stateDir, { lockWarnMs = DEFAULT_LOCK_WARN_MS, nowMs = Date.now() } = {}) {
  if (!stateDir) return null;
  const dirStat = await safeLstat(stateDir);
  if (!dirStat || !dirStat.isDirectory()) {
    return {
      path: stateDir,
      exists: false,
      isStateStore: false,
      integrity: "MISSING",
      lastSequence: 0,
      headDigest: null,
      fencing: 0,
      writerLock: null,
      events: [],
      snapshots: [],
    };
  }

  let canonicalDir = stateDir;
  try { canonicalDir = await realpath(stateDir); } catch {}

  const headJson = await safeReadJson(join(canonicalDir, "chain-head.json"));
  const fencingJson = await safeReadJson(join(canonicalDir, "fencing-counter.json"));
  const eventsDirStat = await safeLstat(join(canonicalDir, "events"));
  const snapshotsDirStat = await safeLstat(join(canonicalDir, "snapshots"));
  const writerLockStat = await safeLstat(join(canonicalDir, "writer.lock"));
  const mutationLockStat = await safeLstat(join(canonicalDir, "writer-mutation.lock"));
  const recoveryLockStat = await safeLstat(join(canonicalDir, "writer-recovery.lock"));

  const isStateStore = Boolean(
    headJson.ok || fencingJson.ok || eventsDirStat?.isDirectory() || snapshotsDirStat?.isDirectory() || writerLockStat,
  );
  if (!isStateStore) {
    return {
      path: canonicalDir,
      exists: true,
      isStateStore: false,
      integrity: "NOT_STORE",
      lastSequence: 0,
      headDigest: null,
      fencing: 0,
      writerLock: null,
      events: [],
      snapshots: [],
    };
  }

  let writerLock = null;
  try {
    const inspected = await inspectStateStoreLock(canonicalDir);
    if (inspected?.locked) {
      const ageMs = Math.max(0, nowMs - Date.parse(inspected.acquiredAt));
      writerLock = {
        locked: true,
        owner: inspected.owner,
        fencing: inspected.fencing,
        acquiredAt: inspected.acquiredAt,
        ageMs,
        recoveryInProgress: Boolean(inspected.recoveryInProgress),
        isStaleWarning: ageMs >= lockWarnMs,
      };
    }
  } catch {
    if (writerLockStat?.isFile()) {
      const fallbackLock = await safeReadJson(join(canonicalDir, "writer.lock"));
      if (fallbackLock.ok && fallbackLock.value?.owner) {
        const ageMs = Math.max(0, nowMs - Date.parse(fallbackLock.value.acquiredAt));
        writerLock = {
          locked: true,
          owner: fallbackLock.value.owner,
          fencing: fallbackLock.value.fencing ?? 0,
          acquiredAt: fallbackLock.value.acquiredAt,
          ageMs: Number.isFinite(ageMs) ? ageMs : 0,
          recoveryInProgress: Boolean(recoveryLockStat),
          isStaleWarning: Number.isFinite(ageMs) && ageMs >= lockWarnMs,
        };
      }
    }
  }

  const events = [];
  let integrity = "EMPTY";
  let integrityError = null;
  let prevDigest = STATE_GENESIS_DIGEST;

  if (eventsDirStat?.isDirectory()) {
    const names = (await readdir(join(canonicalDir, "events"))).filter((n) => /^\d{6}\.json$/.test(n)).sort();
    for (let idx = 0; idx < names.length; idx += 1) {
      const fileName = names[idx];
      const expectedSeq = idx + 1;
      const actualSeqFromName = Number(fileName.slice(0, 6));
      const fullEventPath = join(canonicalDir, "events", fileName);
      const parsed = await safeReadJson(fullEventPath);
      const evStat = await safeLstat(fullEventPath);
      if (!parsed.ok || actualSeqFromName !== expectedSeq) {
        integrity = "CHAIN_BROKEN";
        integrityError = `事件序号或 JSON 损坏：${fileName}`;
        break;
      }
      const rec = parsed.value;
      const computedDigest = computeUnsignedEventDigest(rec);
      const chainMatches = rec.sequence === expectedSeq
        && rec.prevDigest === prevDigest
        && computedDigest === rec.recordDigest;
      if (!chainMatches && integrity !== "CHAIN_BROKEN") {
        integrity = "CHAIN_BROKEN";
        integrityError = `事件 #${expectedSeq} 哈希链断裂`;
      }
      prevDigest = rec.recordDigest ?? prevDigest;
      events.push({
        sequence: rec.sequence,
        eventId: rec.eventId,
        eventType: rec.eventType,
        payloadSchemaVersion: rec.payloadSchemaVersion,
        producer: rec.producer,
        writerOwner: rec.writerOwner,
        writerFencing: rec.writerFencing,
        prevDigest: rec.prevDigest,
        recordDigest: rec.recordDigest,
        payload: rec.payload,
        digestVerified: chainMatches,
        recordedAt: rec.payload?.timestamp ?? rec.payload?.at ?? (evStat ? new Date(evStat.mtimeMs).toISOString() : null),
        filePath: fullEventPath,
      });
    }
    if (integrity !== "CHAIN_BROKEN") {
      if (events.length === 0) integrity = "EMPTY";
      else if (headJson.ok) {
        const headMatches = headJson.value?.lastSequence === events.length && headJson.value?.headDigest === prevDigest;
        integrity = headMatches ? "VALID" : "STALE_HEAD";
      } else {
        integrity = "VALID";
      }
    }
  }

  const snapshots = [];
  if (snapshotsDirStat?.isDirectory()) {
    const snapNames = (await readdir(join(canonicalDir, "snapshots"))).filter((n) => /^\d{6}\.json$/.test(n)).sort();
    for (const snapName of snapNames) {
      const snapFull = join(canonicalDir, "snapshots", snapName);
      const parsed = await safeReadJson(snapFull);
      if (parsed.ok) {
        snapshots.push({
          lastSequence: parsed.value.lastSequence,
          chainHeadDigest: parsed.value.chainHeadDigest,
          stateDigest: parsed.value.stateDigest,
          hostSessionRef: parsed.value.hostSessionRef ?? null,
          filePath: snapFull,
        });
      }
    }
  }

  return {
    path: canonicalDir,
    exists: true,
    isStateStore: true,
    integrity,
    integrityError,
    lastSequence: events.length > 0 ? events[events.length - 1].sequence : (headJson.value?.lastSequence ?? 0),
    headDigest: events.length > 0 ? prevDigest : (headJson.value?.headDigest ?? STATE_GENESIS_DIGEST),
    fencing: fencingJson.value?.lastFencing ?? writerLock?.fencing ?? 0,
    writerLock,
    hasActiveMutation: Boolean(mutationLockStat?.isFile()),
    hasActiveRecovery: Boolean(recoveryLockStat?.isFile()),
    events,
    snapshots,
  };
}

async function inspectSingleLockFile(fullPath, { lockWarnMs = DEFAULT_LOCK_WARN_MS, nowMs = Date.now(), targetId } = {}) {
  const fileStat = await safeLstat(fullPath);
  if (!fileStat || !fileStat.isFile()) return null;
  const name = basename(fullPath);

  if (name === "traceability-version-lock.json") {
    const parsed = await safeReadJson(fullPath);
    if (!parsed.ok) return null;
    const relCount = Array.isArray(parsed.value?.artifactRelations) ? parsed.value.artifactRelations.length : 0;
    const directLocks = Array.isArray(parsed.value?.locks) ? parsed.value.locks.length : 0;
    const uniqueFiles = new Set();
    for (const edge of parsed.value?.artifactRelations ?? []) {
      if (edge?.source?.path) uniqueFiles.add(edge.source.path);
      if (edge?.target?.path) uniqueFiles.add(edge.target.path);
    }
    return {
      id: `vlock:${fullPath}`,
      targetId,
      lockKind: "version-lock",
      name,
      path: fullPath,
      owner: "artifact-graph",
      acquiredAt: new Date(fileStat.mtimeMs).toISOString(),
      ageMs: Math.max(0, nowMs - fileStat.mtimeMs),
      isActive: false,
      isStaleWarning: false,
      status: "ANCHORED",
      summary: `${relCount} 条关系锁 · ${uniqueFiles.size} 个制品文件${directLocks ? ` · ${directLocks} 项直锁` : ""}`,
      raw: {
        schemaVersion: parsed.value?.schemaVersion ?? "1.0",
        relationCount: relCount,
        directLockCount: directLocks,
        trackedFileCount: uniqueFiles.size,
      },
    };
  }

  if (name === "writer.lock" || name === "writer-mutation.lock" || name === "writer-recovery.lock") {
    const parsed = await safeReadJson(fullPath);
    const val = parsed.ok ? parsed.value : {};
    const acquiredAt = val?.acquiredAt ?? new Date(fileStat.mtimeMs).toISOString();
    const ageMs = Math.max(0, nowMs - Date.parse(acquiredAt));
    const isStaleWarning = Number.isFinite(ageMs) && ageMs >= lockWarnMs;
    return {
      id: `sslock:${fullPath}`,
      targetId,
      lockKind: name === "writer.lock" ? "state-store-writer" : "state-store-control",
      name,
      path: fullPath,
      owner: val?.owner ?? (name === "writer-recovery.lock" ? "recovery-coordinator" : "unknown"),
      fencing: val?.fencing ?? null,
      acquiredAt,
      ageMs: Number.isFinite(ageMs) ? ageMs : 0,
      isActive: true,
      isStaleWarning,
      status: name === "writer-recovery.lock" ? "RECOVERING" : isStaleWarning ? "WARN_HELD_LONG" : "ACTIVE",
      summary: name === "writer.lock"
        ? `State-Store 写入锁 (fencing #${val?.fencing ?? 0})`
        : name === "writer-mutation.lock"
          ? `原子变更守卫 (${val?.operation ?? "mutation"})`
          : "显式锁恢复守卫",
      raw: val,
    };
  }

  if (name.endsWith(".lock")) {
    try {
      const parentReal = await realpath(dirname(fullPath));
      const inspected = await inspectFilesystemLock(parentReal, name);
      if (inspected?.locked) {
        const ageMs = Math.max(0, nowMs - Date.parse(inspected.acquiredAt));
        const isStaleWarning = ageMs >= lockWarnMs;
        return {
          id: `tlock:${fullPath}`,
          targetId,
          lockKind: "token-lock",
          name,
          path: fullPath,
          owner: inspected.owner,
          tokenDigest: inspected.tokenDigest,
          identity: inspected.identity,
          acquiredAt: inspected.acquiredAt,
          ageMs,
          isActive: true,
          isStaleWarning,
          status: isStaleWarning ? "WARN_HELD_LONG" : "ACTIVE",
          summary: `Foundation 令牌排他锁 (${inspected.tokenDigest.slice(0, 12)}…)`,
          raw: inspected,
        };
      }
    } catch (error) {
      const fallback = await safeReadJson(fullPath);
      const ageMs = Math.max(0, nowMs - fileStat.mtimeMs);
      return {
        id: `clock:${fullPath}`,
        targetId,
        lockKind: "custom-lock",
        name,
        path: fullPath,
        owner: fallback.value?.owner ?? "custom-lock-holder",
        acquiredAt: fallback.value?.acquiredAt ?? new Date(fileStat.mtimeMs).toISOString(),
        ageMs,
        isActive: true,
        isStaleWarning: ageMs >= lockWarnMs,
        status: fallback.ok ? (ageMs >= lockWarnMs ? "WARN_HELD_LONG" : "ACTIVE") : "CORRUPT",
        summary: fallback.ok ? "自定义 JSON 文件锁" : `锁记录校验异常 (${error?.message ?? "corrupt"})`,
        raw: fallback.ok ? fallback.value : { error: error?.message ?? "unreadable" },
      };
    }
  }
  return null;
}

export async function scanLocksReadOnly(resolvedTarget, { lockWarnMs = DEFAULT_LOCK_WARN_MS, nowMs = Date.now() } = {}) {
  const candidates = new Set();
  for (const dirCandidate of [resolvedTarget.stateDir, resolvedTarget.runsDir]) {
    if (!dirCandidate) continue;
    const files = await walkBoundedFiles(dirCandidate, {
      maxDepth: 3,
      maxFiles: 120,
      acceptFile: (name) => name.endsWith(".lock") || name === "traceability-version-lock.json",
    });
    for (const f of files) candidates.add(f);
  }
  for (const lockInput of resolvedTarget.lockPaths ?? []) {
    const st = await safeLstat(lockInput);
    if (!st) continue;
    if (st.isFile()) candidates.add(lockInput);
    else if (st.isDirectory()) {
      const files = await walkBoundedFiles(lockInput, {
        maxDepth: 2,
        maxFiles: 80,
        acceptFile: (name) => name.endsWith(".lock") || name === "traceability-version-lock.json",
      });
      for (const f of files) candidates.add(f);
    }
  }

  const locks = [];
  for (const candidate of candidates) {
    const item = await inspectSingleLockFile(candidate, { lockWarnMs, nowMs, targetId: resolvedTarget.id });
    if (item) locks.push(item);
  }
  locks.sort((a, b) => Number(b.isActive) - Number(a.isActive) || Number(b.isStaleWarning) - Number(a.isStaleWarning) || a.name.localeCompare(b.name));
  return locks;
}

function normalizeProcessStatus(rawStatus, exitCode) {
  const upper = String(rawStatus ?? "").toUpperCase();
  if (PROCESS_STATUSES.includes(upper)) return upper;
  if (upper === "SUPERVISING" || upper === "IN_PROGRESS" || upper === "ACTIVE") return "RUNNING";
  if (upper === "COMPLETED" || upper === "SUCCEEDED" || upper === "DONE") return "EXITED";
  if (upper === "TIMEOUT") return "TIMED_OUT";
  if (upper === "KILLED" || upper === "ABORTED") return "TERMINATED";
  if (typeof exitCode === "number") return "EXITED";
  return "EXITED";
}

export async function scanSupervisedProcessesReadOnly(resolvedTarget, { nowMs = Date.now() } = {}) {
  const files = new Set();
  for (const dirCandidate of [resolvedTarget.runsDir, resolvedTarget.stateDir]) {
    if (!dirCandidate) continue;
    const walked = await walkBoundedFiles(dirCandidate, {
      maxDepth: 4,
      maxFiles: 180,
      acceptFile: (name) => (
        name === "invocation.json"
        || name.endsWith(".watchdog.json")
        || name.endsWith(".envelope.json")
        || name.endsWith(".trace.json")
        || name.endsWith(".meta.json")
        || (name.startsWith("watchdog-") && name.endsWith(".json"))
      ),
    });
    for (const f of walked) files.add(f);
  }

  const processes = [];
  for (const fullPath of files) {
    const parsed = await safeReadJson(fullPath);
    if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") continue;
    const doc = parsed.value;
    const fStat = await safeLstat(fullPath);
    const parentLabel = basename(dirname(fullPath));

    if (doc.kind === "skill-family.watchdog-termination-envelope") {
      const ev = doc.evidence ?? {};
      const startedMs = Date.parse(ev.startedAt ?? "");
      const finishedMs = Date.parse(ev.finishedAt ?? "");
      processes.push({
        id: `wd-env:${fullPath}`,
        targetId: resolvedTarget.id,
        sourceKind: "watchdog-termination-envelope",
        label: `${parentLabel}/${basename(fullPath)}`,
        command: [ev.command, ...(ev.args ?? [])].filter(Boolean).join(" "),
        cwd: ev.cwd ?? null,
        processStatus: normalizeProcessStatus(doc.processStatus, doc.exitStatus),
        ok: Boolean(doc.ok),
        exitStatus: doc.exitStatus ?? ev.childExitCode ?? null,
        watchdogReason: doc.watchdogReason ?? null,
        terminationReason: doc.terminationReason ?? null,
        forcedKill: Boolean(ev.forcedKill),
        pid: ev.pid ?? null,
        processGroupId: ev.processGroupId ?? null,
        startedAt: ev.startedAt ?? null,
        finishedAt: ev.finishedAt ?? null,
        durationMs: Number.isFinite(startedMs) && Number.isFinite(finishedMs) ? Math.max(0, finishedMs - startedMs) : null,
        diagnosticNote: doc.watchdogReason
          ? `Watchdog: ${doc.watchdogReason}${doc.terminationReason ? ` → ${doc.terminationReason}` : ""}${ev.forcedKill ? " (SIGKILL)" : ""}`
          : doc.ok ? "正常退出 (ok=true)" : `非零退出 (exit=${doc.exitStatus ?? "?"})`,
        filePath: fullPath,
        raw: doc,
      });
      continue;
    }

    if (doc.kind === "skill-family.watchdog-supervision-trace") {
      const startedMs = Date.parse(doc.startedAt ?? "");
      processes.push({
        id: `wd-trace:${fullPath}`,
        targetId: resolvedTarget.id,
        sourceKind: "watchdog-supervision-trace",
        label: `${parentLabel}/${basename(fullPath)}`,
        command: [doc.command, ...(doc.args ?? [])].filter(Boolean).join(" "),
        cwd: doc.cwd ?? null,
        processStatus: "RUNNING",
        ok: null,
        exitStatus: null,
        watchdogReason: null,
        terminationReason: null,
        forcedKill: false,
        pid: null,
        processGroupId: null,
        startedAt: doc.startedAt ?? null,
        finishedAt: null,
        durationMs: Number.isFinite(startedMs) ? Math.max(0, nowMs - startedMs) : null,
        diagnosticNote: `监督运行中 (轮询间隔 ${doc.checkIntervalSeconds ?? 1}s)`,
        filePath: fullPath,
        raw: doc,
      });
      continue;
    }

    if (Array.isArray(doc.argv) && typeof doc.status === "string") {
      const startedIso = doc.started_utc ?? null;
      const endedIso = doc.ended_utc ?? null;
      const startedMs = startedIso ? Date.parse(startedIso) : NaN;
      const elapsedMs = typeof doc.elapsed_seconds === "number"
        ? Math.round(doc.elapsed_seconds * 1000)
        : Number.isFinite(startedMs) && !endedIso ? Math.max(0, nowMs - startedMs) : null;
      const pStatus = normalizeProcessStatus(doc.status, doc.exit_code);
      const terminalVerify = await safeReadJson(join(dirname(fullPath), "terminal-root-verification.json"));
      const isLongUnclosed = pStatus === "RUNNING" && !endedIso && Number.isFinite(startedMs) && (nowMs - startedMs) > 12 * 3600 * 1000;
      const cmdPreview = doc.argv.length > 5
        ? `${basename(doc.argv[0])} ${doc.argv.slice(-4).join(" ")}`
        : doc.argv.join(" ");
      processes.push({
        id: `inv:${fullPath}`,
        targetId: resolvedTarget.id,
        sourceKind: "invocation",
        label: parentLabel,
        command: cmdPreview,
        cwd: doc.cwd ?? null,
        version: doc.version ?? null,
        processStatus: pStatus,
        ok: typeof doc.exit_code === "number" ? doc.exit_code === 0 : null,
        exitStatus: doc.exit_code ?? null,
        watchdogReason: isLongUnclosed ? "no_terminal_result" : null,
        terminationReason: null,
        forcedKill: false,
        pid: doc.pid ?? doc.wrapper_pid ?? null,
        processGroupId: null,
        startedAt: startedIso,
        finishedAt: endedIso,
        durationMs: elapsedMs,
        steps: terminalVerify.ok && Array.isArray(terminalVerify.value?.actual_steps) ? terminalVerify.value.actual_steps : null,
        diagnosticNote: isLongUnclosed
          ? "记录停留 RUNNING（缺终态收据，历史会话已外部中断）"
          : typeof doc.exit_code === "number"
            ? doc.exit_code === 0
              ? `正常完成${terminalVerify.ok ? ` · ${terminalVerify.value?.original_steps_passed ?? 0} 步门禁通过` : ""}`
              : `异常退出 (exit_code=${doc.exit_code})`
            : `状态: ${pStatus}`,
        filePath: fullPath,
        raw: terminalVerify.ok ? { invocation: doc, terminalVerification: terminalVerify.value } : doc,
      });
      continue;
    }

    if (fullPath.endsWith(".meta.json") && typeof doc.exit_code === "number") {
      const finishedIso = fStat ? new Date(fStat.mtimeMs).toISOString() : null;
      const durationMs = typeof doc.elapsed_seconds === "number" ? Math.round(doc.elapsed_seconds * 1000) : null;
      const startedIso = fStat && durationMs !== null ? new Date(fStat.mtimeMs - durationMs).toISOString() : finishedIso;
      const cmdLabel = Array.isArray(doc.command)
        ? doc.command.slice(0, 5).join(" ") + (doc.command.length > 5 ? ` (+${doc.command.length - 5})` : "")
        : basename(fullPath, ".meta.json");
      processes.push({
        id: `meta:${fullPath}`,
        targetId: resolvedTarget.id,
        sourceKind: "verification-meta",
        label: `${parentLabel}/${basename(fullPath, ".meta.json")}`,
        command: cmdLabel,
        cwd: dirname(fullPath),
        processStatus: "EXITED",
        ok: doc.exit_code === 0,
        exitStatus: doc.exit_code,
        watchdogReason: null,
        terminationReason: "completed",
        forcedKill: false,
        pid: null,
        processGroupId: null,
        startedAt: startedIso,
        finishedAt: finishedIso,
        durationMs,
        diagnosticNote: doc.exit_code === 0 ? "验证通过" : `验证失败 (exit_code=${doc.exit_code})`,
        filePath: fullPath,
        raw: doc,
      });
    }
  }

  processes.sort((a, b) => (Date.parse(b.finishedAt ?? b.startedAt ?? "") || 0) - (Date.parse(a.finishedAt ?? a.startedAt ?? "") || 0));
  return processes;
}

export async function loadMonitorRegistry(root = ".", registryPath = DEFAULT_REGISTRY_PATH, options = {}) {
  const baseRoot = resolve(root || ".");
  const absPath = isAbsolute(registryPath)
    ? resolveTargetPath(baseRoot, registryPath, { allowedRoots: options.allowedRoots, strict: true })
    : await resolveContained(baseRoot, registryPath);
  let st = await safeLstat(absPath);
  let targetFile = absPath;
  if ((!st || !st.isFile()) && registryPath === DEFAULT_REGISTRY_PATH) {
    try {
      const fallbackAbs = await resolveContained(baseRoot, LEGACY_FALLBACK_REGISTRY_PATH);
      const fallbackStat = await safeLstat(fallbackAbs);
      if (fallbackStat?.isFile()) {
        st = fallbackStat;
        targetFile = fallbackAbs;
      }
    } catch {}
  }
  if (!st || !st.isFile()) {
    return { schemaVersion: 1, updatedAt: null, targets: [] };
  }
  const parsed = await safeReadJson(targetFile);
  if (!parsed.ok || !Array.isArray(parsed.value?.targets)) {
    return { schemaVersion: 1, updatedAt: null, targets: [] };
  }
  return {
    schemaVersion: 1,
    updatedAt: parsed.value.updatedAt ?? null,
    targets: parsed.value.targets,
  };
}

export async function registerMonitorTarget(root = ".", input = {}, registryPath = DEFAULT_REGISTRY_PATH, options = {}) {
  const baseRoot = resolve(root || ".");
  const id = String(input.id ?? "").trim();
  if (!id || FORBIDDEN_OBJECT_KEYS.has(id) || !/^[A-Za-z0-9_.:-]+$/.test(id)) {
    throw createBadRequestError("监控目标 id 须为非空字母、数字、点、冒号或连字符组合，且不得使用保留属性名", { id });
  }
  const title = String(input.title ?? id).trim().slice(0, 160);
  if (!title) {
    throw createBadRequestError("监控目标 title 不能为空");
  }

  const rawStateDir = input.stateDir ? String(input.stateDir).trim() : "";
  const rawPlanPath = input.planPath ? String(input.planPath).trim() : "";
  const rawRunsDir = input.runsDir ? String(input.runsDir).trim() : "";
  const lockPaths = Array.isArray(input.lockPaths)
    ? input.lockPaths.map((p) => String(p).trim()).filter(Boolean)
    : typeof input.lockPath === "string" && input.lockPath.trim() ? [input.lockPath.trim()] : [];

  for (const candidate of [rawStateDir, rawPlanPath, rawRunsDir, ...lockPaths]) {
    if (candidate) {
      resolveTargetPath(baseRoot, candidate, { allowedRoots: options.allowedRoots, strict: true });
    }
  }

  const current = await loadMonitorRegistry(baseRoot, registryPath, options);
  const now = new Date().toISOString();

  const entry = {
    id,
    title,
    badge: String(input.badge ?? "已注册任务").trim().slice(0, 40),
    description: String(input.description ?? "").trim().slice(0, 300),
    ...(rawStateDir ? { stateDir: rawStateDir } : {}),
    ...(rawPlanPath ? { planPath: rawPlanPath } : {}),
    ...(rawRunsDir ? { runsDir: rawRunsDir } : {}),
    ...(lockPaths.length > 0 ? { lockPaths } : {}),
    registeredAt: now,
  };

  const existingIdx = current.targets.findIndex((t) => t.id === id);
  if (existingIdx >= 0) {
    current.targets[existingIdx] = { ...current.targets[existingIdx], ...entry, updatedAt: now };
  } else {
    current.targets.unshift(entry);
  }
  const payload = {
    schemaVersion: 1,
    updatedAt: now,
    targets: current.targets,
  };

  if (isAbsolute(registryPath)) {
    const safeRegAbs = resolveTargetPath(baseRoot, registryPath, { allowedRoots: options.allowedRoots, strict: true });
    await mkdir(dirname(safeRegAbs), { recursive: true });
    await writeFile(safeRegAbs, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } else {
    const absTarget = await resolveContained(baseRoot, registryPath);
    await mkdir(dirname(absTarget), { recursive: true });
    await writeFileAtomic(baseRoot, registryPath, `${JSON.stringify(payload, null, 2)}\n`);
  }

  return { entry: current.targets.find((t) => t.id === id), registry: payload };
}

async function inspectTarget(root, rawTarget, { lockWarnMs = DEFAULT_LOCK_WARN_MS, nowMs = Date.now(), allowedRoots } = {}) {
  const resolvedTarget = {
    id: rawTarget.id,
    title: rawTarget.title || rawTarget.id,
    badge: rawTarget.badge || "运行源",
    description: rawTarget.description || "",
    isSandbox: Boolean(rawTarget.isSandbox),
    stateDir: resolveTargetPath(root, rawTarget.stateDir, { allowedRoots }),
    planPath: resolveTargetPath(root, rawTarget.planPath, { allowedRoots }),
    runsDir: resolveTargetPath(root, rawTarget.runsDir, { allowedRoots }),
    lockPaths: (rawTarget.lockPaths ?? []).map((p) => resolveTargetPath(root, p, { allowedRoots })).filter(Boolean),
    registeredAt: rawTarget.registeredAt ?? null,
  };

  let progress = { format: null, path: resolvedTarget.planPath, exists: false, tasks: [], milestones: [] };
  if (resolvedTarget.planPath) {
    const pStat = await safeLstat(resolvedTarget.planPath);
    if (pStat?.isFile()) {
      const content = await readFile(resolvedTarget.planPath, "utf8");
      const parsed = parseProgressContent(content, extname(resolvedTarget.planPath), basename(resolvedTarget.planPath));
      progress = {
        format: parsed.format,
        path: resolvedTarget.planPath,
        exists: true,
        updatedAt: new Date(pStat.mtimeMs).toISOString(),
        tasks: parsed.tasks.map((t) => ({ ...t, targetId: resolvedTarget.id })),
        milestones: parsed.milestones,
      };
    }
  }

  const [stateStore, locks, processes] = await Promise.all([
    inspectStateStoreReadOnly(resolvedTarget.stateDir, { lockWarnMs, nowMs }),
    scanLocksReadOnly(resolvedTarget, { lockWarnMs, nowMs }),
    scanSupervisedProcessesReadOnly(resolvedTarget, { nowMs }),
  ]);

  const taskSummary = {
    total: progress.tasks.length,
    done: progress.tasks.filter((t) => t.status === "done").length,
    running: progress.tasks.filter((t) => t.status === "running").length,
    todo: progress.tasks.filter((t) => t.status === "todo").length,
    blocked: progress.tasks.filter((t) => t.status === "blocked").length,
  };
  taskSummary.percent = taskSummary.total > 0
    ? Math.round(((taskSummary.done + taskSummary.running * 0.5) / taskSummary.total) * 100)
    : 0;

  return {
    ...resolvedTarget,
    progress,
    taskSummary,
    stateStore,
    locks,
    processes,
  };
}

export async function collectMonitorSnapshot({
  root = ".",
  registryPath = DEFAULT_REGISTRY_PATH,
  lockWarnMs = DEFAULT_LOCK_WARN_MS,
  extraTargets = [],
  targetFilter = null,
  nowMs = Date.now(),
  allowedRoots,
  workbenchUrl = null,
} = {}) {
  const baseRoot = resolve(root || ".");
  const registry = await loadMonitorRegistry(baseRoot, registryPath, { allowedRoots });
  const combined = [...extraTargets, ...registry.targets];
  const deduped = [];
  const seenIds = new Set();
  for (const item of combined) {
    if (!item?.id || seenIds.has(item.id)) continue;
    seenIds.add(item.id);
    deduped.push(item);
  }

  const inspectedTargets = await Promise.all(
    deduped.map((t) => inspectTarget(baseRoot, t, { lockWarnMs, nowMs, allowedRoots })),
  );

  const visibleTargets = targetFilter
    ? inspectedTargets.filter((t) => t.id === targetFilter)
    : inspectedTargets;

  const lockMap = new Map();
  const procMap = new Map();
  const allTasks = [];
  const allEvents = [];
  let maxEventSeq = 0;
  let storeCount = 0;
  let brokenStores = 0;

  for (const target of visibleTargets) {
    allTasks.push(...target.progress.tasks);
    for (const lk of target.locks) {
      if (!lockMap.has(lk.path)) lockMap.set(lk.path, lk);
    }
    for (const pr of target.processes) {
      if (!procMap.has(pr.filePath)) procMap.set(pr.filePath, pr);
    }
    if (target.stateStore?.isStateStore) {
      storeCount += 1;
      if (target.stateStore.lastSequence > maxEventSeq) maxEventSeq = target.stateStore.lastSequence;
      if (target.stateStore.integrity === "CHAIN_BROKEN") brokenStores += 1;
      for (const ev of target.stateStore.events) {
        allEvents.push({ ...ev, targetId: target.id, targetTitle: target.title });
      }
    }
  }

  const locks = [...lockMap.values()];
  const processes = [...procMap.values()];
  allEvents.sort((a, b) => (Date.parse(b.recordedAt ?? "") || 0) - (Date.parse(a.recordedAt ?? "") || 0) || b.sequence - a.sequence);

  const processStatusCounts = Object.fromEntries(PROCESS_STATUSES.map((s) => [s, 0]));
  for (const p of processes) {
    processStatusCounts[p.processStatus] = (processStatusCounts[p.processStatus] ?? 0) + 1;
  }

  const activeLocks = locks.filter((l) => l.isActive);
  const staleWarnLocks = activeLocks.filter((l) => l.isStaleWarning);

  const kpi = {
    targetsCount: visibleTargets.length,
    tasks: {
      total: allTasks.length,
      done: allTasks.filter((t) => t.status === "done").length,
      running: allTasks.filter((t) => t.status === "running").length,
      todo: allTasks.filter((t) => t.status === "todo").length,
      blocked: allTasks.filter((t) => t.status === "blocked").length,
    },
    locks: {
      activeCount: activeLocks.length,
      staleWarnCount: staleWarnLocks.length,
      versionLockCount: locks.filter((l) => l.lockKind === "version-lock").length,
      warnThresholdMs: lockWarnMs,
    },
    processes: {
      total: processes.length,
      counts: processStatusCounts,
    },
    eventChain: {
      storeCount,
      totalEvents: allEvents.length,
      latestSequence: maxEventSeq,
      integrity: brokenStores > 0 ? "CHAIN_BROKEN" : storeCount > 0 ? (allEvents.length > 0 ? "VALID" : "EMPTY") : "NO_STORE",
    },
  };

  return {
    schemaVersion: 1,
    kind: RUNTIME_MONITOR_SNAPSHOT_KIND,
    ok: true,
    foundationVersion: FOUNDATION_PACKAGE_VERSION,
    generatedAt: new Date(nowMs).toISOString(),
    workbenchUrl,
    kpi,
    targets: inspectedTargets.map((t) => ({
      id: t.id,
      title: t.title,
      badge: t.badge,
      description: t.description,
      isSandbox: t.isSandbox,
      stateDir: t.stateDir,
      planPath: t.planPath,
      runsDir: t.runsDir,
      taskSummary: t.taskSummary,
      activeLockCount: t.locks.filter((l) => l.isActive).length,
      processCount: t.processes.length,
      eventCount: t.stateStore?.events?.length ?? 0,
      chainIntegrity: t.stateStore?.integrity ?? "NONE",
      progress: t.progress,
      stateStore: t.stateStore,
      locks: t.locks,
      processes: t.processes,
    })),
    aggregated: {
      locks,
      processes: processes.slice(0, 80),
      events: allEvents.slice(0, 120),
    },
  };
}

export const SANDBOX_PAYLOAD_SCHEMAS = {
  "sandbox.step": {
    1: {
      type: "object",
      additionalProperties: false,
      required: ["step", "status", "timestamp", "message"],
      properties: {
        step: { type: "string" },
        status: { type: "string" },
        timestamp: { type: "string" },
        message: { type: "string" },
      },
    },
  },
};

function sandboxReducer(prev, record) {
  const base = prev ?? { stepsCompleted: 0, lastStep: null, lastStatus: null };
  return {
    stepsCompleted: base.stepsCompleted + 1,
    lastStep: record.payload.step,
    lastStatus: record.payload.status,
  };
}

export async function runSandboxExercise({
  sandboxRoot,
  holdLock = true,
  simulateTimeout = true,
  onStep,
} = {}) {
  const baseTmp = await realpath(tmpdir());
  const rootDir = sandboxRoot
    ? await realpath(sandboxRoot).catch(async () => {
      await mkdir(sandboxRoot, { recursive: true });
      return realpath(sandboxRoot);
    })
    : await mkdtemp(join(baseTmp, "foundation-monitor-sandbox-"));

  const stateDir = join(rootDir, "state-store");
  const locksDir = join(rootDir, "locks");
  const runsDir = join(rootDir, "runs");
  const planPath = join(rootDir, "execution-plan.md");
  await mkdir(locksDir, { recursive: true });
  await mkdir(runsDir, { recursive: true });

  const lockRel = "write-set-m3.lock";
  const existingLock = await inspectFilesystemLock(locksDir, lockRel).catch(() => ({ locked: false }));
  if (existingLock.locked) {
    await rm(join(locksDir, lockRel), { force: true });
  }

  const runTag = `${Date.now()}`;
  await writeFile(
    planPath,
    [
      "# Foundation 运行态沙箱演练计划",
      "",
      "## 阶段里程碑状态",
      "",
      "| 阶段 | 说明 | 当前状态 |",
      "| --- | --- | --- |",
      "| 阶段 1：排他锁获取 | 调用 `acquireFilesystemLock` 锁定并发写集 | [done] |",
      "| 阶段 2：事件溯源写入 | 调用 `openStateStore` 追加哈希链事件与快照 | [process] |",
      `| 阶段 3：子进程监督 | 调用 \`superviseProcess\` 验证正常退出与超时拦截 | ${holdLock ? "[process]" : "[done]"} |`,
      "",
      "## 执行子任务核对单",
      "",
      "- [x] [SBX-01] 初始化隔离沙箱目录与规范路径校验",
      "- [x] [SBX-02] 获取 Foundation `token-lock` 排他令牌锁",
      "- [x] [SBX-03] 追加 `state-store` 事件并校验 `STATE_GENESIS_DIGEST` 链完整性",
      `- [${holdLock ? "/" : "x"}] [SBX-04] 执行受管子进程健康探针与超时保护演练`,
      `- [${holdLock ? " " : "x"}] [SBX-05] 释放并发写集锁并归档演练快照`,
      "",
    ].join("\n"),
    "utf8",
  );

  const lockHandle = await acquireFilesystemLock(locksDir, lockRel, {
    owner: `sandbox-worker-pid-${process.pid}`,
  });
  await onStep?.("lock-acquired");

  const store = await openStateStore(stateDir, {
    owner: `sandbox-engine-${process.pid}`,
    payloadSchemas: SANDBOX_PAYLOAD_SCHEMAS,
  });
  let reducedState = { stepsCompleted: 0, lastStep: null, lastStatus: null };
  try {
    const eventsToAppend = [
      {
        step: "acquire-write-set-lock",
        status: "ACTIVE",
        message: `已获取令牌锁 ${lockHandle.tokenDigest.slice(0, 12)}…`,
      },
      {
        step: "supervise-worker-probe",
        status: "RUNNING",
        message: "启动 Foundation superviseProcess 边界监督探针",
      },
    ];
    for (let i = 0; i < eventsToAppend.length; i += 1) {
      const item = eventsToAppend[i];
      const appended = await appendEvent(store, {
        eventId: `sbx-${runTag}-${i + 1}`,
        eventType: "sandbox.step",
        payloadSchemaVersion: 1,
        producer: "monitor.sandbox",
        idempotencyKey: `idem-${runTag}-${i + 1}`,
        payload: { ...item, timestamp: new Date().toISOString() },
      });
      reducedState = sandboxReducer(reducedState, appended.record);
    }
    const allCurrentEvents = await inspectStateStoreReadOnly(stateDir);
    let fullReduced = null;
    for (const rec of allCurrentEvents.events) {
      fullReduced = sandboxReducer(fullReduced, rec);
    }
    await writeSnapshot(store, fullReduced, {
      reducer: sandboxReducer,
      initial: null,
      hostSessionRef: `sandbox-session-${runTag}`,
    });
  } finally {
    await closeStateStore(store);
  }
  await onStep?.("events-appended");

  await superviseProcess({
    command: process.execPath,
    args: ["-e", 'process.stdout.write("sandbox-healthy-ok\\n")'],
    cwd: rootDir,
    timeoutPolicy: { maxSeconds: 5, killGraceSeconds: 1 },
    checkIntervalSeconds: 0.05,
    evidencePath: join(runsDir, "worker-health-check.watchdog.json"),
  });

  if (simulateTimeout) {
    await superviseProcess({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 10000)"],
      cwd: rootDir,
      timeoutPolicy: { maxSeconds: 0.18, killGraceSeconds: 0.15 },
      checkIntervalSeconds: 0.05,
      evidencePath: join(runsDir, "stuck-subtask-guard.watchdog.json"),
    });
  }
  await onStep?.("processes-supervised");

  if (!holdLock) {
    await releaseFilesystemLock(lockHandle);
    await onStep?.("lock-released");
  }

  const targetEntry = {
    id: "foundation-live-sandbox",
    title: "Foundation 实时沙箱演练",
    badge: "实时沙箱",
    description: "在系统临时目录使用真实 skill-family-harness-node 生成事件链、令牌锁与子进程监督轨迹。",
    isSandbox: true,
    stateDir,
    planPath,
    runsDir,
    lockPaths: [locksDir],
    registeredAt: new Date().toISOString(),
  };

  return {
    sandboxRoot: rootDir,
    targetEntry,
    lockHeld: holdLock,
    releaseLock: holdLock ? () => releaseFilesystemLock(lockHandle) : null,
  };
}

function sendJson(res, statusCode, body) {
  const bytes = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(bytes);
}

function isSafeLoopbackHost(req) {
  const rawHost = req.headers.host;
  if (rawHost === undefined || rawHost === "") return true;
  if (typeof rawHost !== "string") return false;
  const trimmed = rawHost.trim();
  if (!trimmed || /[/?#@\\\s]/.test(trimmed)) return false;
  try {
    const parsed = new URL(`http://${trimmed}`);
    const host = parsed.hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}

function isSafeLoopbackOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const host = parsed.hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
  } catch {
    return false;
  }
}

async function readJsonBody(req, maxBytes = 131072) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw Object.assign(new Error("请求体超过大小限制（上限 128KB）"), { statusCode: 413 });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("JSON 顶层须为对象");
    }
    return parsed;
  } catch (error) {
    throw createBadRequestError(`无效的 JSON 请求载荷：${error.message}`);
  }
}

export async function createRuntimeMonitorServer({
  root = ".",
  port = DEFAULT_MONITOR_PORT,
  registryPath = DEFAULT_REGISTRY_PATH,
  lockWarnMs = DEFAULT_LOCK_WARN_MS,
  allowedRoots,
  workbenchUrl = null,
} = {}) {
  const baseRoot = resolve(root || ".");
  const sseClients = new Set();
  const watchers = new Map();
  let debounceTimer = null;
  let sandboxState = null;
  let writeChain = Promise.resolve();
  const enqueueWrite = (fn) => {
    const next = writeChain.then(fn, fn);
    writeChain = next.catch(() => {});
    return next;
  };
  const getEffectiveAllowedRoots = () => (
    Array.isArray(allowedRoots) && sandboxState?.sandboxRoot
      ? [...allowedRoots, sandboxState.sandboxRoot]
      : allowedRoots
  );

  const broadcast = (event, payload) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(frame);
      } catch {
        sseClients.delete(client);
      }
    }
  };

  const triggerChange = (reason, file = "") => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      broadcast("snapshot-change", { reason, file, at: new Date().toISOString() });
    }, 110);
  };

  const ensureWatchDir = async (dirPath, label) => {
    if (!dirPath || watchers.has(dirPath)) return;
    const st = await safeLstat(dirPath);
    if (!st || !st.isDirectory()) return;
    try {
      const watcher = watchFs(dirPath, { persistent: false }, (_eventType, filename) => {
        triggerChange(label, filename ? String(filename) : "");
      });
      watcher.on("error", () => {});
      watchers.set(dirPath, watcher);
    } catch {}
  };

  const syncWatchers = async () => {
    const currentAllowedRoots = getEffectiveAllowedRoots();
    const absReg = isAbsolute(registryPath)
      ? resolveTargetPath(baseRoot, registryPath, { allowedRoots: currentAllowedRoots })
      : resolve(baseRoot, registryPath);
    if (absReg) await ensureWatchDir(dirname(absReg), "registry");
    const reg = await loadMonitorRegistry(baseRoot, registryPath, { allowedRoots: currentAllowedRoots });
    const allTargets = [...(sandboxState?.targetEntry ? [sandboxState.targetEntry] : []), ...reg.targets];
    for (const t of allTargets) {
      const sDir = resolveTargetPath(baseRoot, t.stateDir, { allowedRoots: currentAllowedRoots });
      if (sDir) {
        await ensureWatchDir(sDir, `state:${t.id}`);
        await ensureWatchDir(join(sDir, "events"), `events:${t.id}`);
        await ensureWatchDir(join(sDir, "snapshots"), `snapshots:${t.id}`);
      }
      const pPath = resolveTargetPath(baseRoot, t.planPath, { allowedRoots: currentAllowedRoots });
      if (pPath) await ensureWatchDir(dirname(pPath), `plan:${t.id}`);
      const rDir = resolveTargetPath(baseRoot, t.runsDir, { allowedRoots: currentAllowedRoots });
      if (rDir) await ensureWatchDir(rDir, `runs:${t.id}`);
      for (const lp of t.lockPaths ?? []) {
        const resolvedLp = resolveTargetPath(baseRoot, lp, { allowedRoots: currentAllowedRoots });
        if (!resolvedLp) continue;
        const lpStat = await safeLstat(resolvedLp);
        if (lpStat?.isDirectory()) await ensureWatchDir(resolvedLp, `locks:${t.id}`);
        else if (lpStat?.isFile()) await ensureWatchDir(dirname(resolvedLp), `locks:${t.id}`);
      }
    }
  };

  await syncWatchers();

  const heartbeat = setInterval(() => {
    for (const client of sseClients) {
      try { client.write(": ping\n\n"); } catch { sseClients.delete(client); }
    }
  }, 18000);
  heartbeat.unref?.();

  const server = createServer(async (req, res) => {
    try {
      if (!isSafeLoopbackHost(req)) {
        sendJson(res, 403, {
          ok: false,
          error: "拒绝非本地回环 Host 请求头（仅允许 127.0.0.1、localhost 或 [::1]）",
        });
        return;
      }

      const url = new URL(req.url ?? "/", "http://localhost");
      const pathname = decodeURIComponent(url.pathname);

      if (pathname === "/api/health") {
        if (req.method !== "GET") {
          sendJson(res, 405, { ok: false, error: "仅支持 GET 请求" });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          service: "runtime-monitor",
          foundationVersion: FOUNDATION_PACKAGE_VERSION,
          pid: process.pid,
          at: new Date().toISOString(),
        });
        return;
      }

      if (pathname === "/api/monitor/events") {
        if (req.method !== "GET") {
          sendJson(res, 405, { ok: false, error: "仅支持 GET 请求" });
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.write(`event: connected\ndata: ${JSON.stringify({ ok: true, at: new Date().toISOString() })}\n\n`);
        sseClients.add(res);
        req.on("close", () => sseClients.delete(res));
        return;
      }

      if (pathname === "/api/monitor/snapshot" || pathname === "/api/snapshot") {
        if (req.method !== "GET") {
          sendJson(res, 405, { ok: false, error: "仅支持 GET 请求" });
          return;
        }
        await syncWatchers();
        const customWarn = url.searchParams.get("lockWarnMs");
        const effectiveWarn = customWarn !== null && Number.isFinite(Number(customWarn)) && Number(customWarn) >= 0
          ? Number(customWarn)
          : lockWarnMs;
        const snapshot = await collectMonitorSnapshot({
          root: baseRoot,
          registryPath,
          lockWarnMs: effectiveWarn,
          extraTargets: sandboxState?.targetEntry ? [sandboxState.targetEntry] : [],
          targetFilter: url.searchParams.get("target") || null,
          allowedRoots: getEffectiveAllowedRoots(),
          workbenchUrl,
        });
        sendJson(res, 200, snapshot);
        return;
      }

      if (pathname === "/api/monitor/register") {
        if (req.method !== "POST") {
          sendJson(res, 405, { ok: false, error: "仅支持 POST 请求" });
          return;
        }
        if (!isSafeLoopbackOrigin(req)) {
          sendJson(res, 403, { ok: false, error: "拒绝非本地回环来源的注册请求" });
          return;
        }
        const body = await readJsonBody(req);
        const { entry, registry } = await enqueueWrite(async () => {
          const result = await registerMonitorTarget(baseRoot, body, registryPath, { allowedRoots });
          await syncWatchers();
          return result;
        });
        broadcast("registry-change", { id: entry.id, updatedAt: registry.updatedAt });
        triggerChange("register", entry.id);
        sendJson(res, 200, { ok: true, entry, updatedAt: registry.updatedAt, totalTargets: registry.targets.length });
        return;
      }

      if (pathname === "/api/monitor/sandbox" || pathname === "/api/monitor/demo") {
        if (req.method !== "POST") {
          sendJson(res, 405, { ok: false, error: "仅支持 POST 请求" });
          return;
        }
        if (!isSafeLoopbackOrigin(req)) {
          sendJson(res, 403, { ok: false, error: "拒绝非本地回环来源的演练请求" });
          return;
        }
        const body = await readJsonBody(req);
        const action = body.action ?? "run";
        const responsePayload = await enqueueWrite(async () => {
          if (action === "release-lock") {
            if (sandboxState?.releaseLock) {
              await sandboxState.releaseLock().catch(() => {});
              sandboxState.releaseLock = null;
              sandboxState.lockHeld = false;
              if (sandboxState.targetEntry?.planPath) {
                const oldPlan = await readFile(sandboxState.targetEntry.planPath, "utf8").catch(() => "");
                if (oldPlan) {
                  await writeFile(
                    sandboxState.targetEntry.planPath,
                    oldPlan.replaceAll("[/]", "[x]").replaceAll("[ ]", "[x]").replaceAll("[process]", "[done]"),
                    "utf8",
                  );
                }
              }
            }
            triggerChange("sandbox-lock-released");
            return { ok: true, action: "release-lock", lockHeld: false };
          }
          if (action === "reset") {
            if (sandboxState?.releaseLock) await sandboxState.releaseLock().catch(() => {});
            if (sandboxState?.sandboxRoot) await rm(sandboxState.sandboxRoot, { recursive: true, force: true }).catch(() => {});
            sandboxState = null;
            triggerChange("sandbox-reset");
            return { ok: true, action: "reset" };
          }
          if (sandboxState?.releaseLock) {
            await sandboxState.releaseLock().catch(() => {});
            sandboxState.releaseLock = null;
          }
          const holdLock = body.holdLock !== undefined ? Boolean(body.holdLock) : true;
          sandboxState = await runSandboxExercise({
            sandboxRoot: sandboxState?.sandboxRoot,
            holdLock,
            simulateTimeout: body.simulateTimeout !== false,
            onStep: async (stepName) => {
              await syncWatchers();
              broadcast("snapshot-change", { reason: `sandbox:${stepName}`, at: new Date().toISOString() });
            },
          });
          await syncWatchers();
          triggerChange("sandbox-ready");
          return {
            ok: true,
            action: "run",
            sandboxRoot: sandboxState.sandboxRoot,
            targetId: sandboxState.targetEntry.id,
            lockHeld: sandboxState.lockHeld,
          };
        });
        sendJson(res, 200, responsePayload);
        return;
      }

      if (!["GET", "HEAD"].includes(req.method ?? "GET")) {
        res.writeHead(405);
        res.end();
        return;
      }

      if (pathname === "/") {
        const headlessInfo = Buffer.from(
          `${JSON.stringify({
            ok: true,
            service: "runtime-monitor",
            mode: "headless-json",
            message: "Foundation 仅提供无界面运行态 JSON 快照与登记接口；可视化工作台已委托至 skill-family-studio。",
            endpoints: ["/api/health", "/api/monitor/snapshot", "/api/monitor/register", "/api/monitor/events"],
          }, null, 2)}\n`,
          "utf8",
        );
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-cache",
          "X-Content-Type-Options": "nosniff",
        });
        res.end(req.method === "HEAD" ? undefined : headlessInfo);
        return;
      }

      sendJson(res, 404, {
        ok: false,
        mode: "headless-json",
        error: "Foundation 不再内嵌网页前端资源；请安装并启动 skill-family-studio 查看可视化监控工作台。",
      });
      return;
    } catch (error) {
      const code = error?.statusCode;
      if (code) {
        sendJson(res, code, { ok: false, error: error.message });
      } else {
        sendJson(res, 500, { ok: false, error: error?.message ?? "运行态监控服务内部错误" });
      }
    }
  });

  server.on("close", () => {
    clearInterval(heartbeat);
    clearTimeout(debounceTimer);
    for (const watcher of watchers.values()) {
      try { watcher.close(); } catch {}
    }
    watchers.clear();
    for (const client of sseClients) {
      try { client.end(); } catch {}
    }
    sseClients.clear();
    if (sandboxState?.sandboxRoot) {
      rm(sandboxState.sandboxRoot, { recursive: true, force: true }).catch(() => {});
      sandboxState = null;
    }
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", resolveListen);
  });

  return {
    server,
    port: server.address().port,
    url: formatLoopbackUrl(server.address().port),
    refreshWatchers: syncWatchers,
  };
}

function loopbackJsonRequest({ port, method = "GET", path: reqPath = "/api/health", body = null, timeoutMs = 1500 }) {
  return new Promise((resolveReq, rejectReq) => {
    const payload = body !== null ? Buffer.from(JSON.stringify(body), "utf8") : null;
    const req = httpRequest({
      host: LOOPBACK_IPV4,
      port,
      path: reqPath,
      method,
      agent: false,
      headers: {
        Host: `${LOOPBACK_IPV4}:${port}`,
        ...(method !== "GET" && method !== "HEAD" ? { "X-Studio-Request": "1" } : {}),
        ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed = null;
        try { parsed = JSON.parse(text); } catch {}
        resolveReq({ statusCode: res.statusCode ?? 0, body: parsed, text });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("loopback request timeout")));
    req.on("error", rejectReq);
    if (payload) req.write(payload);
    req.end();
  });
}

function isResolvableFile(candidateAbs) {
  try {
    return existsSync(candidateAbs) && statSync(candidateAbs).isFile();
  } catch {
    return false;
  }
}

function buildStudioLaunchSpec(executableAbs, source) {
  let realTarget = executableAbs;
  try {
    realTarget = realpathSync(executableAbs);
  } catch {}
  const lowerExec = executableAbs.toLowerCase();
  const lowerReal = realTarget.toLowerCase();
  const isNodeScript =
    lowerReal.endsWith(".mjs") || lowerReal.endsWith(".js") || lowerReal.endsWith(".cjs")
    || lowerExec.endsWith(".mjs") || lowerExec.endsWith(".js") || lowerExec.endsWith(".cjs");
  if (isNodeScript || (process.platform === "win32" && !lowerExec.endsWith(".exe") && !lowerExec.endsWith(".cmd"))) {
    return {
      found: true,
      source,
      executable: executableAbs,
      command: process.execPath,
      argvPrefix: [realTarget],
    };
  }
  return {
    found: true,
    source,
    executable: executableAbs,
    command: executableAbs,
    argvPrefix: [],
  };
}

function resolveStudioEntryInRepoDir(repoDirAbs, sourceLabel) {
  try {
    if (!existsSync(repoDirAbs) || !statSync(repoDirAbs).isDirectory()) return null;
    for (const pkgRel of ["packages/skill-family-studio/package.json", "package.json"]) {
      const pkgPath = join(repoDirAbs, pkgRel);
      if (!existsSync(pkgPath)) continue;
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      const binField = typeof pkg?.bin === "string" ? pkg.bin : pkg?.bin?.["skill-family-studio"];
      if (typeof binField === "string" && binField.length > 0) {
        const resolvedBin = resolve(dirname(pkgPath), binField);
        if (isResolvableFile(resolvedBin)) {
          return buildStudioLaunchSpec(resolvedBin, sourceLabel);
        }
      }
    }
    const relEntries = [
      "packages/skill-family-studio/bin/skill-family-studio.mjs",
      "packages/skill-family-studio/src/cli.mjs",
      "bin/skill-family-studio.mjs",
      "src/cli.mjs",
    ];
    for (const rel of relEntries) {
      const entryAbs = join(repoDirAbs, rel);
      if (isResolvableFile(entryAbs)) {
        return buildStudioLaunchSpec(entryAbs, sourceLabel);
      }
    }
  } catch {}
  return null;
}

export function resolveSkillFamilyStudio({
  root = ".",
  env = process.env,
  studioBin = null,
} = {}) {
  const explicitBin = studioBin ?? env?.SKILL_FAMILY_STUDIO_BIN ?? "";
  if (typeof explicitBin === "string" && explicitBin.trim().length > 0) {
    const absBin = resolve(explicitBin.trim());
    if (isResolvableFile(absBin)) {
      return buildStudioLaunchSpec(absBin, "SKILL_FAMILY_STUDIO_BIN");
    }
    return {
      found: false,
      source: null,
      executable: null,
      configuredBin: absBin,
      message: `环境变量 SKILL_FAMILY_STUDIO_BIN 指向的路径不存在或不可执行（${absBin}）；已回退为无界面运行态 JSON 状态摘要模式。`,
    };
  }

  const baseRoot = resolve(root || ".");
  const binNames = process.platform === "win32"
    ? ["skill-family-studio.cmd", "skill-family-studio.exe", "skill-family-studio"]
    : ["skill-family-studio"];

  const localBinDir = join(baseRoot, "node_modules", ".bin");
  for (const binName of binNames) {
    const localCandidate = join(localBinDir, binName);
    if (isResolvableFile(localCandidate)) {
      return buildStudioLaunchSpec(localCandidate, "local-node-modules");
    }
  }

  const pathSep = process.platform === "win32" ? ";" : ":";
  const pathDirs = String(env?.PATH ?? "").split(pathSep).filter(Boolean);
  for (const dir of pathDirs) {
    for (const binName of binNames) {
      const candidate = join(dir, binName);
      if (isResolvableFile(candidate)) {
        return buildStudioLaunchSpec(candidate, "PATH");
      }
    }
  }

  const disablePkgSibling = env?.SF_DISABLE_WORKSPACE_SIBLING_DISCOVERY === "1";
  const workspaceSiblings = [
    join(dirname(baseRoot), "skill-family-studio-workspace"),
    ...(disablePkgSibling ? [] : [join(dirname(WORKSPACE_PACKAGE_PARENT), "skill-family-studio-workspace")]),
  ];
  for (const wsDir of workspaceSiblings) {
    const hit = resolveStudioEntryInRepoDir(wsDir, "sibling-workspace");
    if (hit) return hit;
  }

  const publicRepoSiblings = [
    join(dirname(baseRoot), "skill-family-studio"),
    ...(disablePkgSibling ? [] : [join(dirname(WORKSPACE_PACKAGE_PARENT), "skill-family-studio")]),
  ];
  for (const repoDir of publicRepoSiblings) {
    const hit = resolveStudioEntryInRepoDir(repoDir, "sibling-studio");
    if (hit) return hit;
  }

  return {
    found: false,
    source: null,
    executable: null,
    message: STUDIO_UNAVAILABLE_HINT,
  };
}

function detectStudioSupportedOptionalFlags(studio, env) {
  const supported = new Set();
  try {
    const helpRun = spawnSync(studio.command, [...studio.argvPrefix, "--help"], {
      encoding: "utf8",
      timeout: 2500,
      env: { ...env },
    });
    if (helpRun.status === 0) {
      const text = `${helpRun.stdout ?? ""}\n${helpRun.stderr ?? ""}`;
      for (const flag of ["--registry", "--lock-warn-ms", "--allowed-root"]) {
        if (new RegExp(`(?:^|\\s)${flag}(?:\\s|=|,|$)`, "m").test(text)) {
          supported.add(flag);
        }
      }
    }
  } catch {}
  return supported;
}

export function buildStudioServeArgs(studio, {
  baseRoot,
  port,
  explicitRegistryPath = undefined,
  explicitLockWarnMs = undefined,
  explicitAllowedRoots = undefined,
  env = process.env,
}) {
  const args = [
    ...studio.argvPrefix,
    "serve",
    "--root",
    baseRoot,
    "--port",
    String(port),
    "--tab",
    "runtime",
  ];
  const wantsRegistry = typeof explicitRegistryPath === "string" && explicitRegistryPath.length > 0;
  const wantsLockWarn = Number.isInteger(explicitLockWarnMs) && explicitLockWarnMs >= 0;
  const wantsAllowedRoots = Array.isArray(explicitAllowedRoots) && explicitAllowedRoots.length > 0;
  if (wantsRegistry || wantsLockWarn || wantsAllowedRoots) {
    const supported = detectStudioSupportedOptionalFlags(studio, env);
    if (wantsRegistry && supported.has("--registry")) {
      args.push("--registry", explicitRegistryPath);
    }
    if (wantsLockWarn && supported.has("--lock-warn-ms")) {
      args.push("--lock-warn-ms", String(explicitLockWarnMs));
    }
    if (wantsAllowedRoots && supported.has("--allowed-root")) {
      for (const r of explicitAllowedRoots) args.push("--allowed-root", String(r));
    }
  }
  return args;
}

export async function probeRuntimeMonitorHealth(port = DEFAULT_MONITOR_PORT, { timeoutMs = 1200 } = {}) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return { online: false, port };
  try {
    const res = await loopbackJsonRequest({ port, method: "GET", path: "/api/health", timeoutMs });
    const svc = res.body?.service;
    if (res.statusCode === 200 && res.body?.ok === true && (svc === "runtime-monitor" || svc === "skill-family-studio")) {
      return {
        online: true,
        port,
        service: svc,
        pid: res.body.pid ?? null,
        foundationVersion: res.body.foundationVersion ?? null,
      };
    }
    return { online: false, port, statusCode: res.statusCode };
  } catch {
    return { online: false, port };
  }
}

function parsePortFromStudioLog(logText) {
  if (!logText) return null;
  for (const rawLine of String(logText).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line);
      if (Number.isInteger(parsed?.port) && parsed.port > 0 && parsed.port <= 65535) {
        return parsed.port;
      }
    } catch {}
  }
  return null;
}

export async function ensureRuntimeMonitor(rawOptions = {}) {
  const {
    root = ".",
    port = DEFAULT_MONITOR_PORT,
    target = null,
    spawnIfOffline = true,
    timeoutMs = 6000,
    allowedRoots,
    env = process.env,
    studioBin = null,
  } = rawOptions;
  const registryPath = rawOptions.registryPath ?? DEFAULT_REGISTRY_PATH;
  const lockWarnMs = rawOptions.lockWarnMs ?? DEFAULT_LOCK_WARN_MS;
  const explicitRegistryPath = rawOptions.registryPath !== undefined ? rawOptions.registryPath : undefined;
  const explicitLockWarnMs = rawOptions.lockWarnMs !== undefined ? rawOptions.lockWarnMs : undefined;

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw invalidParamsError("--port 必须是 0 至 65535 之间的整数", { flag: "--port", port });
  }
  const baseRoot = resolve(root || ".");
  const hasTarget = Boolean(target && typeof target === "object" && String(target.id ?? "").trim());
  if (hasTarget) {
    for (const candidate of [target.stateDir, target.planPath, target.runsDir, ...(target.lockPaths ?? [])]) {
      if (candidate) resolveTargetPath(baseRoot, String(candidate), { allowedRoots, strict: true });
    }
  }

  const registerViaHttpOrLocal = async (activePort) => {
    if (!hasTarget) return null;
    try {
      const regRes = await loopbackJsonRequest({
        port: activePort,
        method: "POST",
        path: "/api/monitor/register",
        body: target,
        timeoutMs: Math.max(2000, timeoutMs),
      });
      if (regRes.statusCode === 403) {
        throw createForbiddenPathError(regRes.body?.error || "监控服务拒绝越界或敏感目标路径", 403);
      }
      if (regRes.statusCode === 200 && regRes.body?.ok) {
        return regRes.body.entry;
      }
      if (regRes.statusCode !== 404) {
        throw kitError(KIT_ERROR_KINDS.MONITOR_OPERATION_FAILED, regRes.body?.error || `注册监控目标失败 (HTTP ${regRes.statusCode})`);
      }
    } catch (err) {
      if (err?.code?.startsWith?.("SFC")) throw err;
    }
    const localReg = await registerMonitorTarget(baseRoot, target, registryPath, { allowedRoots });
    return localReg.entry;
  };

  if (port > 0) {
    const health = await probeRuntimeMonitorHealth(port);
    if (health.online) {
      const registered = await registerViaHttpOrLocal(port);
      const isStudio = health.service === "skill-family-studio";
      return {
        ok: true,
        status: "reused",
        reused: true,
        spawned: false,
        delegatedTo: health.service ?? "runtime-monitor",
        pid: health.pid,
        port,
        url: formatLoopbackUrl(port, isStudio ? "?tab=runtime" : ""),
        registered,
      };
    }
  }

  const localReg = hasTarget ? await registerMonitorTarget(baseRoot, target, registryPath, { allowedRoots }) : null;

  if (!spawnIfOffline) {
    return {
      ok: true,
      status: "offline",
      reused: false,
      spawned: false,
      delegatedTo: null,
      pid: null,
      port,
      url: port > 0 ? formatLoopbackUrl(port) : null,
      registered: localReg?.entry ?? null,
    };
  }

  const studio = resolveSkillFamilyStudio({ root: baseRoot, env, studioBin });
  if (!studio.found) {
    const snapshot = await collectMonitorSnapshot({
      root: baseRoot,
      registryPath,
      lockWarnMs,
      allowedRoots,
    });
    return {
      ok: true,
      status: "studio-unavailable-headless-fallback",
      reused: false,
      spawned: false,
      delegatedTo: null,
      pid: null,
      port,
      url: null,
      message: studio.message,
      registered: localReg?.entry ?? null,
      snapshotSummary: snapshot.kpi,
    };
  }

  const readyDir = await mkdtemp(join(await realpath(tmpdir()), "sf-monitor-ready-"));
  const readyFile = join(readyDir, "ready.json");
  const outLogFile = join(readyDir, "studio-out.log");
  try {
    const childArgs = buildStudioServeArgs(studio, {
      baseRoot,
      port,
      explicitRegistryPath,
      explicitLockWarnMs,
      explicitAllowedRoots: allowedRoots,
      env,
    });
    const outFd = openSync(outLogFile, "a");
    let childExitCode = null;
    const child = spawn(studio.command, childArgs, {
      cwd: baseRoot,
      detached: true,
      stdio: ["ignore", outFd, outFd],
      env: { ...env, SF_MONITOR_READY_FILE: readyFile },
    });
    child.once("exit", (code) => {
      childExitCode = code ?? 1;
    });
    child.unref();
    closeSync(outFd);

    const deadline = Date.now() + timeoutMs;
    let actualPort = port > 0 ? port : null;
    let readyPid = child.pid ?? null;
    let online = false;
    while (Date.now() < deadline) {
      const readyParsed = await safeReadJson(readyFile);
      if (readyParsed.ok && Number.isInteger(readyParsed.value?.port) && readyParsed.value.port > 0) {
        actualPort = readyParsed.value.port;
        readyPid = readyParsed.value.pid ?? readyPid;
      }
      if (!actualPort) {
        try {
          const logPort = parsePortFromStudioLog(await readFile(outLogFile, "utf8"));
          if (logPort) actualPort = logPort;
        } catch {}
      }
      if (actualPort && actualPort > 0) {
        const probe = await probeRuntimeMonitorHealth(actualPort, { timeoutMs: 800 });
        if (probe.online) {
          online = true;
          readyPid = probe.pid ?? readyPid;
          break;
        }
      }
      if (childExitCode !== null) break;
      await new Promise((r) => setTimeout(r, 45));
    }
    if (!online || !actualPort) {
      try { if (child.pid && childExitCode === null) process.kill(child.pid, "SIGTERM"); } catch {}
      let logDetail = "";
      try { logDetail = (await readFile(outLogFile, "utf8")).trim(); } catch {}
      const reason = childExitCode !== null
        ? `委托拉起 skill-family-studio 异常退出 (rc=${childExitCode})${logDetail ? `: ${logDetail}` : ""}`
        : `委托拉起 skill-family-studio 超时（>${timeoutMs}ms）`;
      throw kitError(KIT_ERROR_KINDS.MONITOR_OPERATION_FAILED, reason);
    }
    const httpRegistered = hasTarget ? await registerViaHttpOrLocal(actualPort) : null;
    return {
      ok: true,
      status: "spawned",
      reused: false,
      spawned: true,
      delegatedTo: "skill-family-studio",
      studioSource: studio.source,
      studioExecutable: studio.executable,
      delegatedArgs: childArgs.slice(studio.argvPrefix.length),
      pid: readyPid,
      port: actualPort,
      url: formatLoopbackUrl(actualPort, "?tab=runtime"),
      registered: httpRegistered ?? localReg?.entry ?? null,
    };
  } finally {
    await rm(readyDir, { recursive: true, force: true }).catch(() => {});
  }
}


export async function serveRuntimeMonitorViaStudio(rawOptions = {}) {
  const {
    root = ".",
    port = DEFAULT_MONITOR_PORT,
    allowedRoots,
    workbenchUrl = null,
    env = process.env,
    studioBin = null,
  } = rawOptions;
  const registryPath = rawOptions.registryPath ?? DEFAULT_REGISTRY_PATH;
  const lockWarnMs = rawOptions.lockWarnMs ?? DEFAULT_LOCK_WARN_MS;
  const explicitRegistryPath = rawOptions.registryPath !== undefined ? rawOptions.registryPath : undefined;
  const explicitLockWarnMs = rawOptions.lockWarnMs !== undefined ? rawOptions.lockWarnMs : undefined;

  const baseRoot = resolve(root || ".");
  const studio = resolveSkillFamilyStudio({ root: baseRoot, env, studioBin });
  if (!studio.found) {
    const snapshot = await collectMonitorSnapshot({
      root: baseRoot,
      registryPath,
      lockWarnMs,
      allowedRoots,
      workbenchUrl,
    });
    return {
      ok: true,
      delegated: false,
      status: "studio-unavailable-headless-fallback",
      delegatedTo: null,
      message: studio.message,
      registryPath,
      snapshot,
    };
  }

  const childArgs = buildStudioServeArgs(studio, {
    baseRoot,
    port,
    explicitRegistryPath,
    explicitLockWarnMs,
    explicitAllowedRoots: allowedRoots,
    env,
  });
  const exitResult = await new Promise((resolveExit, rejectExit) => {
    const child = spawn(studio.command, childArgs, {
      cwd: baseRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...env },
    });
    child.stdout.on("data", (c) => process.stdout.write(c));
    child.stderr.on("data", (c) => process.stderr.write(c));
    const forwardSig = (sig) => { try { child.kill(sig); } catch {} };
    const onSigint = () => forwardSig("SIGINT");
    const onSigterm = () => forwardSig("SIGTERM");
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    child.on("error", (err) => {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
      rejectExit(err);
    });
    child.on("close", (code) => {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
      resolveExit({ exitCode: code ?? 0 });
    });
  });

  return {
    ok: exitResult.exitCode === 0,
    delegated: true,
    status: "delegated-studio",
    delegatedTo: "skill-family-studio",
    studioSource: studio.source,
    studioExecutable: studio.executable,
    delegatedArgs: childArgs.slice(studio.argvPrefix.length),
    exitCode: exitResult.exitCode,
  };
}
