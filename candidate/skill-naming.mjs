import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Candidate plugin skill naming checker (unstable).
 *
 * Mechanically evaluates the cross-repository skill naming and description
 * policy (candidate/skill-naming-policy.json) over one plugin skills root:
 * every immediate subdirectory that carries a SKILL.md is one published
 * skill, and its frontmatter `name` / `description` are checked against the
 * three frozen rules:
 *
 *   SNR-001  name prefix        — name must be `<plugin-slug>-<suffix>`
 *                                 (or match an explicitly approved extra
 *                                 pattern); reserved bare names are always
 *                                 forbidden;
 *   SNR-002  description signal — description must contain the plugin slug
 *                                 or a caller-declared domain word, and must
 *                                 not consist of a bare global trigger
 *                                 phrase;
 *   SNR-003  routing scope      — routing entry skills (policy suffixes)
 *                                 must name the plugin slug in the
 *                                 description and must not imply global
 *                                 arbitration.
 *
 * The module only reads; it never writes, never consults the network, the
 * clock, or Git. Every rule outcome is reported per skill as PASS or FAIL;
 * the report's `ok` is the AND of all rule outcomes.
 */

export const SKILL_NAMING_POLICY_PATH = fileURLToPath(
  new URL("./skill-naming-policy.json", import.meta.url),
);

export const SKILL_NAMING_RULE_IDS = Object.freeze(["SNR-001", "SNR-002", "SNR-003"]);

function namingError(kind, message, details) {
  const error = new Error(message);
  error.code = "SFC2004";
  error.details = { ...(details ?? {}), kind };
  return error;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unquote(value) {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Line-based frontmatter extraction (no YAML dependency): the document must
 * open with a `---` line and close with another `---` line; `name` and
 * `description` are top-level keys, optionally quoted, optionally continued
 * on indented lines (plain multi-line or `|`/`>` block scalars).
 */
export function parseSkillFrontmatter(text) {
  if (typeof text !== "string" || !text.startsWith("---\n")) {
    throw namingError("frontmatter-missing", "SKILL.md does not start with a frontmatter fence");
  }
  const lines = text.split("\n");
  const end = lines.indexOf("---", 1);
  if (end === -1) {
    throw namingError("frontmatter-unclosed", "SKILL.md frontmatter fence is not closed");
  }
  const fields = {};
  for (let index = 1; index < end; index += 1) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(lines[index]);
    if (!match) continue;
    const [, key, rawValue] = match;
    let value = rawValue;
    if (value === "" || value === "|" || value === ">" || value === "|-" || value === ">-") {
      const collected = [];
      for (let follow = index + 1; follow < end; follow += 1) {
        const line = lines[follow];
        if (/^[ \t]+\S/.test(line)) collected.push(line.trim());
        else if (line.trim() === "") collected.push("");
        else break;
      }
      value = collected.join(" ").trim();
      index += collected.length;
    }
    fields[key] = unquote(value);
  }
  return { name: fields.name, description: fields.description };
}

/** Loads and shape-validates a naming policy document. */
export async function loadSkillNamingPolicy(policyPath) {
  const resolved = policyPath ?? SKILL_NAMING_POLICY_PATH;
  let parsed;
  try {
    parsed = JSON.parse(await readFile(resolved, "utf8"));
  } catch (cause) {
    throw namingError(
      cause && cause.code === "ENOENT" ? "policy-missing" : "policy-parse-failed",
      `skill naming policy is not readable JSON: ${resolved}`,
    );
  }
  if (!parsed || parsed.kind !== "skill-family.skill-naming-policy" || parsed.schemaVersion !== 1) {
    throw namingError("policy-invalid", "skill naming policy must carry schemaVersion 1 and kind skill-family.skill-naming-policy");
  }
  for (const section of ["skillName", "description", "routingEntry"]) {
    if (!parsed[section] || typeof parsed[section].ruleId !== "string") {
      throw namingError("policy-invalid", `skill naming policy lacks a usable ${section} section`);
    }
  }
  return parsed;
}

function normalizePhrase(value) {
  return String(value ?? "")
    .toLocaleLowerCase("en-US")
    .replace(/[\s\p{P}\p{S}]+/gu, " ")
    .trim();
}

function ruleOutcome(ruleId, ok, message) {
  return { ruleId, status: ok ? "PASS" : "FAIL", ...(ok ? {} : { message }) };
}

function checkNameRule(name, namePrefix, policy) {
  const { suffixPattern, reservedBareNames, additionalApprovedPatterns } = policy.skillName;
  if (typeof name !== "string" || name.length === 0) {
    return ruleOutcome("SNR-001", false, "frontmatter lacks a usable name");
  }
  if (reservedBareNames.includes(name)) {
    return ruleOutcome("SNR-001", false, `reserved bare generic name is forbidden: ${name}`);
  }
  const prefixed = new RegExp(`^${escapeRegExp(namePrefix)}-(?:${suffixPattern})$`).test(name);
  const approved = (Array.isArray(additionalApprovedPatterns) ? additionalApprovedPatterns : []).some(
    (pattern) => new RegExp(pattern).test(name),
  );
  return prefixed || approved
    ? ruleOutcome("SNR-001", true)
    : ruleOutcome("SNR-001", false, `name must be ${namePrefix}-<suffix> or an approved namespace form: ${name}`);
}

function checkDescriptionRule(description, slug, domainSignals, policy) {
  if (typeof description !== "string" || description.trim().length === 0) {
    return ruleOutcome("SNR-002", false, "frontmatter lacks a usable description");
  }
  const lowered = description.toLocaleLowerCase("en-US");
  const signals = [slug, ...domainSignals].filter((signal) => typeof signal === "string" && signal.length > 0);
  if (!signals.some((signal) => lowered.includes(signal.toLocaleLowerCase("en-US")))) {
    return ruleOutcome(
      "SNR-002",
      false,
      "description carries no domain signal (plugin slug or a declared domain word)",
    );
  }
  const normalized = normalizePhrase(description);
  const bareTrigger = (policy.description.forbiddenGlobalTriggers ?? []).find(
    (trigger) => normalizePhrase(trigger) === normalized,
  );
  if (bareTrigger !== undefined) {
    return ruleOutcome("SNR-002", false, `description is a bare global trigger phrase: ${bareTrigger}`);
  }
  return ruleOutcome("SNR-002", true);
}

function checkRoutingRule(name, description, slug, namePrefix, policy) {
  const suffixes = policy.routingEntry.suffixes ?? [];
  const prefix = `${namePrefix}-`;
  const suffix = typeof name === "string" && name.startsWith(prefix) ? name.slice(prefix.length) : null;
  if (suffix === null || !suffixes.includes(suffix)) {
    return ruleOutcome("SNR-003", true); // not a routing entry skill: vacuous pass
  }
  const lowered = typeof description === "string" ? description.toLocaleLowerCase("en-US") : "";
  if (!lowered.includes(slug.toLocaleLowerCase("en-US"))) {
    return ruleOutcome(
      "SNR-003",
      false,
      "routing entry skill must name the plugin slug to declare plugin-internal routing scope",
    );
  }
  const scopePhrase = (policy.routingEntry.forbiddenGlobalScopePhrases ?? []).find((phrase) =>
    lowered.includes(phrase.toLocaleLowerCase("en-US")),
  );
  if (scopePhrase !== undefined) {
    return ruleOutcome("SNR-003", false, `routing entry skill implies global arbitration: ${scopePhrase}`);
  }
  return ruleOutcome("SNR-003", true);
}

/**
 * Checks every published skill under one skills root.
 * Options: { skillsRoot, pluginSlug, namePrefix?, domainSignals?, policyPath? }.
 * namePrefix is the approved name prefix used by SNR-001/SNR-003 and defaults
 * to pluginSlug; the reference implementation shows the two can differ (an
 * approved short prefix), while SNR-002/SNR-003 still require the full plugin
 * slug as the description signal.
 * Returns the report document; throws a coded error only for unusable
 * inputs (missing root, invalid slug, unreadable policy).
 */
export async function checkPluginSkillNaming({ skillsRoot, pluginSlug, namePrefix, domainSignals = [], policyPath } = {}) {
  const policy = await loadSkillNamingPolicy(policyPath);
  if (typeof pluginSlug !== "string" || !new RegExp(policy.pluginSlugPattern).test(pluginSlug)) {
    throw namingError("invalid-plugin-slug", "pluginSlug must satisfy the policy plugin slug pattern", {
      pattern: policy.pluginSlugPattern,
    });
  }
  const effectivePrefix = namePrefix ?? pluginSlug;
  if (typeof effectivePrefix !== "string" || !new RegExp(policy.pluginSlugPattern).test(effectivePrefix)) {
    throw namingError("invalid-name-prefix", "namePrefix must satisfy the policy plugin slug pattern", {
      pattern: policy.pluginSlugPattern,
    });
  }
  if (typeof skillsRoot !== "string" || skillsRoot.length === 0) {
    throw namingError("invalid-skills-root", "skillsRoot is required");
  }
  const rootAbs = await realpath(path.resolve(skillsRoot)).catch(() => null);
  if (rootAbs === null || !(await stat(rootAbs)).isDirectory()) {
    throw namingError("invalid-skills-root", `skills root is not an existing directory: ${skillsRoot}`);
  }

  const directories = (await readdir(rootAbs, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  const skills = [];
  for (const directory of directories) {
    const relPath = `${directory}/SKILL.md`;
    let text = null;
    try {
      const candidate = path.join(rootAbs, directory, "SKILL.md");
      if ((await stat(candidate)).isFile()) text = await readFile(candidate, "utf8");
    } catch {
      text = null;
    }
    if (text === null) continue; // not a published skill directory
    let frontmatter = { name: undefined, description: undefined };
    let parseFailure = null;
    try {
      frontmatter = parseSkillFrontmatter(text);
    } catch (cause) {
      parseFailure = cause && cause.message ? cause.message : String(cause);
    }
    const rules =
      parseFailure !== null
        ? SKILL_NAMING_RULE_IDS.map((ruleId) => ruleOutcome(ruleId, false, parseFailure))
        : [
            checkNameRule(frontmatter.name, effectivePrefix, policy),
            checkDescriptionRule(frontmatter.description, pluginSlug, domainSignals, policy),
            checkRoutingRule(frontmatter.name, frontmatter.description, pluginSlug, effectivePrefix, policy),
          ];
    skills.push({
      directory,
      path: relPath,
      name: frontmatter.name ?? null,
      rules,
      ok: rules.every((rule) => rule.status === "PASS"),
    });
  }

  return {
    kind: "skill-family.skill-naming-report",
    schemaVersion: 1,
    policyVersion: policy.policyVersion,
    pluginSlug,
    namePrefix: effectivePrefix,
    skillsRoot: rootAbs,
    skillCount: skills.length,
    ok: skills.every((skill) => skill.ok),
    skills,
    policy:
      "skill naming check is diagnosis only: it never writes and never renames; violations must be resolved by the owning plugin",
  };
}
