import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FOUNDATION_PACKAGE_VERSION as CONTRACTS_PACKAGE_VERSION,
  validateDocument,
} from "skill-family-contracts";
import {
  FOUNDATION_PACKAGE_VERSION as HARNESS_PACKAGE_VERSION,
  digestBytes,
  readFileContained,
} from "skill-family-harness-node";
import { kitError, KIT_ERROR_KINDS, invalidParamsError } from "./errors.mjs";
import { KIT_VERSION } from "./version.mjs";
import { validateCapabilityUses } from "./migration.mjs";

const ADOPTION_SCOPES = Object.freeze(["contracts", "harness", "engineering-kit", "profile"]);
const LOCALES = Object.freeze(["en", "zh-CN"]);
const MODES = Object.freeze(["coverage", "project-assessment", "incremental-query", "exact-capability"]);
const CAPABILITY_ID_RE = /^foundation\.[a-z0-9\-]+(?:\.[a-z0-9\-]+)+$/u;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 10;
const DEFAULT_CATALOG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../data/capability-catalog");
const CATALOG_SCHEMA_FILE = "capability-catalog.schema.json";

const DECISION_REQUIREMENTS = Object.freeze({
  allowedDispositions: Object.freeze([
    "direct-adoption",
    "compatibility-layer",
    "keep-business",
    "foundation-gap",
  ]),
  targetCapabilityRequiredFor: Object.freeze(["direct-adoption", "compatibility-layer"]),
  targetCapabilityForbiddenFor: Object.freeze(["keep-business", "foundation-gap"]),
  reasonRequired: true,
});

function asError(message, details = {}) {
  return kitError(KIT_ERROR_KINDS.CAPABILITY_CATALOG_INVALID, message, details);
}

function normalizeText(value) {
  return value.normalize("NFC").replace(/[A-Z]/gu, (character) => character.toLowerCase());
}

function isString(value) {
  return typeof value === "string";
}

function codePointLength(value) {
  return Array.from(value).length;
}

function invalidInput(message, errors = []) {
  return invalidParamsError(message, { reason: "invalid-capability-use-input", errors });
}

async function readCatalogDocument(catalogDir, filename) {
  const filePath = path.join(catalogDir, filename);
  let bytes;
  try {
    const stats = await lstat(filePath);
    if (!stats.isFile()) throw Object.assign(new Error("catalog asset is not a regular file"), { code: "SFC-CATALOG-NONREGULAR" });
    bytes = await readFile(filePath);
  } catch (cause) {
    throw asError(`capability catalog file is unreadable: ${filename}`, { file: filename, cause: cause?.code });
  }
  try {
    return { value: JSON.parse(bytes.toString("utf8")), bytes };
  } catch {
    throw asError(`capability catalog file is not valid JSON: ${filename}`, { file: filename });
  }
}

function semverAtLeast(version, floor) {
  const left = version.split(".").map(Number);
  const right = floor.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return true;
}

function validateCatalogDocument(document, schema, label) {
  let result;
  try {
    result = validateDocument(document, { schema, dialect: "draft-07", policy: "strict" });
  } catch (cause) {
    throw asError(`${label} failed capability catalog schema validation`, { label, cause: cause?.message ?? String(cause) });
  }
  if (!result.valid) throw asError(`${label} failed capability catalog schema validation`, { label, errors: result.errors });
}

function validateCoreSemantics(core) {
  if (core.bundle !== "core" || Object.hasOwn(core, "locale")) throw asError("core catalog bundle is invalid");
  const ids = new Set();
  for (const capability of core.capabilities) {
    if (ids.has(capability.id)) throw asError(`duplicate capability ID: ${capability.id}`);
    ids.add(capability.id);
    let previous = -1;
    for (const scope of capability.adoptionScopes) {
      const index = ADOPTION_SCOPES.indexOf(scope);
      if (index < 0 || index <= previous) throw asError(`capability ${capability.id} adoptionScopes are not ordered`);
      previous = index;
    }
    if (capability.stability !== "unsupported" && !capability.adoptionScopes.includes(capability.layer)) {
      throw asError(`capability ${capability.id} adoptionScopes omit its primary layer`);
    }
  }
  return ids;
}

function validateOverlaySemantics(overlay, expectedLocale, coreIds) {
  if (overlay.bundle !== "locale-overlay" || overlay.locale !== expectedLocale) {
    throw asError(`capability overlay locale mismatch: expected ${expectedLocale}`);
  }
  const ids = new Set();
  for (const capability of overlay.capabilities) {
    if (ids.has(capability.id)) throw asError(`duplicate overlay capability ID: ${capability.id}`);
    ids.add(capability.id);
  }
  if (ids.size !== coreIds.size || [...coreIds].some((id) => !ids.has(id))) {
    throw asError("core and locale overlay capability ID sets differ");
  }
}

function assertPackageVersions() {
  const versions = [KIT_VERSION, CONTRACTS_PACKAGE_VERSION, HARNESS_PACKAGE_VERSION];
  if (versions.some((version) => version !== KIT_VERSION)) {
    throw kitError(KIT_ERROR_KINDS.CONTRACTS_VERSION_MISMATCH, "Foundation package versions are not locked together", {
      versions: { "skill-family-contracts": CONTRACTS_PACKAGE_VERSION, "skill-family-harness-node": HARNESS_PACKAGE_VERSION, "skill-family-engineering-kit": KIT_VERSION },
    });
  }
  return versions[0];
}

/** Loads and validates one core catalog plus exactly one requested locale overlay. */
export async function loadCapabilityCatalog({ catalogDir = DEFAULT_CATALOG_DIR, locale } = {}) {
  if (!LOCALES.includes(locale)) throw invalidParamsError(`unsupported locale: ${String(locale)}`, { reason: "unsupported-locale" });
  const coreDoc = await readCatalogDocument(catalogDir, "capability-catalog.json");
  const overlayDoc = await readCatalogDocument(catalogDir, `capability-catalog.${locale}.json`);
  const schemaDoc = await readCatalogDocument(catalogDir, CATALOG_SCHEMA_FILE);
  if (!schemaDoc.value || schemaDoc.value.$id !== "skill-family.documentation-capability-catalog.schema") {
    throw asError("capability catalog schema is invalid", { file: CATALOG_SCHEMA_FILE });
  }
  validateCatalogDocument(coreDoc.value, schemaDoc.value, "core catalog");
  validateCatalogDocument(overlayDoc.value, schemaDoc.value, "locale overlay");
  const coreIds = validateCoreSemantics(coreDoc.value);
  validateOverlaySemantics(overlayDoc.value, locale, coreIds);
  const version = assertPackageVersions();
  for (const capability of coreDoc.value.capabilities) {
    if (capability.stability !== "unsupported" && !semverAtLeast(version, capability.since)) {
      throw asError(`capability ${capability.id} is newer than the installed Foundation version`, { capability: capability.id });
    }
  }
  const overlayById = new Map(overlayDoc.value.capabilities.map((capability) => [capability.id, capability]));
  const capabilities = coreDoc.value.capabilities.map((core) => ({
    ...core,
    ...(overlayById.get(core.id) ?? {}),
    available: core.stability !== "unsupported" && semverAtLeast(version, core.since),
    entrypoints: core.stability === "unsupported" ? [] : [...core.entrypoints],
    consumerTesting: core.consumerTesting ?? null,
  }));
  capabilities.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return {
    capabilities,
    version,
    catalog: {
      coreSha256: `sha256:${digestBytes(coreDoc.bytes)}`,
      overlaySha256: `sha256:${digestBytes(overlayDoc.bytes)}`,
    },
  };
}

function selectCapabilities(capabilities, scope) {
  const selectedScopes = scope === "all" ? ADOPTION_SCOPES : [scope];
  return capabilities.filter((capability) => capability.adoptionScopes.some((candidate) => selectedScopes.includes(candidate)));
}

function view(capability) {
  return {
    id: capability.id,
    package: capability.package,
    layer: capability.layer,
    adoptionScopes: [...capability.adoptionScopes],
    since: capability.since,
    stability: capability.stability,
    available: capability.available,
    entrypoints: [...capability.entrypoints],
    intent: capability.intent,
    useWhen: [...capability.useWhen],
    doNotUseWhen: [...capability.doNotUseWhen],
    prerequisites: [...capability.prerequisites],
    ownedByCaller: [...capability.ownedByCaller],
    routeElsewhere: [...capability.routeElsewhere],
    consumerTesting: capability.consumerTesting ?? null,
  };
}

function matchCapability(capability, filters) {
  if (!filters || filters.length === 0) return null;
  const normalizedFilters = filters.map(normalizeText);
  const intent = normalizeText(capability.intent);
  const useWhen = capability.useWhen.map(normalizeText);
  const matchedFilters = filters.filter((filter, index) => intent.includes(normalizedFilters[index]) || useWhen.some((text) => text.includes(normalizedFilters[index])));
  if (matchedFilters.length === 0) return null;
  const matchedFields = [];
  if (normalizedFilters.some((filter) => intent.includes(filter))) matchedFields.push("intent");
  if (normalizedFilters.some((filter) => useWhen.some((text) => text.includes(filter)))) matchedFields.push("useWhen");
  return { capabilityId: capability.id, matchedFilters, matchedFields };
}

function assessUse(use, selected) {
  const supportedMatches = [];
  const unsupportedMatches = [];
  const filters = use.catalogFilters ?? [];
  for (const capability of selected) {
    const match = matchCapability(capability, filters);
    if (!match) continue;
    (capability.stability === "unsupported" ? unsupportedMatches : supportedMatches).push(match);
  }
  const matchResult = supportedMatches.length > 0 ? "candidates-found" : unsupportedMatches.length > 0 ? "boundary-found" : "no-text-match";
  const output = {
    useId: use.useId,
    supportedMatches,
    unsupportedMatches,
    matchResult,
    needsDecision: true,
    decision: null,
    decisionRequirements: DECISION_REQUIREMENTS,
  };
  return output;
}

function decisionIsValid(decision) {
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) return false;
  if (!DECISION_REQUIREMENTS.allowedDispositions.includes(decision.disposition)) return false;
  if (typeof decision.reason !== "string" || decision.reason.trim() === "" || decision.reason !== decision.reason.trim()) return false;
  const needsTarget = DECISION_REQUIREMENTS.targetCapabilityRequiredFor.includes(decision.disposition);
  const hasTarget = Object.hasOwn(decision, "targetCapability");
  return needsTarget ? typeof decision.targetCapability === "string" && CAPABILITY_ID_RE.test(decision.targetCapability) : !hasTarget;
}

async function loadUses({ root, usesPath, uses }) {
  let value = uses;
  if (usesPath !== undefined) {
    let bytes;
    try {
      bytes = await readFileContained(root ?? process.cwd(), usesPath);
    } catch (cause) {
      throw cause;
    }
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      value = JSON.parse(text);
    } catch {
      throw invalidInput("uses input must be valid JSON");
    }
    const fields = new Set(["schemaVersion", "kind", "capabilityUses"]);
    if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== 1 || value.kind !== "skill-family.capability-use-input") {
      throw invalidInput("uses input must be a capability-use wrapper");
    }
    const unknown = Object.keys(value).filter((key) => !fields.has(key));
    if (unknown.length > 0 || !Object.hasOwn(value, "capabilityUses")) throw invalidInput("uses input has invalid top-level fields", unknown);
    value = value.capabilityUses;
  } else if (!Array.isArray(value)) {
    throw invalidInput("internal uses input must be an array");
  }
  const result = validateCapabilityUses(value);
  if (!result.valid) throw invalidInput("uses input violates capability use contract", result.errors);
  return value;
}

function ensureModeOptions({ mode, scope, scopeExplicit = false, locale, usesPath, uses, filter, capability, limit, all }) {
  if (!MODES.includes(mode)) throw invalidParamsError(`unknown capability assessment mode: ${String(mode)}`, { reason: "invalid-option-combination" });
  if (!LOCALES.includes(locale)) throw invalidParamsError(`unsupported locale: ${String(locale)}`, { reason: "unsupported-locale" });
  if (scope !== undefined && !ADOPTION_SCOPES.includes(scope) && scope !== "all") throw invalidParamsError(`invalid scope: ${String(scope)}`, { reason: "invalid-scope" });
  if (mode === "exact-capability" && scopeExplicit) throw invalidParamsError("exact-capability forbids scope", { reason: "invalid-option-combination" });
  if (usesPath !== undefined && uses !== undefined) throw invalidParamsError("usesPath and uses are mutually exclusive", { reason: "invalid-option-combination" });
  if (mode === "coverage" && (all !== true || scope === undefined || usesPath !== undefined || uses !== undefined || filter !== undefined || capability !== undefined || limit !== undefined)) throw invalidParamsError("invalid coverage options", { reason: "invalid-option-combination" });
  if (mode === "project-assessment" && (all !== true || scope === undefined || (usesPath === undefined && uses === undefined) || filter !== undefined || capability !== undefined || limit !== undefined)) throw invalidParamsError("invalid project-assessment options", { reason: "invalid-option-combination" });
  if (mode === "incremental-query" && (all === true || usesPath !== undefined || uses !== undefined || capability !== undefined)) throw invalidParamsError("invalid incremental-query options", { reason: "invalid-option-combination" });
  if (mode === "exact-capability" && (all === true || usesPath !== undefined || uses !== undefined || filter !== undefined || limit !== undefined || !isString(capability))) throw invalidParamsError("invalid exact-capability options", { reason: "invalid-option-combination" });
  if (mode !== "exact-capability" && capability !== undefined) throw invalidParamsError("capability is only valid for exact-capability", { reason: "invalid-option-combination" });
  if (filter !== undefined && (!isString(filter) || filter.trim() !== filter || filter.length === 0 || codePointLength(filter) > 200 || filter.includes("\0"))) throw invalidParamsError("filter must be a trimmed non-empty string of at most 200 characters", { reason: "invalid-option-combination" });
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT)) throw invalidParamsError("limit must be an integer from 1 to 10", { reason: "invalid-limit" });
}

/** Builds the deterministic capability-assessment output for all four closed modes. */
export async function buildCapabilityAssessment(options = {}) {
  const mode = options.mode;
  const scope = mode === "exact-capability" ? "all" : options.scope ?? (mode === "incremental-query" ? "all" : undefined);
  const all = options.all ?? (mode === "coverage" || mode === "project-assessment");
  ensureModeOptions({ ...options, mode, scope, all, scopeExplicit: options.scope !== undefined });
  const catalog = await loadCapabilityCatalog({ locale: options.locale });
  const selected = selectCapabilities(catalog.capabilities, scope);
  const supported = selected.filter((capability) => capability.stability !== "unsupported");
  const boundaries = selected.filter((capability) => capability.stability === "unsupported");
  let matchedCapabilities = [];
  let returnedCapabilities = [];
  let useMatrix = [];
  let truncated = false;
  let capabilities = supported;
  let unsupported = boundaries;

  if (mode === "project-assessment") {
    const uses = await loadUses(options);
    useMatrix = uses.map((use) => {
      const row = assessUse(use, selected);
      const matchingDecisions = (options.decisions ?? []).filter((candidate) => candidate?.useId === use.useId);
      // A duplicated decision is not silently resolved by first-wins.  The
      // migration gate reports the relationship finding and this row remains
      // actionable until the consumer leaves exactly one decision.
      const decision = matchingDecisions.length === 1 ? matchingDecisions[0] : null;
      if (decisionIsValid(decision)) {
        row.decision = decision;
        row.needsDecision = false;
      }
      return row;
    });
    const ids = new Set();
    for (const row of useMatrix) for (const match of [...row.supportedMatches, ...row.unsupportedMatches]) ids.add(match.capabilityId);
    matchedCapabilities = selected.filter((capability) => ids.has(capability.id));
    returnedCapabilities = selected;
  } else if (mode === "incremental-query") {
    const filters = options.filter === undefined ? null : [options.filter];
    const matches = filters === null ? selected.map((capability) => ({ capabilityId: capability.id, matchedFilters: [], matchedFields: [] })) : selected.map((capability) => matchCapability(capability, filters)).filter(Boolean);
    matchedCapabilities = matches.map((match) => selected.find((capability) => capability.id === match.capabilityId));
    const limited = matches.slice(0, options.limit ?? DEFAULT_LIMIT);
    truncated = limited.length < matches.length;
    const ids = new Set(limited.map((match) => match.capabilityId));
    capabilities = supported.filter((capability) => ids.has(capability.id));
    unsupported = boundaries.filter((capability) => ids.has(capability.id));
    returnedCapabilities = [...capabilities, ...unsupported];
  } else if (mode === "exact-capability") {
    const target = selected.find((capability) => capability.id === options.capability);
    if (!target) {
      if (!catalog.capabilities.some((capability) => capability.id === options.capability)) throw invalidParamsError(`unknown capability: ${options.capability}`, { reason: "unknown-capability" });
      throw invalidParamsError(`capability is not in the selected scope: ${options.capability}`, { reason: "unknown-capability" });
    }
    capabilities = target.stability === "unsupported" ? [] : [target];
    unsupported = target.stability === "unsupported" ? [target] : [];
    matchedCapabilities = [target];
    returnedCapabilities = [target];
  } else {
    matchedCapabilities = selected;
    returnedCapabilities = selected;
  }

  const output = {
    schemaVersion: 1,
    kind: "skill-family.capability-assessment",
    generatedBy: { tool: "skill-family-engineering-kit", version: catalog.version },
    mode,
    scope,
    locale: options.locale,
    catalog: { schemaVersion: 1, ...catalog.catalog },
    foundationPackages: ["skill-family-contracts", "skill-family-harness-node", "skill-family-engineering-kit"].map((name) => ({ name, version: catalog.version })),
    counts: {
      total: catalog.capabilities.length,
      inScope: selected.length,
      supportedInScope: supported.length,
      boundaryInScope: boundaries.length,
      matched: matchedCapabilities.length,
      returned: returnedCapabilities.length,
      truncated,
    },
    scopeCapabilities: capabilities.map(view),
    scopeBoundaries: unsupported.map(view),
    useMatrix,
  };
  // Internal-only lookup used by adopt-plan to distinguish an out-of-scope
  // target from an unknown capability. It is non-enumerable so the public
  // assessment remains the closed object defined by FND-DES-016.
  Object.defineProperty(output, "allCapabilities", {
    value: catalog.capabilities.map(view),
    enumerable: false,
  });
  return output;
}

export { ADOPTION_SCOPES, LOCALES, MODES };

/**
 * Validate the repeated scaffold capability selection before the target is
 * created.  This is deliberately one batch operation: callers receive no
 * partial selection and scaffold has no opportunity to start writing until
 * every requested ID has passed the same catalog/version checks.
 */
export async function resolveScaffoldCapabilities(capabilities = []) {
  if (!Array.isArray(capabilities)) {
    throw invalidParamsError("capabilities must be an array", { reason: "invalid-option-combination" });
  }
  const requested = [...new Set(capabilities)];
  if (requested.some((value) => typeof value !== "string" || value.length === 0)) {
    throw invalidParamsError("capability must be a non-empty string", { reason: "invalid-option-combination" });
  }
  requested.sort();
  if (requested.length === 0) {
    return { selectedCapabilities: [], generatedContractTests: [], selectionWarnings: [], capabilities: [] };
  }
  const catalog = await loadCapabilityCatalog({ locale: "en" });
  const byId = new Map(catalog.capabilities.map((capability) => [capability.id, capability]));
  for (const capabilityId of requested) {
    const capability = byId.get(capabilityId);
    if (!capability) {
      throw invalidParamsError(`unknown capability: ${capabilityId}`, { reason: "unknown-capability", capabilityId });
    }
    if (capability.stability !== "stable") {
      throw invalidParamsError(`capability is not stable: ${capabilityId}`, { reason: "capability-not-stable", capabilityId });
    }
    if (capability.available !== true) {
      throw invalidParamsError(`capability is not available: ${capabilityId}`, { reason: "capability-not-available", capabilityId });
    }
  }
  const generatedContractTests = [];
  const selectionWarnings = [];
  for (const capability of requested.map((id) => byId.get(id))) {
    const testing = capability.consumerTesting ?? null;
    if (!testing) {
      selectionWarnings.push({ capabilityId: capability.id, reason: "consumer-testing-unavailable" });
      continue;
    }
    const filename = capability.id === "foundation.contracts.object-validation"
      ? "object-validation.test.mjs"
      : capability.id === "foundation.harness.atomic-write"
        ? "atomic-write.test.mjs"
        : null;
    if (filename) generatedContractTests.push({ capabilityId: capability.id, path: `test/foundation-contract/${filename}` });
  }
  return {
    selectedCapabilities: requested,
    generatedContractTests,
    selectionWarnings,
    capabilities: requested.map((id) => byId.get(id)),
  };
}
