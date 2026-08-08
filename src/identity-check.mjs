import { readdir } from "node:fs/promises";
import path from "node:path";
import { readFileContained } from "skill-family-harness-node";
import { loadLicensingProfile } from "./licensing.mjs";

const CODE = "SFC2004";
const PROJECTION_KINDS = new Set(["plugin-manifest", "marketplace", "public-snapshot"]);
const COMMERCIAL_PAYLOAD_NAMES = new Set([
  "ee",
  "EULA",
  "EULA.md",
  "ENTERPRISE-LICENSE",
  "ENTERPRISE-LICENSE.md",
  "LICENSE.enterprise",
]);

const IDENTITY_SOURCE_PRIORITY = Object.freeze([
  "identity-record",
  "package.json",
  "license",
  "manifest",
  "marketplace",
  "snapshot",
  "readme",
  "notice",
]);

function finding(kind, message, source, details = {}) {
  return { kind, code: CODE, message, source, ...details };
}

async function readJson(rootAbs, relPath) {
  try {
    const raw = await readFileContained(rootAbs, relPath, { encoding: "utf8" });
    return { state: "ok", value: JSON.parse(raw) };
  } catch (cause) {
    if (cause instanceof SyntaxError) return { state: "invalid", cause: cause.message };
    return { state: "missing", cause: cause?.message };
  }
}

export async function loadIdentityRecord(rootAbs) {
  for (const relPath of ["skill-family.identity-record.json", "identity-record.json"]) {
    const loaded = await readJson(rootAbs, relPath);
    if (loaded.state === "ok" && loaded.value?.kind === "skill-family.identity-record") {
      return loaded.value;
    }
  }
  return null;
}

export async function loadPackageJson(rootAbs) {
  const loaded = await readJson(rootAbs, "package.json");
  return loaded.state === "ok" ? loaded.value : null;
}

export async function loadManifest(rootAbs, manifestName) {
  const loaded = await readJson(rootAbs, manifestName);
  return loaded.state === "ok" ? loaded.value : null;
}

export async function loadReadme(rootAbs) {
  try {
    return await readFileContained(rootAbs, "README.md", { encoding: "utf8" });
  } catch {
    return null;
  }
}

function authorValue(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof value.name === "string") return value.name;
  return null;
}

function checkIdentityFields(record, document, findings, source, { requireLicense = true, requireAuthor = true } = {}) {
  const expectedLicense = record.licensing.spdx;
  const expectedAuthor = record.displayValue;
  const actualLicense = document?.license ?? document?.metadata?.license ?? null;
  const actualAuthor = authorValue(document?.author ?? document?.metadata?.author);
  const developerName = document?.developerName
    ?? document?.interface?.developerName
    ?? document?.metadata?.developerName
    ?? null;

  if (requireLicense && actualLicense === null) {
    findings.push(finding("license-missing", `${source} does not declare license`, source, {
      expected: expectedLicense,
    }));
  } else if (actualLicense !== null && actualLicense !== expectedLicense) {
    findings.push(finding("license-drift", `${source} license does not match identity record`, source, {
      expected: expectedLicense,
      actual: actualLicense,
    }));
  }

  if (requireAuthor && actualAuthor === null) {
    findings.push(finding("author-missing", `${source} does not declare author`, source, {
      expected: expectedAuthor,
    }));
  } else if (actualAuthor !== null && actualAuthor !== expectedAuthor) {
    findings.push(finding("author-drift", `${source} author does not match identity record`, source, {
      expected: expectedAuthor,
      actual: actualAuthor,
    }));
  }

  if (developerName !== null && developerName !== expectedAuthor) {
    findings.push(finding("developer-name-drift", `${source} developerName does not match identity record`, source, {
      expected: expectedAuthor,
      actual: developerName,
    }));
  }
}

function selectProjectionDocument(record, projection, rootDocument, findings) {
  if (projection.kind === "plugin-manifest") return rootDocument;
  const candidates = Array.isArray(rootDocument)
    ? rootDocument
    : Array.isArray(rootDocument?.plugins)
      ? rootDocument.plugins
      : Array.isArray(rootDocument?.marketplace?.plugins)
        ? rootDocument.marketplace.plugins
        : null;
  if (candidates) {
    const matches = candidates.filter((entry) => entry?.name === record.project.id);
    if (matches.length !== 1) {
      findings.push(finding(
        "projection-target-mismatch",
        `${projection.path} must contain exactly one entry named ${record.project.id}`,
        projection.path,
        { matchCount: matches.length },
      ));
      return null;
    }
    return matches[0];
  }
  if (rootDocument?.name === record.project.id) return rootDocument;
  findings.push(finding(
    "projection-target-mismatch",
    `${projection.path} is not a direct ${record.project.id} document and has no plugins array`,
    projection.path,
  ));
  return null;
}

function validateProjectionDeclaration(projection, index, findings) {
  const source = `identity-record.projections[${index}]`;
  if (!projection || typeof projection !== "object" || Array.isArray(projection)) {
    findings.push(finding("projection-declaration-invalid", `${source} must be an object`, source));
    return false;
  }
  if (Object.keys(projection).sort().join(",") !== "kind,path") {
    findings.push(finding("projection-declaration-invalid", `${source} fields must be exactly kind and path`, source));
    return false;
  }
  if (typeof projection.path !== "string"
      || path.posix.isAbsolute(projection.path)
      || projection.path.includes("\\")
      || projection.path.split("/").includes("..")
      || !projection.path.endsWith(".json")) {
    findings.push(finding(
      "projection-path-invalid",
      `${source} must declare a contained JSON path; JavaScript sources such as plugins.mjs are forbidden`,
      source,
      { path: projection.path },
    ));
    return false;
  }
  if (!PROJECTION_KINDS.has(projection.kind)) {
    findings.push(finding("projection-kind-invalid", `${source} has an unknown kind`, source, {
      kind: projection.kind,
    }));
    return false;
  }
  return true;
}

async function checkDeclaredProjections(rootAbs, record, findings, sources) {
  // Projections are opt-in: records without a projections array simply declare
  // none. Generated records always carry the array (possibly empty).
  if (record.projections === undefined) return;
  if (!Array.isArray(record.projections)) {
    findings.push(finding(
      "projection-declarations-missing",
      "identity record must declare projections as an array",
      "identity-record",
    ));
    return;
  }
  for (const [index, projection] of record.projections.entries()) {
    if (!validateProjectionDeclaration(projection, index, findings)) continue;
    const loaded = await readJson(rootAbs, projection.path);
    sources.projections.push({ path: projection.path, kind: projection.kind, state: loaded.state });
    if (loaded.state !== "ok") {
      findings.push(finding(
        loaded.state === "invalid" ? "projection-json-invalid" : "projection-missing",
        `declared identity projection cannot be read as JSON: ${projection.path}`,
        projection.path,
      ));
      continue;
    }
    const document = selectProjectionDocument(record, projection, loaded.value, findings);
    if (document) checkIdentityFields(record, document, findings, projection.path);
  }
}

function checkReadmeDrift(record, readme, findings) {
  const expectedLicenseMarker = `Licensed under ${record.licensing.spdx}`;
  if (!readme.includes(expectedLicenseMarker)) {
    findings.push(finding(
      "readme-license-drift",
      `README must contain the exact marker "${expectedLicenseMarker}"`,
      "README.md",
      { expected: expectedLicenseMarker },
    ));
  }
  if (!readme.includes(record.displayValue)) {
    findings.push(finding(
      "readme-author-drift",
      `README does not mention author "${record.displayValue}"`,
      "README.md",
      { expected: record.displayValue },
    ));
  }
}

async function checkLicense(rootAbs, record, findings) {
  let text;
  try {
    text = await readFileContained(rootAbs, "LICENSE", { encoding: "utf8" });
  } catch {
    findings.push(finding("license-file-missing", "LICENSE is missing", "LICENSE"));
    return;
  }
  const authorNames = Array.isArray(record.authors)
    ? record.authors.map((author) => author?.displayName).filter((name) => typeof name === "string" && name)
    : [];
  if (record.licensing.spdx === "Apache-2.0") {
    const required = [
      "Apache License",
      "Version 2.0, January 2004",
      "TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION",
      "1. Definitions.",
      "9. Accepting Warranty or Additional Liability.",
      "APPENDIX: How to apply the Apache License to your work.",
    ];
    if (required.some((marker) => !text.includes(marker))) {
      findings.push(finding(
        "license-file-drift",
        "LICENSE is not the complete Apache License 2.0 text",
        "LICENSE",
        { expected: "Apache-2.0 complete legal text" },
      ));
    }
  } else {
    const required = [
      "MIT License",
      "Permission is hereby granted, free of charge",
      "THE SOFTWARE IS PROVIDED \"AS IS\"",
    ];
    if (record.licensing.copyrightYear !== undefined) {
      required.push(`Copyright (c) ${record.licensing.copyrightYear} ${record.displayValue}`);
    }
    if (required.some((marker) => !text.includes(marker))
        || authorNames.some((name) => !text.includes(name))) {
      findings.push(finding(
        "license-file-drift",
        "LICENSE does not match the MIT identity record",
        "LICENSE",
        { expected: "MIT text with the identity record copyright line" },
      ));
    }
  }
}

async function checkNotice(rootAbs, record, findings) {
  if (record.licensing.spdx !== "Apache-2.0") return;
  try {
    const notice = await readFileContained(rootAbs, "NOTICE", { encoding: "utf8" });
    const yearDrift = record.licensing.copyrightYear !== undefined
      && !notice.includes(String(record.licensing.copyrightYear));
    if (!notice.includes(record.displayValue) || yearDrift) {
      findings.push(finding(
        "notice-drift",
        "NOTICE does not retain the identity record author and copyright year",
        "NOTICE",
      ));
    }
  } catch {
    findings.push(finding("notice-missing", "NOTICE is required for the Apache-2.0 profile", "NOTICE"));
  }
}

const COPYRIGHT_LINE_PATTERN = /^Copyright(?:\s+\([cC]\))?\s+(?:\d{4}\s+)?(.+)$/;

/**
 * Detects attribution that does not belong to this project's
 * authors (foreign project attribution smuggled into NOTICE). Findings are
 * report-only: historical NOTICE entries and third-party licenses are
 * preserved and must be resolved by human adjudication, never deleted or
 * reassigned automatically.
 */
async function checkExternalAttribution(rootAbs, record, findings) {
  let notice;
  try {
    notice = await readFileContained(rootAbs, "NOTICE", { encoding: "utf8" });
  } catch {
    return;
  }
  const ours = [
    ...(Array.isArray(record.authors)
      ? record.authors.map((author) => author?.displayName).filter((name) => typeof name === "string" && name)
      : []),
  ];
  if (typeof record.displayValue === "string" && record.displayValue) ours.push(record.displayValue);
  for (const rawLine of notice.split("\n")) {
    const line = rawLine.trim();
    const match = COPYRIGHT_LINE_PATTERN.exec(line);
    if (!match) continue;
    const holder = match[1].trim();
    if (ours.some((name) => holder.includes(name))) continue;
    findings.push(finding(
      "external-attribution-present",
      "NOTICE contains a copyright statement outside the identity record authors; reported for human review and never deleted automatically",
      "NOTICE",
      { line },
    ));
  }
}

function ownerSeparationEnforced(ownerSeparation) {
  return stableJson(ownerSeparation) === stableJson({
    required: true,
    deriveOwnerFromAuthor: false,
  });
}

function checkOwnerSeparation(record, findings) {
  if (!ownerSeparationEnforced(record.ownerSeparation)) {
    findings.push(finding(
      "owner-separation-drift",
      "owner must remain an independent repository coordinate and must not be derived from author",
      "identity-record",
      { expected: { required: true, deriveOwnerFromAuthor: false }, actual: record.ownerSeparation },
    ));
  }
  if (!Array.isArray(record.authors) || record.authors.length === 0) {
    findings.push(finding("missing-authors", "identity record has no authors", "identity-record"));
  } else if (record.authors.some((author) => author?.role === "owner")) {
    findings.push(finding(
      "owner-as-author",
      "owner roles are forbidden in the author list",
      "identity-record",
    ));
  }
}

async function checkCommercialBoundary(rootAbs, record, findings) {
  if (record.commercial?.enabled !== false) {
    findings.push(finding(
      "commercial-payload-not-authorized",
      "commercial payload is disabled until a future explicit product decision",
      "identity-record",
    ));
  }
  let entries = [];
  try {
    entries = await readdir(rootAbs);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (COMMERCIAL_PAYLOAD_NAMES.has(entry)) {
      findings.push(finding(
        "commercial-payload-present",
        `commercial artifact "${entry}" exists while the profile is disabled`,
        entry,
      ));
    }
  }
}

export async function checkIdentityDrift({ rootAbs, identityRecord } = {}) {
  const findings = [];
  const record = identityRecord ?? await loadIdentityRecord(rootAbs);
  if (!record) {
    return {
      ok: false,
      findings: [finding(
        "identity-record-missing",
        "identity record not found; cannot perform identity drift check",
        "identity-record",
      )],
      record: null,
      sources: {},
    };
  }

  const sources = { packageJson: false, readme: false, license: false, notice: false, projections: [] };
  const packageLoaded = await readJson(rootAbs, "package.json");
  if (packageLoaded.state === "ok") {
    sources.packageJson = true;
    checkIdentityFields(record, packageLoaded.value, findings, "package.json");
  } else {
    findings.push(finding("package-json-missing", "package.json is missing or invalid", "package.json"));
  }

  const readme = await loadReadme(rootAbs);
  if (readme === null) {
    findings.push(finding("readme-missing", "README.md is missing", "README.md"));
  } else {
    sources.readme = true;
    checkReadmeDrift(record, readme, findings);
  }

  await checkLicense(rootAbs, record, findings);
  sources.license = !findings.some((item) => item.source === "LICENSE" && item.kind === "license-file-missing");
  await checkNotice(rootAbs, record, findings);
  sources.notice = record.licensing.spdx !== "Apache-2.0"
    || !findings.some((item) => item.source === "NOTICE" && item.kind === "notice-missing");
  await checkExternalAttribution(rootAbs, record, findings);
  checkOwnerSeparation(record, findings);
  await checkCommercialBoundary(rootAbs, record, findings);
  await checkDeclaredProjections(rootAbs, record, findings, sources);

  return { ok: findings.length === 0, findings, record, sources };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function compareExact(findings, source, label, actual, expected, kind) {
  if (stableJson(actual) !== stableJson(expected)) {
    findings.push(finding(kind, `${label} does not match the selected licensing profile`, source, {
      expected,
      actual,
    }));
  }
}

function checkRecordAuthors(record, profile, findings) {
  const authors = Array.isArray(record.authors) ? record.authors : [];
  if (authors.some((author) => author?.role === "owner")) {
    findings.push(finding(
      "owner-as-author",
      "owner roles are forbidden in the author list; owner is an independent coordinate",
      "identity-record",
    ));
  }
  const expectedKeys = new Set(profile.identity.authors.map((author) => stableJson(author)));
  const actualKeys = new Set(authors.map((author) => stableJson(author)));
  const lost = [...expectedKeys].filter((key) => !actualKeys.has(key));
  if (lost.length > 0) {
    findings.push(finding(
      "second-author-lost",
      "author set drops authors declared by the selected licensing profile",
      "identity-record",
      { expected: profile.identity.authors, actual: authors },
    ));
    return;
  }
  const extra = [...actualKeys].filter((key) => !expectedKeys.has(key));
  if (extra.length > 0 || stableJson(authors) !== stableJson(profile.identity.authors)) {
    findings.push(finding(
      "authors-profile-drift",
      "authors do not match the selected licensing profile",
      "identity-record",
      { expected: profile.identity.authors, actual: authors },
    ));
  }
}

export async function validateIdentityAgainstProfile(record, profilesRoot) {
  const findings = [];
  if (!record || typeof record !== "object" || !record.licensing) {
    return {
      ok: false,
      findings: [finding("identity-record-invalid", "identity record is invalid", "identity-record")],
    };
  }

  let profile;
  try {
    profile = await loadLicensingProfile({
      profilesRoot,
      profileId: record.licensing.profile,
      variant: record.licensing.variant,
    });
  } catch (cause) {
    return {
      ok: false,
      findings: [finding(
        "unknown-profile",
        `identity record does not resolve to a valid licensing profile: ${cause.message}`,
        "identity-record",
      )],
    };
  }

  const spdx = record.licensing.spdx;
  if (typeof spdx !== "string" || spdx !== profile.licensing.spdx) {
    findings.push(finding("invalid-spdx", "licensing spdx does not match the selected licensing profile", "identity-record", {
      expected: profile.licensing.spdx,
      actual: spdx,
    }));
  }
  if (record.licensing.profile !== profile.profile.id || record.licensing.variant !== profile.profile.variant) {
    findings.push(finding("licensing-profile-drift", "licensing profile coordinate does not match the selected licensing profile", "identity-record", {
      expected: { profile: profile.profile.id, variant: profile.profile.variant },
      actual: { profile: record.licensing.profile, variant: record.licensing.variant },
    }));
  }
  if (record.licensing.copyrightYear !== profile.licensing.copyrightYear) {
    findings.push(finding("licensing-profile-drift", "licensing copyrightYear does not match the selected licensing profile", "identity-record", {
      expected: profile.licensing.copyrightYear,
      actual: record.licensing.copyrightYear,
    }));
  }

  checkRecordAuthors(record, profile, findings);

  compareExact(findings, "identity-record", "displayValue", record.displayValue, profile.identity.displayValue, "display-value-drift");
  compareExact(
    findings,
    "identity-record",
    "copyrightStrategy",
    record.copyrightStrategy,
    profile.licensing.copyrightStrategy,
    "copyright-strategy-drift",
  );
  compareExact(
    findings,
    "identity-record",
    "ownerSeparation",
    record.ownerSeparation,
    profile.identity.ownerSeparation,
    "owner-separation-drift",
  );
  compareExact(findings, "identity-record", "preservation", record.preservation, profile.preservation, "preservation-drift");
  compareExact(findings, "identity-record", "commercial", record.commercial, profile.commercial, "commercial-policy-drift");

  if (!Array.isArray(record.projections)) {
    findings.push(finding(
      "projection-declarations-missing",
      "identity record must declare projections as an array",
      "identity-record",
    ));
  } else {
    for (const [index, projection] of record.projections.entries()) {
      validateProjectionDeclaration(projection, index, findings);
    }
  }

  return { ok: findings.length === 0, findings, profile };
}

export { IDENTITY_SOURCE_PRIORITY };
