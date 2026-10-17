import { lstat, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";
import {
  createFilesystemRootBinding,
  readFileBound,
} from "skill-family-harness-node";
import { bundledHostProfilesRoot, describeHost } from "./host-profiles.mjs";
import {
  matchNativeHost,
  NATIVE_HOSTS,
  nativeLimitations,
  nativeRuleSources,
  runNativeHostLoadingCheck,
} from "./host-loading-native.mjs";
import { KIT_TOOL_NAME, KIT_VERSION } from "./skeleton.mjs";

/**
 * Codex CLI 0.154.0 project-root skill loading check.
 *
 * Oracle: rust-v0.154.0 commit 6b9826e3aa83b1a5947db50f4332cb9c65f1b340.
 * Scope: pathCategory codex-project-skills → <project>/.agents/skills.
 * Daily run is read-only: no spawn, network, or filesystem writes.
 */

export const HOST_LOADING_CHECK_REPORT_KIND = "skill-family.host-loading-check-report";
export const HOST_LOADING_SUPPORTED_HOST_ID = "codex";
export const HOST_LOADING_SUPPORTED_HOST_VERSION = "0.154.0";
export const HOST_LOADING_SUPPORTED_PATH_CATEGORY = "codex-project-skills";
export const HOST_LOADING_SUPPORTED_REL_PATH = ".agents/skills";

const MAX_NAME_LEN = 64;
const MAX_INTERFACE_DESCRIPTION_LEN = 1024;
const MAX_SCAN_DEPTH = 6;
const MAX_SKILLS_DIRS_PER_ROOT = 2000;
const MAX_SKILLS_ENTRIES_PER_ROOT = 20_000;
const SKILLS_FILENAME = "SKILL.md";
const SKILLS_METADATA_DIR = "agents";
const SKILLS_METADATA_FILENAME = "openai.yaml";
const CALIBRATED_PRODUCT = "codex";
const PRODUCT_ALIASES = new Set(["codex", "chatgpt", "atlas", "CODEX", "CHATGPT", "ATLAS"]);
const FRONTMATTER_FIELDS = new Set(["name", "description", "metadata"]);
const METADATA_FIELDS = new Set(["short-description"]);
const METADATA_FILE_FIELDS = new Set(["interface", "dependencies", "policy"]);
const INTERFACE_FIELDS = new Set([
  "display_name",
  "short_description",
  "icon_small",
  "icon_large",
  "brand_color",
  "default_prompt",
]);
const POLICY_FIELDS = new Set(["allow_implicit_invocation", "products"]);
const DEPENDENCY_FIELDS = new Set(["tools"]);
const DEPENDENCY_TOOL_FIELDS = new Set(["type", "value", "description", "transport", "command", "url", "oauth"]);
const OAUTH_FIELDS = new Set(["callbackPort", "callback_port"]);

const LIMITATIONS = Object.freeze([
  "Only Codex CLI 0.154.0 and pathCategory codex-project-skills are calibrated.",
  "The check covers one explicit project root/.agents/skills; it does not claim the whole host skill environment.",
  "Directory symlinks are recorded as uncovered because this slice does not follow them.",
  "Interface icon asset resolution is uncovered; this slice does not open skill assets.",
  "Caller-supplied activationRules are the only enablement input; project-layer config.toml is not read.",
]);

const NATIVE_POLICY = "host loading check is diagnosis only: it reads the selected project skill container through the existing root binding and never writes, spawns, or contacts a network";

function uncovered(kind, message, extra = {}) {
  return { class: "host-loading", kind, message, ...extra };
}

function finding(kind, message, extra = {}) {
  return { class: "host-loading", kind, message, blocking: true, ...extra };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rustIsWhitespace(codePoint) {
  return (
    codePoint === 0x09 ||
    codePoint === 0x0a ||
    codePoint === 0x0b ||
    codePoint === 0x0c ||
    codePoint === 0x0d ||
    codePoint === 0x20 ||
    codePoint === 0x85 ||
    codePoint === 0xa0 ||
    codePoint === 0x1680 ||
    (codePoint >= 0x2000 && codePoint <= 0x200a) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    codePoint === 0x202f ||
    codePoint === 0x205f ||
    codePoint === 0x3000
  );
}

function rustTrim(value) {
  const points = [...value];
  let start = 0;
  let end = points.length;
  while (start < end && rustIsWhitespace(points[start].codePointAt(0))) start += 1;
  while (end > start && rustIsWhitespace(points[end - 1].codePointAt(0))) end -= 1;
  return points.slice(start, end).join("");
}

function rustTrimStart(value) {
  const points = [...value];
  let start = 0;
  while (start < points.length && rustIsWhitespace(points[start].codePointAt(0))) start += 1;
  return points.slice(start).join("");
}

function rustTrimEnd(value) {
  const points = [...value];
  let end = points.length;
  while (end > 0 && rustIsWhitespace(points[end - 1].codePointAt(0))) end -= 1;
  return points.slice(0, end).join("");
}

function rustSplitWhitespace(value) {
  const parts = [];
  let current = [];
  for (const character of [...value]) {
    if (rustIsWhitespace(character.codePointAt(0))) {
      if (current.length > 0) {
        parts.push(current.join(""));
        current = [];
      }
    } else {
      current.push(character);
    }
  }
  if (current.length > 0) parts.push(current.join(""));
  return parts;
}

function sanitizeSingleLine(raw) {
  return rustSplitWhitespace(raw).join(" ");
}

function decodeUtf8PreserveBom(bytes) {
  // Node's ignoreBOM:true keeps U+FEFF in the string so rustTrim can reject a BOM
  // the same way Codex does. ignoreBOM:false (the default) strips it.
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

function positionOf(text, offset) {
  let line = 1;
  let column = 1;
  const end = Math.min(Math.max(offset ?? 0, 0), text.length);
  for (let index = 0; index < end; index += 1) {
    if (text[index] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

function yamlTypeNameFromNode(node) {
  if (node == null) return "unit value";
  if (isSeq(node)) return "sequence";
  if (isMap(node)) return "map";
  if (!isScalar(node)) return "unknown-shaped YAML node";
  if (node.value === null) return "unit value";
  if (typeof node.value === "boolean") return "boolean";
  if (typeof node.value === "number") return Number.isInteger(node.value) ? "integer" : "float";
  if (typeof node.value === "bigint") return "integer";
  if (typeof node.value === "string") return "string";
  return "unknown-shaped YAML scalar";
}

function nodeOffset(node) {
  if (node && Array.isArray(node.range) && Number.isInteger(node.range[0])) return node.range[0];
  return 0;
}

function invalidTypeMessage(field, node, yamlText, expected) {
  const got = yamlTypeNameFromNode(node);
  if (got.startsWith("unknown-shaped")) {
    return { uncovered: true, reason: got };
  }
  const position = positionOf(yamlText, nodeOffset(node));
  return {
    message: `invalid YAML: ${field}: invalid type: ${got}, expected ${expected} at line ${position.line} column ${position.column}`,
  };
}

function parseYamlDocument(text) {
  return parseDocument(text, { uniqueKeys: false, strict: false, prettyErrors: true });
}

function parseYamlValue(text) {
  try {
    const document = parseYamlDocument(text);
    if (document.errors.length > 0) return undefined;
    return document.toJS({ mapAsMap: false });
  } catch {
    return undefined;
  }
}

function extractFrontmatter(contents) {
  const lines = contents.split("\n");
  if (lines.length === 0 || rustTrim(lines[0]) !== "---") return null;
  const frontmatterLines = [];
  let foundClosing = false;
  for (let index = 1; index < lines.length; index += 1) {
    if (rustTrim(lines[index]) === "---") {
      foundClosing = true;
      break;
    }
    frontmatterLines.push(lines[index]);
  }
  if (frontmatterLines.length === 0 || !foundClosing) return null;
  return frontmatterLines.join("\n");
}

function repairFrontmatterScalarFields(frontmatter) {
  let changed = false;
  let blockScalarIndent;
  const repairedLines = [];
  for (const line of frontmatter.split("\n")) {
    const indent = [...line].findIndex((character) => character !== " ");
    const indentCount = indent === -1 ? line.length : indent;
    if (blockScalarIndent !== undefined) {
      if (rustTrim(line) === "" || indentCount > blockScalarIndent) {
        repairedLines.push(line);
        continue;
      }
      blockScalarIndent = undefined;
    }
    const colon = line.indexOf(":");
    if (colon < 0) {
      repairedLines.push(line);
      continue;
    }
    const key = line.slice(0, colon);
    const value = line.slice(colon + 1);
    const keyTrimmed = rustTrim(key);
    const firstValuePoint = value.length === 0 ? undefined : value.codePointAt(0);
    if (keyTrimmed === "" || (value.length > 0 && !rustIsWhitespace(firstValuePoint))) {
      repairedLines.push(line);
      continue;
    }
    const trimmedStart = rustTrimStart(value);
    const leadingWhitespace = value.slice(0, value.length - trimmedStart.length);
    let scalar = trimmedStart;
    let comment = "";
    const chars = [...trimmedStart];
    let offset = 0;
    for (let index = 0; index < chars.length; index += 1) {
      const character = chars[index];
      const previous = index === 0 ? undefined : chars[index - 1];
      if (
        character === "#" &&
        (index === 0 || rustIsWhitespace(previous.codePointAt(0)))
      ) {
        const commentStart = rustTrimEnd(trimmedStart.slice(0, offset)).length;
        scalar = trimmedStart.slice(0, commentStart);
        comment = trimmedStart.slice(commentStart);
        break;
      }
      offset += character.length;
    }
    scalar = rustTrimEnd(scalar);
    const firstChar = scalar[0];
    if (firstChar === undefined) {
      repairedLines.push(line);
      continue;
    }
    if (firstChar === "|" || firstChar === ">") {
      blockScalarIndent = indentCount;
      repairedLines.push(line);
      continue;
    }
    if (firstChar === "'" || firstChar === '"') {
      repairedLines.push(line);
      continue;
    }
    let hasColonSeparator = false;
    for (let index = 0; index < scalar.length; index += 1) {
      const next = scalar[index + 1];
      if (
        scalar[index] === ":" &&
        next !== undefined &&
        rustIsWhitespace(next.codePointAt(0))
      ) {
        hasColonSeparator = true;
        break;
      }
    }
    let invalidFlowLikeScalar = false;
    if (firstChar === "[" || firstChar === "{" || firstChar === "@" || firstChar === "`") {
      invalidFlowLikeScalar = parseYamlValue(scalar) === undefined;
    }
    if (!hasColonSeparator && !invalidFlowLikeScalar) {
      repairedLines.push(line);
      continue;
    }
    const quotedScalar = `'${scalar.replaceAll("'", "''")}'`;
    repairedLines.push(`${key}:${leadingWhitespace}${quotedScalar}${comment}`);
    changed = true;
  }
  return changed ? repairedLines.join("\n") : undefined;
}

function serdeDeserializeStr(node) {
  if (!isScalar(node)) return { invalidType: true };
  if (node.value === null) return { nullValue: true };
  if (
    node.type === "QUOTE_DOUBLE" ||
    node.type === "QUOTE_SINGLE" ||
    node.type === "BLOCK_FOLDED" ||
    node.type === "BLOCK_LITERAL"
  ) {
    if (typeof node.value === "string") return { value: node.value };
    return { uncovered: true };
  }
  if (typeof node.source === "string") return { value: node.source };
  if (typeof node.value === "string") return { value: node.value };
  if (typeof node.value === "number" || typeof node.value === "boolean" || typeof node.value === "bigint") {
    return { value: String(node.value) };
  }
  return { uncovered: true };
}

function collectKnownMapping(mapNode, knownFields) {
  const fields = new Map();
  for (const pair of mapNode.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
      return { uncovered: true, reason: "non-string mapping key" };
    }
    const key = pair.key.value;
    if (!knownFields.has(key)) continue;
    if (fields.has(key)) {
      return { duplicate: key };
    }
    fields.set(key, pair.value);
  }
  return { fields };
}

function optionStringFromNode(node, field, yamlText) {
  if (node === undefined) return { value: undefined };
  if (isScalar(node) && node.value === null) return { value: undefined };
  const deserialized = serdeDeserializeStr(node);
  if (deserialized.uncovered) return { uncovered: true };
  if (deserialized.nullValue) return { value: undefined };
  if (deserialized.invalidType) {
    const typed = invalidTypeMessage(field, node, yamlText, "a string");
    if (typed.uncovered) return { uncovered: true, reason: typed.reason };
    return { error: typed.message };
  }
  return { value: deserialized.value };
}

function parseFrontmatterMapping(frontmatter) {
  const document = parseYamlDocument(frontmatter);
  if (document.errors.length > 0) return { parseErrors: true };
  if (!isMap(document.contents)) {
    return { error: "invalid YAML: invalid type: expected a mapping" };
  }
  const collected = collectKnownMapping(document.contents, FRONTMATTER_FIELDS);
  if (collected.uncovered) return { uncovered: true, reason: collected.reason };
  if (collected.duplicate) return { error: `invalid YAML: duplicate field \`${collected.duplicate}\`` };
  return { fields: collected.fields };
}

function parseSkillFrontmatter(contents, defaultName) {
  const extracted = extractFrontmatter(contents);
  if (extracted === null) return { ok: false, message: "missing YAML frontmatter delimited by ---" };
  let yamlText = extracted;
  let parsed = parseFrontmatterMapping(yamlText);
  if (parsed.parseErrors) {
    const repaired = repairFrontmatterScalarFields(extracted);
    if (repaired === undefined) return { uncovered: true, reason: "unproven YAML syntax shape" };
    yamlText = repaired;
    parsed = parseFrontmatterMapping(yamlText);
    if (parsed.parseErrors) return { uncovered: true, reason: "unproven YAML syntax shape after repair" };
  }
  if (parsed.uncovered) return parsed;
  if (parsed.error) return { ok: false, message: parsed.error };
  if ([...yamlText].some((character) => {
    const code = character.codePointAt(0);
    return code === 0x85 || code === 0x2028 || code === 0x2029;
  })) {
    return {
      uncovered: true,
      reason: "YAML contains Unicode line breaks whose serde_yaml 0.9 parse is not reproduced by yaml@2.9.0",
    };
  }
  const nameNode = parsed.fields.get("name");
  const descriptionNode = parsed.fields.get("description");
  const metadataNode = parsed.fields.get("metadata");
  const nameField = optionStringFromNode(nameNode, "name", yamlText);
  if (nameField.uncovered) return { uncovered: true, reason: nameField.reason ?? "unproven name scalar" };
  if (nameField.error) return { ok: false, message: nameField.error };
  const descriptionField = optionStringFromNode(descriptionNode, "description", yamlText);
  if (descriptionField.uncovered) return { uncovered: true, reason: descriptionField.reason ?? "unproven description scalar" };
  if (descriptionField.error) return { ok: false, message: descriptionField.error };
  let shortRaw;
  if (metadataNode !== undefined) {
    if (isScalar(metadataNode) && metadataNode.value === null) {
      const typed = invalidTypeMessage(metadataNode ? "metadata" : "metadata", metadataNode, yamlText, "struct SkillFrontmatterMetadata");
      if (typed.uncovered) return { uncovered: true, reason: typed.reason };
      return { ok: false, message: typed.message };
    }
    if (!isMap(metadataNode)) {
      const typed = invalidTypeMessage("metadata", metadataNode, yamlText, "struct SkillFrontmatterMetadata");
      if (typed.uncovered) return { uncovered: true, reason: typed.reason };
      return { ok: false, message: typed.message };
    }
    const metadataFields = collectKnownMapping(metadataNode, METADATA_FIELDS);
    if (metadataFields.uncovered) return { uncovered: true, reason: metadataFields.reason };
    if (metadataFields.duplicate) return { ok: false, message: `invalid YAML: duplicate field \`${metadataFields.duplicate}\`` };
    const shortField = optionStringFromNode(metadataFields.fields.get("short-description"), "short-description", yamlText);
    if (shortField.uncovered) return { uncovered: true, reason: shortField.reason ?? "unproven short-description scalar" };
    if (shortField.error) return { ok: false, message: shortField.error };
    shortRaw = shortField.value;
  }
  const name = typeof nameField.value === "string" ? sanitizeSingleLine(nameField.value) : "";
  const resolvedName = name === "" ? defaultName : name;
  const description = typeof descriptionField.value === "string" ? sanitizeSingleLine(descriptionField.value) : "";
  const shortDescription = typeof shortRaw === "string" ? sanitizeSingleLine(shortRaw) : "";
  if (resolvedName === "") return { ok: false, message: "missing field `name`" };
  if ([...resolvedName].length > MAX_NAME_LEN) {
    return { ok: false, message: "invalid name: exceeds maximum length of 64 characters" };
  }
  if (description === "") return { ok: false, message: "missing field `description`" };
  return {
    ok: true,
    name: resolvedName,
    description,
    shortDescription: shortDescription === "" ? undefined : shortDescription,
  };
}

function defaultSkillName(skillPath) {
  const parent = path.basename(path.dirname(skillPath));
  const cleaned = sanitizeSingleLine(parent);
  return cleaned === "" ? "skill" : cleaned;
}

function resolveColorStr(value) {
  if (typeof value !== "string") return null;
  const trimmed = rustTrim(value);
  if (trimmed === "") return null;
  if (trimmed.length !== 7 || trimmed[0] !== "#") return null;
  for (let index = 1; index < 7; index += 1) {
    const code = trimmed.charCodeAt(index);
    const hex =
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 70) ||
      (code >= 97 && code <= 102);
    if (!hex) return null;
  }
  return trimmed;
}

function resolveInterfaceStr(value, maxLen) {
  if (typeof value !== "string") return null;
  const sanitized = sanitizeSingleLine(value);
  if (sanitized === "") return null;
  if ([...sanitized].length > maxLen) return null;
  return sanitized;
}

function optionBoolFromNode(node) {
  if (node === undefined) return { value: undefined };
  if (isScalar(node) && node.value === null) return { value: undefined };
  if (isScalar(node) && typeof node.value === "boolean") return { value: node.value };
  return { invalid: true };
}

function parseProductNode(node) {
  const deserialized = serdeDeserializeStr(node);
  if (deserialized.uncovered || deserialized.invalidType || deserialized.nullValue) return { invalid: true };
  if (!PRODUCT_ALIASES.has(deserialized.value)) return { invalid: true };
  return { value: deserialized.value.toLowerCase() };
}

function deserializeMetadataFile(yamlText) {
  const document = parseYamlDocument(yamlText);
  if (document.errors.length > 0) return { ignore: true };
  if (document.contents == null) return { value: {} };
  if (!isMap(document.contents)) return { ignore: true };
  const fileFields = collectKnownMapping(document.contents, METADATA_FILE_FIELDS);
  if (fileFields.uncovered || fileFields.duplicate) return { ignore: true };
  const result = {
    interface: undefined,
    dependencies: undefined,
    policy: undefined,
  };
  const interfaceNode = fileFields.fields.get("interface");
  if (interfaceNode !== undefined) {
    if (isScalar(interfaceNode) && interfaceNode.value === null) {
      result.interface = undefined;
    } else if (!isMap(interfaceNode)) {
      return { ignore: true };
    } else {
      const collected = collectKnownMapping(interfaceNode, INTERFACE_FIELDS);
      if (collected.uncovered || collected.duplicate) return { ignore: true };
      const display = optionStringFromNode(collected.fields.get("display_name"), "interface.display_name", yamlText);
      const short = optionStringFromNode(collected.fields.get("short_description"), "interface.short_description", yamlText);
      const brand = optionStringFromNode(collected.fields.get("brand_color"), "interface.brand_color", yamlText);
      const prompt = optionStringFromNode(collected.fields.get("default_prompt"), "interface.default_prompt", yamlText);
      const iconSmall = optionStringFromNode(collected.fields.get("icon_small"), "interface.icon_small", yamlText);
      const iconLarge = optionStringFromNode(collected.fields.get("icon_large"), "interface.icon_large", yamlText);
      if (
        display.uncovered || display.error ||
        short.uncovered || short.error ||
        brand.uncovered || brand.error ||
        prompt.uncovered || prompt.error ||
        iconSmall.uncovered || iconSmall.error ||
        iconLarge.uncovered || iconLarge.error
      ) {
        return { ignore: true };
      }
      result.interface = {
        display_name: display.value,
        short_description: short.value,
        brand_color: brand.value,
        default_prompt: prompt.value,
        icon_small: iconSmall.value,
        icon_large: iconLarge.value,
      };
    }
  }
  const dependenciesNode = fileFields.fields.get("dependencies");
  if (dependenciesNode !== undefined) {
    if (isScalar(dependenciesNode) && dependenciesNode.value === null) {
      result.dependencies = undefined;
    } else if (!isMap(dependenciesNode)) {
      return { ignore: true };
    } else {
      const collected = collectKnownMapping(dependenciesNode, DEPENDENCY_FIELDS);
      if (collected.uncovered || collected.duplicate) return { ignore: true };
      const toolsNode = collected.fields.get("tools");
      if (toolsNode !== undefined) {
        if (!isSeq(toolsNode)) return { ignore: true };
        for (const tool of toolsNode.items) {
          if (!isMap(tool)) return { ignore: true };
          const fields = collectKnownMapping(tool, DEPENDENCY_TOOL_FIELDS);
          if (fields.uncovered || fields.duplicate) return { ignore: true };
          for (const field of ["type", "value", "description", "transport", "command", "url"]) {
            const value = optionStringFromNode(fields.fields.get(field), `dependencies.tools.${field}`, yamlText);
            if (value.uncovered || value.error) return { ignore: true };
          }
          const oauth = fields.fields.get("oauth");
          if (oauth !== undefined && !(isScalar(oauth) && oauth.value === null)) {
            if (!isMap(oauth)) return { ignore: true };
            const values = collectKnownMapping(oauth, OAUTH_FIELDS);
            if (values.uncovered || values.duplicate || values.fields.size > 1) return { ignore: true };
            const port = values.fields.get("callbackPort") ?? values.fields.get("callback_port");
            if (port !== undefined && !(isScalar(port) && port.value === null) &&
                !(isScalar(port) && typeof port.value === "number" && Number.isInteger(port.value) &&
                  port.value >= 0 && port.value <= 65535)) return { ignore: true };
          }
        }
      }
      result.dependencies = {};
    }
  }
  const policyNode = fileFields.fields.get("policy");
  if (policyNode !== undefined) {
    if (isScalar(policyNode) && policyNode.value === null) {
      result.policy = undefined;
    } else if (!isMap(policyNode)) {
      return { ignore: true };
    } else {
      const collected = collectKnownMapping(policyNode, POLICY_FIELDS);
      if (collected.uncovered || collected.duplicate) return { ignore: true };
      const allow = optionBoolFromNode(collected.fields.get("allow_implicit_invocation"));
      if (allow.invalid) return { ignore: true };
      let products = [];
      const productsNode = collected.fields.get("products");
      if (productsNode !== undefined) {
        if (!isSeq(productsNode)) {
          return { ignore: true };
        } else {
          for (const item of productsNode.items) {
            const product = parseProductNode(item);
            if (product.invalid) return { ignore: true };
            products.push(product.value);
          }
        }
      }
      result.policy = {
        allow_implicit_invocation: allow.value,
        products,
      };
    }
  }
  return { value: result };
}

function inspectOptionalMetadata(raw) {
  const deserialized = deserializeMetadataFile(raw);
  if (deserialized.ignore) {
    return { ignored: ["agents/openai.yaml"], uncoveredItems: [], interface: undefined, filtered: null, implicitInvocation: null };
  }
  const file = deserialized.value;
  const uncoveredItems = [];
  let iface;
  if (file.interface) {
    const hasIcon =
      (typeof file.interface.icon_small === "string" && rustTrim(file.interface.icon_small) !== "") ||
      (typeof file.interface.icon_large === "string" && rustTrim(file.interface.icon_large) !== "");
    const mapped = {
      displayName: resolveInterfaceStr(file.interface.display_name, MAX_NAME_LEN),
      shortDescription: resolveInterfaceStr(file.interface.short_description, MAX_INTERFACE_DESCRIPTION_LEN),
      iconSmall: null,
      iconLarge: null,
      iconSmallUrl: null,
      iconLargeUrl: null,
      brandColor: resolveColorStr(file.interface.brand_color),
      defaultPrompt: resolveInterfaceStr(file.interface.default_prompt, MAX_INTERFACE_DESCRIPTION_LEN),
    };
    const hasText =
      mapped.displayName !== null ||
      mapped.shortDescription !== null ||
      mapped.brandColor !== null ||
      mapped.defaultPrompt !== null;
    if (hasIcon) {
      uncoveredItems.push(uncovered(
        "uncalibrated-optional-metadata",
        "agents/openai.yaml interface asset paths require native resolution that this slice does not claim",
        { field: "interface" },
      ));
    }
    if (hasText || hasIcon) iface = mapped;
  }
  const products = file.policy?.products ?? [];
  const filtered = products.length > 0 ? !products.includes(CALIBRATED_PRODUCT) : null;
  const implicitInvocation =
    file.policy && file.policy.allow_implicit_invocation !== undefined
      ? file.policy.allow_implicit_invocation !== false
      : null;
  const recordedImplicit =
    file.policy && file.policy.allow_implicit_invocation !== undefined
      ? file.policy.allow_implicit_invocation
      : null;
  void implicitInvocation;
  return {
    ignored: [],
    uncoveredItems,
    interface: iface,
    filtered: filtered === true ? true : filtered === false ? false : null,
    implicitInvocation: recordedImplicit,
  };
}

function normalizeActivationRules(activationRules, rootAbs) {
  if (activationRules === undefined || activationRules === null) {
    return { rules: null };
  }
  if (!Array.isArray(activationRules)) {
    return { incomplete: uncovered("invalid-activation-rules", "activationRules must be an array") };
  }
  const rules = [];
  for (const [index, entry] of activationRules.entries()) {
    if (!isPlainObject(entry)) {
      return { incomplete: uncovered("invalid-activation-rules", `activationRules[${index}] must be an object`) };
    }
    const hasName = Object.hasOwn(entry, "name");
    const hasPath = Object.hasOwn(entry, "path");
    if (hasName === hasPath) {
      return { incomplete: uncovered("invalid-activation-rules", `activationRules[${index}] must set exactly one of name or path`) };
    }
    if (typeof entry.enabled !== "boolean") {
      return { incomplete: uncovered("invalid-activation-rules", `activationRules[${index}].enabled must be a boolean`) };
    }
    if (hasName) {
      if (typeof entry.name !== "string" || entry.name.trim() === "") {
        return { incomplete: uncovered("invalid-activation-rules", `activationRules[${index}].name must be a nonempty string`) };
      }
      rules.push({ selector: { type: "name", name: entry.name.trim() }, enabled: entry.enabled });
      continue;
    }
    if (typeof entry.path !== "string" || !path.isAbsolute(entry.path)) {
      return { incomplete: uncovered("invalid-activation-rules", `activationRules[${index}].path must be an absolute SKILL.md path inside root`) };
    }
    const normalized = path.normalize(entry.path);
    if (path.basename(normalized) !== SKILLS_FILENAME) {
      return { incomplete: uncovered("invalid-activation-rules", `activationRules[${index}].path must name SKILL.md`) };
    }
    const relative = path.relative(rootAbs, normalized);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return { incomplete: uncovered("invalid-activation-rules", `activationRules[${index}].path leaves the project root`) };
    }
    rules.push({ selector: { type: "path", path: normalized }, enabled: entry.enabled });
  }
  return { rules };
}

function resolveEnabled(rules, skillName, skillPath) {
  if (rules === null) return { enabled: null, disabled: null };
  let disabled = false;
  for (const rule of rules) {
    if (rule.selector.type === "path") {
      if (path.normalize(rule.selector.path) === path.normalize(skillPath)) {
        disabled = rule.enabled !== true;
      }
    } else if (rule.selector.name === skillName) {
      disabled = rule.enabled !== true;
    }
  }
  return { enabled: !disabled, disabled };
}

function posixRelative(rootAbs, absolute) {
  return path.relative(rootAbs, absolute).split(path.sep).join("/");
}

function boundReadKind(error) {
  return error?.details?.kind ?? error?.details?.boundReadDisposition ?? error?.code ?? "unknown";
}

function isCodedError(error) {
  return Boolean(error && typeof error === "object" && typeof error.code === "string" && error.code.startsWith("SFC"));
}

async function discoverSkillPaths(skillsRootAbs) {
  const discovered = [];
  const uncoveredItems = [];
  let directoryCount = 0;
  let entryCount = 0;
  let truncated = false;
  let visibleDirectorySymlink = false;

  async function walk(directoryAbs, depth) {
    if (truncated) return;
    directoryCount += 1;
    if (directoryCount > MAX_SKILLS_DIRS_PER_ROOT) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = await readdir(directoryAbs, { withFileTypes: true });
    } catch (cause) {
      uncoveredItems.push(uncovered(
        "unread-directory",
        "a skills directory could not be read during finite discovery",
        { path: directoryAbs, causeKind: boundReadKind(cause) },
      ));
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      entryCount += 1;
      if (entryCount > MAX_SKILLS_ENTRIES_PER_ROOT) {
        truncated = true;
        return;
      }
      const childAbs = path.join(directoryAbs, entry.name);
      let childStat;
      try {
        childStat = await lstat(childAbs);
      } catch (cause) {
        uncoveredItems.push(uncovered(
          "unread-entry",
          "a skills entry could not be lstat'd during finite discovery",
          { path: childAbs, causeKind: boundReadKind(cause) },
        ));
        continue;
      }
      if (childStat.isSymbolicLink()) {
        if (entry.name.startsWith(".")) continue;
        let followed;
        try {
          followed = await stat(childAbs);
        } catch {
          continue;
        }
        if (followed.isDirectory()) {
          visibleDirectorySymlink = true;
        }
        continue;
      }
      if (childStat.isDirectory()) {
        if (entry.name.startsWith(".")) continue;
        if (depth >= MAX_SCAN_DEPTH) continue;
        await walk(childAbs, depth + 1);
        continue;
      }
      if (childStat.isFile() && entry.name === SKILLS_FILENAME) {
        discovered.push(childAbs);
      }
    }
  }

  await walk(skillsRootAbs, 0);
  if (truncated) {
    uncoveredItems.push(uncovered(
      "scan-limit",
      "native skill discovery hit the calibrated directory or entry capacity",
    ));
  }
  if (visibleDirectorySymlink) {
    uncoveredItems.push(uncovered(
      "directory-symlink-unfollowed",
      "a visible directory symlink was not followed; native Repo discovery would follow it",
    ));
  }
  discovered.sort((left, right) => left.localeCompare(right));
  return { discovered, uncoveredItems };
}

function reportDocument({
  rootAbs,
  skillsRoot,
  hostId,
  hostVersion,
  pathCategory,
  skills,
  findings,
  uncoveredItems,
  nameAmbiguities,
  incomplete,
  coverageExtras,
  limitations,
  policy,
}) {
  const blocking = findings.length > 0;
  const exitCode = incomplete || uncoveredItems.length > 0 ? 2 : blocking ? 1 : 0;
  const coverage = {
    hostId,
    hostVersion,
    pathCategory,
    root: rootAbs,
    skillsRoot,
  };
  if (coverageExtras && Object.keys(coverageExtras).length > 0) {
    Object.assign(coverage, coverageExtras);
  } else if (!coverageExtras) {
    coverage.officialTag = "rust-v0.154.0";
    coverage.officialCommit = "6b9826e3aa83b1a5947db50f4332cb9c65f1b340";
  }
  return {
    kind: HOST_LOADING_CHECK_REPORT_KIND,
    schemaVersion: 1,
    generatedBy: { tool: KIT_TOOL_NAME, version: KIT_VERSION },
    coverage,
    limitations: [...(limitations ?? LIMITATIONS)],
    skills,
    nameAmbiguities,
    findings,
    uncovered: uncoveredItems,
    ok: exitCode === 0,
    exitCode,
    policy: policy ?? "host loading check is diagnosis only: it reads SKILL.md and optional agents/openai.yaml under the selected project root and never writes, spawns, or contacts a network",
  };
}

function incompleteReport({
  rootAbs = null,
  skillsRoot = null,
  hostId = null,
  hostVersion = null,
  pathCategory = null,
  item,
  coverageExtras,
  limitations,
  policy,
}) {
  const omitCodexSources = hostId !== HOST_LOADING_SUPPORTED_HOST_ID;
  return reportDocument({
    rootAbs,
    skillsRoot,
    hostId,
    hostVersion,
    pathCategory,
    skills: [],
    findings: [],
    uncoveredItems: [item],
    nameAmbiguities: [],
    incomplete: true,
    coverageExtras: coverageExtras ?? (omitCodexSources ? {} : undefined),
    limitations,
    policy,
  });
}

/**
 * Runs the Codex 0.154.0 project-skill loading check.
 * Options: { root, hostId, hostVersion, pathCategory, activationRules, hostsRoot }.
 * Returns the host-loading-check report. Never writes.
 */
export async function runHostLoadingCheck({
  root,
  hostId,
  hostVersion,
  pathCategory,
  activationRules,
  hostsRoot,
} = {}) {
  if (typeof hostId !== "string" || hostId.length === 0) {
    return incompleteReport({
      rootAbs: typeof root === "string" ? root : null,
      hostId,
      hostVersion,
      pathCategory,
      item: uncovered("invalid-input", "hostId is required"),
    });
  }
  if (typeof hostVersion !== "string" || hostVersion.length === 0) {
    return incompleteReport({
      rootAbs: typeof root === "string" ? root : null,
      hostId,
      hostVersion,
      pathCategory,
      item: uncovered("invalid-input", "hostVersion is required"),
    });
  }
  if (typeof pathCategory !== "string" || pathCategory.length === 0) {
    return incompleteReport({
      rootAbs: typeof root === "string" ? root : null,
      hostId,
      hostVersion,
      pathCategory,
      item: uncovered("invalid-input", "pathCategory is required"),
    });
  }
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    return incompleteReport({
      rootAbs: typeof root === "string" ? root : null,
      hostId,
      hostVersion,
      pathCategory,
      item: uncovered("invalid-root", "root must be an explicit absolute project working directory"),
    });
  }
  const rootAbs = path.normalize(root);
  const selectedHostsRoot = hostsRoot ?? bundledHostProfilesRoot();
  let descriptor;
  try {
    descriptor = await describeHost({ hostId, hostsRoot: selectedHostsRoot });
  } catch (cause) {
    const message = String(cause?.message ?? cause);
    const kind = message.includes("unknown host")
      ? "unknown-host"
      : message.includes("valid hostId")
        ? "invalid-input"
        : "uncalibrated-host";
    return incompleteReport({
      rootAbs,
      hostId,
      hostVersion,
      pathCategory,
      item: uncovered(kind, message, { causeKind: boundReadKind(cause) }),
    });
  }
  const canonicalHostId = descriptor.hostId;
  const category = (descriptor.pathCategories ?? []).find((item) => item.id === pathCategory);
  const relPath = path.posix.normalize(String(category?.relPath ?? ""));
  const nativeSpec = category
    ? matchNativeHost({ hostId: canonicalHostId, hostVersion, pathCategory, relPath })
    : null;
  const isCodex = canonicalHostId === HOST_LOADING_SUPPORTED_HOST_ID
    && hostVersion === HOST_LOADING_SUPPORTED_HOST_VERSION
    && pathCategory === HOST_LOADING_SUPPORTED_PATH_CATEGORY;

  if (isCodex) {
    const normalizedEarly = normalizeActivationRules(activationRules, rootAbs);
    if (normalizedEarly.incomplete) {
      return incompleteReport({
        rootAbs,
        hostId: canonicalHostId,
        hostVersion,
        pathCategory,
        item: normalizedEarly.incomplete,
      });
    }
    if (!category) {
      return incompleteReport({
        rootAbs,
        hostId: canonicalHostId,
        hostVersion,
        pathCategory,
        item: uncovered("uncalibrated-path-category", `pathCategory ${pathCategory} is not a calibrated Codex project skill root`),
      });
    }
    if (relPath !== HOST_LOADING_SUPPORTED_REL_PATH) {
      return incompleteReport({
        rootAbs,
        hostId: canonicalHostId,
        hostVersion,
        pathCategory,
        item: uncovered(
          "uncalibrated-path-mapping",
          `calibrated pathCategory ${pathCategory} must map to ${HOST_LOADING_SUPPORTED_REL_PATH}`,
          { relPath },
        ),
      });
    }
  } else if (nativeSpec) {
    if (activationRules !== undefined && activationRules !== null) {
      return incompleteReport({
        rootAbs,
        hostId: canonicalHostId,
        hostVersion,
        pathCategory,
        item: uncovered(
          "unsupported-activation-rules",
          `activationRules are not calibrated for ${canonicalHostId}; only omitted or null are accepted`,
        ),
        coverageExtras: { ruleSources: nativeRuleSources(canonicalHostId) },
        limitations: nativeLimitations(canonicalHostId),
        policy: NATIVE_POLICY,
      });
    }
  } else {
    const expectedNative = NATIVE_HOSTS[canonicalHostId];
    if (canonicalHostId === HOST_LOADING_SUPPORTED_HOST_ID) {
      if (hostVersion !== HOST_LOADING_SUPPORTED_HOST_VERSION) {
        return incompleteReport({
          rootAbs,
          hostId: canonicalHostId,
          hostVersion,
          pathCategory,
          item: uncovered("uncalibrated-host", `host ${canonicalHostId}@${hostVersion} is outside the calibrated Codex 0.154.0 slice`),
        });
      }
      return incompleteReport({
        rootAbs,
        hostId: canonicalHostId,
        hostVersion,
        pathCategory,
        item: uncovered("uncalibrated-path-category", `pathCategory ${pathCategory} is not a calibrated Codex project skill root`),
      });
    }
    if (!expectedNative || expectedNative.hostVersion !== hostVersion) {
      return incompleteReport({
        rootAbs,
        hostId: canonicalHostId,
        hostVersion,
        pathCategory,
        item: uncovered("uncalibrated-host", `host ${canonicalHostId}@${hostVersion} is outside the calibrated native slice`),
      });
    }
    if (!category || pathCategory !== expectedNative.pathCategory) {
      return incompleteReport({
        rootAbs,
        hostId: canonicalHostId,
        hostVersion,
        pathCategory,
        item: uncovered("uncalibrated-path-category", `pathCategory ${pathCategory} is not a calibrated project skill root for ${canonicalHostId}`),
      });
    }
    return incompleteReport({
      rootAbs,
      hostId: canonicalHostId,
      hostVersion,
      pathCategory,
      item: uncovered(
        "uncalibrated-path-mapping",
        `calibrated pathCategory ${pathCategory} must map to ${expectedNative.relPath}`,
        { relPath },
      ),
    });
  }

  const normalizedRules = isCodex ? normalizeActivationRules(activationRules, rootAbs) : { rules: null };
  if (normalizedRules.incomplete) {
    return incompleteReport({
      rootAbs,
      hostId: canonicalHostId,
      hostVersion,
      pathCategory,
      item: normalizedRules.incomplete,
    });
  }

  let rootBinding;
  try {
    const rootStat = await lstat(rootAbs);
    if (!rootStat.isDirectory() && !rootStat.isSymbolicLink()) {
      return incompleteReport({
        rootAbs,
        hostId: canonicalHostId,
        hostVersion,
        pathCategory,
        item: uncovered("invalid-root", "target root exists but is not a directory"),
      });
    }
    rootBinding = await createFilesystemRootBinding(rootAbs);
  } catch (cause) {
    return incompleteReport({
      rootAbs,
      hostId: canonicalHostId,
      hostVersion,
      pathCategory,
      item: uncovered("invalid-root", "target root does not exist or cannot be bound", { causeKind: boundReadKind(cause) }),
    });
  }

  const selectedRelPath = nativeSpec?.relPath ?? HOST_LOADING_SUPPORTED_REL_PATH;
  const skillsRoot = path.join(rootAbs, ...selectedRelPath.split("/"));
  const nativeReportOptions = nativeSpec
    ? {
      coverageExtras: { ruleSources: nativeRuleSources(canonicalHostId) },
      limitations: nativeLimitations(canonicalHostId),
      policy: NATIVE_POLICY,
    }
    : {};
  let skillsRootStat;
  try {
    skillsRootStat = await lstat(skillsRoot);
  } catch (cause) {
    if (cause?.code !== "ENOENT" && cause?.code !== "ENOTDIR") {
      return incompleteReport({
        rootAbs, skillsRoot, hostId: canonicalHostId, hostVersion, pathCategory,
        item: uncovered("discovery-root-unreadable", `project ${selectedRelPath} cannot be inspected`, {
          causeKind: boundReadKind(cause),
        }),
        ...nativeReportOptions,
      });
    }
    return reportDocument({
      rootAbs,
      skillsRoot,
      hostId: canonicalHostId,
      hostVersion,
      pathCategory,
      skills: [],
      findings: [finding("missing-discovery-root", `project ${selectedRelPath} does not exist`)],
      uncoveredItems: [],
      nameAmbiguities: [],
      incomplete: false,
      ...nativeReportOptions,
    });
  }
  if (skillsRootStat.isSymbolicLink()) {
    return incompleteReport({
      rootAbs,
      skillsRoot,
      hostId: canonicalHostId,
      hostVersion,
      pathCategory,
      item: uncovered("directory-symlink-unfollowed", "the calibrated skills root is a directory symlink and is not followed"),
      ...nativeReportOptions,
    });
  }
  if (!skillsRootStat.isDirectory()) {
    return reportDocument({
      rootAbs,
      skillsRoot,
      hostId: canonicalHostId,
      hostVersion,
      pathCategory,
      skills: [],
      findings: [finding("missing-discovery-root", `project ${selectedRelPath} is not a directory`)],
      uncoveredItems: [],
      nameAmbiguities: [],
      incomplete: false,
      ...nativeReportOptions,
    });
  }

  if (nativeSpec) {
    const nativeResult = await runNativeHostLoadingCheck({
      rootAbs,
      skillsRootAbs: skillsRoot,
      hostId: canonicalHostId,
      rootBinding,
    });
    return reportDocument({
      rootAbs,
      skillsRoot,
      hostId: canonicalHostId,
      hostVersion,
      pathCategory,
      skills: nativeResult.skills,
      findings: nativeResult.findings,
      uncoveredItems: nativeResult.uncoveredItems,
      nameAmbiguities: nativeResult.nameAmbiguities,
      incomplete: nativeResult.uncoveredItems.length > 0,
      coverageExtras: { ruleSources: nativeResult.ruleSources },
      limitations: nativeResult.limitations,
      policy: NATIVE_POLICY,
    });
  }

  const { discovered, uncoveredItems: discoveryUncovered } = await discoverSkillPaths(skillsRoot);
  const findings = [];
  const uncoveredItems = [...discoveryUncovered];
  const skills = [];

  for (const skillPath of discovered) {
    const relativeSkill = posixRelative(rootAbs, skillPath);
    let receipt;
    try {
      receipt = await readFileBound(rootAbs, relativeSkill, { rootBinding });
    } catch (cause) {
      uncoveredItems.push(uncovered(
        "bound-read-boundary",
        "SKILL.md could not be read through the existing root binding",
        { path: skillPath, causeKind: boundReadKind(cause) },
      ));
      continue;
    }
    let text;
    try {
      text = decodeUtf8PreserveBom(receipt.content);
    } catch {
      uncoveredItems.push(uncovered("undecodable-skill", "SKILL.md is not valid UTF-8", { path: skillPath }));
      continue;
    }
    const parsed = parseSkillFrontmatter(text, defaultSkillName(skillPath));
    if (parsed.uncovered) {
      uncoveredItems.push(uncovered(
        "unproven-yaml-shape",
        "YAML shape is outside the calibrated serde field set",
        { path: skillPath, reason: parsed.reason },
      ));
      continue;
    }
    if (!parsed.ok) {
      findings.push(finding("skill-parse-error", parsed.message, { path: skillPath }));
      skills.push({
        path: skillPath,
        name: null,
        parse: "error",
        enabled: null,
        disabled: null,
        ignored: [],
        filtered: null,
        implicitInvocation: null,
        interface: undefined,
        error: parsed.message,
      });
      continue;
    }

    const metadataRel = posixRelative(rootAbs, path.join(path.dirname(skillPath), SKILLS_METADATA_DIR, SKILLS_METADATA_FILENAME));
    const metadataAbs = path.join(path.dirname(skillPath), SKILLS_METADATA_DIR, SKILLS_METADATA_FILENAME);
    let ignored = [];
    let iface;
    let filtered = null;
    let implicitInvocation = null;
    let metadataStat;
    try {
      metadataStat = await lstat(metadataAbs);
    } catch {
      metadataStat = null;
    }
    if (metadataStat?.isSymbolicLink()) {
      uncoveredItems.push(uncovered(
        "metadata-symlink",
        "optional agents/openai.yaml is a symlink; this slice does not claim native probe semantics",
        { path: metadataAbs },
      ));
    } else if (metadataStat?.isFile()) {
      try {
        const metadataReceipt = await readFileBound(rootAbs, metadataRel, { rootBinding });
        const metadataText = decodeUtf8PreserveBom(metadataReceipt.content);
        const inspected = inspectOptionalMetadata(metadataText);
        ignored = inspected.ignored;
        iface = inspected.interface;
        filtered = inspected.filtered;
        implicitInvocation = inspected.implicitInvocation;
        uncoveredItems.push(...inspected.uncoveredItems);
      } catch (cause) {
        if (isCodedError(cause)) {
          uncoveredItems.push(uncovered(
            "bound-read-boundary",
            "optional agents/openai.yaml could not be read through the existing root binding",
            { path: metadataAbs, causeKind: boundReadKind(cause) },
          ));
        } else {
          ignored = ["agents/openai.yaml"];
        }
      }
    }

    skills.push({
      path: skillPath,
      name: parsed.name,
      description: parsed.description,
      shortDescription: parsed.shortDescription,
      parse: "ok",
      enabled: null,
      disabled: null,
      ignored,
      filtered,
      implicitInvocation,
      interface: iface,
      error: undefined,
    });
  }

  const loadedVisible = skills.filter((item) => item.parse === "ok" && item.filtered !== true);
  const loaded = skills.filter((item) => item.parse === "ok");
  const nameCounts = new Map();
  for (const skill of loadedVisible) {
    nameCounts.set(skill.name, (nameCounts.get(skill.name) ?? 0) + 1);
  }
  const nameAmbiguities = [...nameCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([name]) => ({
      name,
      paths: loadedVisible.filter((item) => item.name === name).map((item) => item.path),
    }));

  for (const skill of loaded) {
    const state = resolveEnabled(normalizedRules.rules, skill.name, skill.path);
    skill.enabled = state.enabled;
    skill.disabled = state.disabled;
  }

  if (discovered.length === 0 && findings.length === 0 && uncoveredItems.length === 0) {
    findings.push(finding("no-skill-entry", "no SKILL.md entries under the calibrated project skill root"));
  } else if (loadedVisible.length === 0 && loaded.some((item) => item.filtered === true) && findings.length === 0) {
    findings.push(finding(
      "no-discoverable-target",
      "product filtering left no discoverable skill target",
    ));
  }

  return reportDocument({
    rootAbs,
    skillsRoot,
    hostId: canonicalHostId,
    hostVersion,
    pathCategory,
    skills,
    findings,
    uncoveredItems,
    nameAmbiguities,
    incomplete: uncoveredItems.length > 0,
  });
}

export async function checkHostLoadingAction(options = {}) {
  const output = await runHostLoadingCheck(options);
  const status = output.exitCode === 0 ? "ok" : output.exitCode === 1 ? "findings" : "rejected";
  return { status, output };
}
