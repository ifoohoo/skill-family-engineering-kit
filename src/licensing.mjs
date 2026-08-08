import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileContained } from "skill-family-harness-node";
import { validateDocument } from "skill-family-contracts";
import { invalidParamsError, kitError, KIT_ERROR_KINDS } from "./errors.mjs";

// Single authority for licensing policy.
//
// The Kit implements only generic parsing and rendering. Concrete policy
// lives exclusively in profile data under profiles/licensing/, and
// profiles/licensing/schema.json is executed at runtime against every
// registry load through the contracts validator. There is no second
// authority in code: no frozen per-profile rules, no hardcoded profile ids,
// authors, years, or commercial triggers.

const KEBAB_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Registry file and schema file inside a licensing profiles root. */
export const LICENSING_REGISTRY_FILE = "registry.json";
export const LICENSING_SCHEMA_FILE = "schema.json";
const LICENSING_DIALECT = "2020-12";

/**
 * The default licensing profiles root resolves to the data closure
 * shipped INSIDE this package (data/licensing), generated from
 * profiles/licensing at synth time. An isolated install therefore needs no
 * monorepo-relative path; an explicit --profiles-root always wins.
 */
export function bundledProfilesRoot() {
  return fileURLToPath(new URL("../data/licensing/", import.meta.url));
}

const APACHE_2_TEXT = readFileSync(
  new URL("./license-texts/Apache-2.0.txt", import.meta.url),
  "utf8",
);
const MIT_TEMPLATE = readFileSync(
  new URL("./license-texts/MIT.txt", import.meta.url),
  "utf8",
);

function failure(message, details = {}) {
  return kitError(KIT_ERROR_KINDS.INVALID_MANIFEST, message, details);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw failure(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw failure(`${label} fields must be exactly: ${wanted.join(", ")}`, {
      actual,
      expected: wanted,
    });
  }
}

async function loadSchema(profilesRoot) {
  try {
    return JSON.parse(await readFileContained(profilesRoot, LICENSING_SCHEMA_FILE, { encoding: "utf8" }));
  } catch (cause) {
    throw kitError(
      KIT_ERROR_KINDS.CONTRACT_PARSE_FAILED,
      "licensing profile schema is missing or invalid JSON",
      { schema: LICENSING_SCHEMA_FILE, cause: cause?.message },
    );
  }
}

function validateAgainstSchema(document, schema, label) {
  const validation = validateDocument(document, { schema, dialect: LICENSING_DIALECT, policy: "strict" });
  if (!validation.valid) {
    throw failure(`${label} failed the licensing schema (${LICENSING_SCHEMA_FILE})`, {
      observedCode: validation.errorCode,
      errors: validation.errors.slice(0, 5),
    });
  }
  return validation.data;
}

/**
 * Generic semantic invariants that hold for EVERY licensing profile, applied
 * after the schema gate. These are structural rules of the mechanism, not
 * per-profile policy values (those exist only in the registry data).
 */
export function validateLicensingProfile(profile) {
  exactKeys(
    profile,
    ["schemaVersion", "kind", "profile", "licensing", "identity", "preservation", "commercial"],
    "licensing profile",
  );
  if (profile.schemaVersion !== 1 || profile.kind !== "skill-family.licensing-profile") {
    throw failure("licensing profile envelope is invalid");
  }

  exactKeys(profile.profile, ["id", "name", "variant"], "profile identity");
  const { id, variant } = profile.profile;
  const key = `${id}/${variant}`;

  exactKeys(
    profile.licensing,
    ["spdx", "noticeRequired", "copyrightStrategy", "copyrightYear"],
    `${key} licensing`,
  );
  // NOTICE is an Apache-2.0 mechanism requirement, independent of profile.
  if (profile.licensing.noticeRequired !== (profile.licensing.spdx === "Apache-2.0")) {
    throw failure(`${key} noticeRequired must be ${profile.licensing.spdx === "Apache-2.0"} for ${profile.licensing.spdx}`);
  }

  exactKeys(profile.identity, ["authors", "displayValue", "ownerSeparation"], `${key} identity`);
  if (!Array.isArray(profile.identity.authors) || profile.identity.authors.length === 0) {
    throw failure(`${key} must declare at least one author`);
  }
  const seenAuthorIds = new Set();
  profile.identity.authors.forEach((author, index) => {
    exactKeys(author, ["id", "displayName", "role"], `${key} authors[${index}]`);
    if (seenAuthorIds.has(author.id)) {
      throw failure(`${key} author ids must be unique (duplicate: ${author.id})`);
    }
    seenAuthorIds.add(author.id);
  });
  exactKeys(
    profile.identity.ownerSeparation,
    ["required", "deriveOwnerFromAuthor"],
    `${key} owner separation`,
  );

  exactKeys(
    profile.preservation,
    ["notice", "thirdPartyLicenses", "historicalCopyright", "unresolvedHistoricalAction"],
    `${key} preservation`,
  );
  exactKeys(profile.commercial, ["enabled", "triggerCondition"], `${key} commercial`);
  return profile;
}

async function loadRegistry(profilesRoot) {
  if (typeof profilesRoot !== "string" || !profilesRoot) {
    throw invalidParamsError("profilesRoot must be a non-empty path string");
  }
  let registry;
  try {
    registry = JSON.parse(await readFileContained(profilesRoot, LICENSING_REGISTRY_FILE, { encoding: "utf8" }));
  } catch (cause) {
    throw kitError(
      KIT_ERROR_KINDS.CONTRACT_PARSE_FAILED,
      "licensing profile registry is missing or invalid JSON",
      { registry: LICENSING_REGISTRY_FILE, cause: cause?.message },
    );
  }
  const schema = await loadSchema(profilesRoot);
  // schema.json is executed here at runtime; it is the mechanical
  // authority on registry shape and allowed policy values.
  const validated = validateAgainstSchema(registry, schema, "licensing profile registry");
  for (const profile of validated.profiles) validateLicensingProfile(profile);
  const actualKeys = validated.profiles.map((profile) => `${profile.profile.id}/${profile.profile.variant}`);
  if (new Set(actualKeys).size !== actualKeys.length) {
    throw failure("licensing profile registry contains duplicate profile variants", { keys: actualKeys });
  }
  return validated;
}

/**
 * Loads one licensing profile by id (and optional variant) from a profiles
 * root. When profileId is omitted, the FIRST variant declared in the
 * registry is selected: the default is a data fact, never a hardcoded name.
 * A profile with multiple variants still requires an explicit variant.
 */
export async function loadLicensingProfile({ profilesRoot, profileId, variant } = {}) {
  const registry = await loadRegistry(profilesRoot);
  if (profileId === undefined || profileId === null || profileId === "") {
    const [first] = registry.profiles;
    return structuredClone(first);
  }
  if (typeof profileId !== "string" || !KEBAB_PATTERN.test(profileId)) {
    throw invalidParamsError("profileId must be a kebab-case string");
  }
  const candidates = registry.profiles.filter((profile) => profile.profile.id === profileId);
  if (candidates.length === 0) {
    throw failure(`unknown licensing profile: ${profileId}`, {
      available: registry.profiles.map((profile) => `${profile.profile.id}/${profile.profile.variant}`),
    });
  }
  let resolvedVariant = variant;
  if (resolvedVariant === undefined || resolvedVariant === null || resolvedVariant === "") {
    if (candidates.length !== 1 || candidates[0].profile.variant !== "default") {
      throw failure(`variant is required for licensing profile ${profileId}`, {
        allowedVariants: candidates.map((profile) => profile.profile.variant),
      });
    }
    resolvedVariant = "default";
  }
  const match = candidates.find((profile) => profile.profile.variant === resolvedVariant);
  if (!match) {
    throw failure(`unknown variant "${resolvedVariant}" for profile "${profileId}"`, {
      allowedVariants: candidates.map((profile) => profile.profile.variant),
    });
  }
  return structuredClone(match);
}

export async function listLicensingProfiles(profilesRoot) {
  const registry = await loadRegistry(profilesRoot);
  return registry.profiles.map((profile) => ({
    id: profile.profile.id,
    variant: profile.profile.variant,
    spdx: profile.licensing.spdx,
    authors: profile.identity.authors.map((author) => author.displayName),
  }));
}

function copyrightHolder(profile) {
  return profile.identity.authors.map((author) => author.displayName).join(" and ");
}

/**
 * Renders the LICENSE bytes for a loaded profile. Apache-2.0 is the complete
 * standard license text WITHOUT any project or foundation attribution; author
 * and copyright statements belong to the per-profile generated NOTICE. MIT
 * embeds the profile's own copyright line. Deterministic: same profile data
 * yields identical bytes.
 */
export function generateLicenseContent(profile) {
  validateLicensingProfile(profile);
  if (profile.licensing.spdx === "Apache-2.0") {
    return APACHE_2_TEXT.endsWith("\n") ? APACHE_2_TEXT : `${APACHE_2_TEXT}\n`;
  }
  return MIT_TEMPLATE
    .replaceAll("{{YEAR}}", String(profile.licensing.copyrightYear))
    .replaceAll("{{COPYRIGHT_HOLDER}}", copyrightHolder(profile))
    .replace(/\n?$/, "\n");
}

export function generateNoticeContent(profile, { projectName }) {
  validateLicensingProfile(profile);
  if (!profile.licensing.noticeRequired) return null;
  if (typeof projectName !== "string" || !projectName.trim()) {
    throw invalidParamsError("projectName is required to generate NOTICE");
  }
  return [
    projectName,
    "=".repeat(projectName.length),
    "",
    `Copyright ${profile.licensing.copyrightYear} ${copyrightHolder(profile)}`,
    "",
    "Licensed under the Apache License, Version 2.0.",
    "",
    "Existing NOTICE entries, third-party license notices, and historical",
    "copyright statements must be preserved. Unresolved attribution is reported",
    "for human review and is never deleted or reassigned automatically.",
    "",
  ].join("\n");
}

function normalizeProjections(projections) {
  if (projections === undefined) return [];
  if (!Array.isArray(projections)) {
    throw invalidParamsError("identity projections must be an array");
  }
  return projections.map((projection, index) => {
    exactKeys(projection, ["path", "kind"], `identity projections[${index}]`);
    if (typeof projection.path !== "string"
        || path.posix.isAbsolute(projection.path)
        || projection.path.includes("\\")
        || projection.path.split("/").includes("..")
        || !projection.path.endsWith(".json")) {
      throw invalidParamsError(`identity projection path must be a contained JSON path: ${projection.path}`);
    }
    if (!["plugin-manifest", "marketplace", "public-snapshot"].includes(projection.kind)) {
      throw invalidParamsError(`unknown identity projection kind: ${projection.kind}`);
    }
    return { path: projection.path, kind: projection.kind };
  });
}

export function generateIdentityRecord(profile, { projectId, projectName, projections } = {}) {
  validateLicensingProfile(profile);
  return {
    schemaVersion: 1,
    kind: "skill-family.identity-record",
    project: { id: projectId, name: projectName },
    licensing: {
      spdx: profile.licensing.spdx,
      profile: profile.profile.id,
      variant: profile.profile.variant,
      copyrightYear: profile.licensing.copyrightYear,
    },
    authors: structuredClone(profile.identity.authors),
    displayValue: profile.identity.displayValue,
    copyrightStrategy: profile.licensing.copyrightStrategy,
    ownerSeparation: structuredClone(profile.identity.ownerSeparation),
    preservation: structuredClone(profile.preservation),
    commercial: structuredClone(profile.commercial),
    projections: normalizeProjections(projections),
  };
}
