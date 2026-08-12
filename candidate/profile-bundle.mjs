import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CONTRACTS_VERSION,
  canonicalJson,
} from "skill-family-contracts";
import {
  QUICKSTART_PROFILE_ID,
  QUICKSTART_PROFILE_VERSION,
} from "skill-family-contracts/candidate/quickstart-profile";
import { digestBytes } from "skill-family-harness-node";

/**
 * Candidate Quickstart Profile v2 offline bundle builder (unstable).
 *
 * The bundle replaces the v1 node_modules half-closure with a self-contained,
 * deterministically generated projection:
 *
 *  - the Harness quickstart mechanisms and their minimal source closure are
 *    projected verbatim from the real Foundation sources, with imports
 *    rewritten through a fixed bundle map;
 *  - canonical digest, JSON-boundary probe, and error-normalization code keep
 *    their original Foundation bytes (fixed-anchor extraction, never a second
 *    hand-written algorithm);
 *  - the precisely locked Ajv 8.20.0 generates ESM standalone validators at
 *    build time; the runtime carries no Ajv package, only the generated code
 *    plus the mechanically projected `ucs2length` / `equal` / fast-deep-equal
 *    helpers it actually references;
 *  - consumer schemas join the same $id index under strict fail-closed rules
 *    (unique $id, supported dialect, no cross-dialect refs, date-time only);
 *  - provenance binds repository/base-commit identities, every Foundation and
 *    third-party source that influences the output, each consumer schema, and
 *    the payload set (excluding the provenance file itself).
 *
 * The builder only reads; it never consults the network, the clock, or Git.
 * The returned entries are ordinary `skill-family.projection-manifest`
 * entries; runProjection remains the only writer and authorization boundary.
 */

const DEFAULT_TARGET_PREFIX = "foundation/quickstart-profile";
const PROVENANCE_FILE = "foundation-projection.json";
// Internal Ajv standalone-codegen replacement anchor only: it must not parse
// as an npm scope/package coordinate (no "@" scope form, no valid package
// name), it is never added to the public coordinate allowlist, and it never
// survives into the final bundle bytes — rewriteGeneratedRequires replaces
// every occurrence with a hoisted bundle-relative ESM import.
const FORMAT_RUNTIME_SPECIFIER = "__SKILL_FAMILY_BUNDLE_FORMAT_RUNTIME__";

// The Ajv `_` codegen tag serializes interpolated values, so the formats
// require below is written literally; this guard keeps the literal and the
// dependency-map specifier aligned.
if (!'require("__SKILL_FAMILY_BUNDLE_FORMAT_RUNTIME__").default'.includes(FORMAT_RUNTIME_SPECIFIER)) {
  throw new Error("FORMAT_RUNTIME_SPECIFIER drifted from the formats code literal");
}

const FOUNDATION_SCHEMA_FILES = Object.freeze([
  ["protocol.json", "schemas/foundation/protocol.json"],
  ["resource.schema.json", "schemas/foundation/resource.schema.json"],
  ["task.schema.json", "schemas/foundation/task.schema.json"],
  ["result.schema.json", "schemas/foundation/result.schema.json"],
]);

const HARNESS_IMPORT_MAP = new Map([
  ["skill-family-contracts", "../contracts/index.mjs"],
  ["skill-family-contracts/candidate/quickstart-profile", "../contracts-candidate/index.mjs"],
  ["../src/closure.mjs", "./closure.mjs"],
  ["../src/errors.mjs", "./errors.mjs"],
]);

const DIALECT_URIS = Object.freeze({
  "draft-07": "http://json-schema.org/draft-07/schema#",
  "2020-12": "https://json-schema.org/draft/2020-12/schema",
});

const SUPPORTED_FORMATS = Object.freeze(["date-time"]);

// These fragments are the exact case-sensitive words rejected by the
// bundle-wide byte scan. Caller-provided source identities enter provenance
// verbatim, so they must pass the same boundary before bundle assembly.
const FORBIDDEN_SOURCE_IDENTITY_FRAGMENTS = Object.freeze([
  "skill-family-audit",
  "conformance",
  "behavior",
  "runtime-audit",
  "release-audit",
  "operation: audit",
]);
const C0_CONTROL_PATTERN = /[\u0000-\u001f]/u;

const requireFromKit = createRequire(import.meta.url);

function buildError(message) {
  return new TypeError(`buildQuickstartProfileProjection: ${message}`);
}

// ---------------------------------------------------------------------------
// Input classification.
// ---------------------------------------------------------------------------

// Relative POSIX path: one or more segments of [A-Za-z0-9._-]. The segment
// charset mechanically excludes absolute paths, backslashes, and NUL bytes;
// the explicit segment check additionally excludes "." and "..".
const CONTAINED_POSIX_PATH_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

function assertContainedPosixPath(value, label) {
  if (
    typeof value !== "string" ||
    !CONTAINED_POSIX_PATH_PATTERN.test(value) ||
    value.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw buildError(`${label} must be a contained relative POSIX path: ${JSON.stringify(value)}`);
  }
  return value;
}

function assertSourceIdentity(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw buildError(`${label} must be a non-empty caller-provided identity string`);
  }
  if (C0_CONTROL_PATTERN.test(value)) {
    throw buildError(`${label} must not contain C0 control characters`);
  }
  const classified = value.trim();
  if (
    path.posix.isAbsolute(classified) ||
    path.win32.isAbsolute(classified) ||
    /^file:/iu.test(classified)
  ) {
    throw buildError(`${label} must not be an absolute path or file: URL`);
  }
  if (FORBIDDEN_SOURCE_IDENTITY_FRAGMENTS.some((fragment) => value.includes(fragment))) {
    throw buildError(`${label} must not contain a forbidden bundle word`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Source location and contained reads.
// ---------------------------------------------------------------------------

async function packageRootOf(entryPath, expectedName) {
  let cursor = path.dirname(entryPath);
  while (true) {
    try {
      const document = JSON.parse(await readFile(path.join(cursor, "package.json"), "utf8"));
      if (document.name === expectedName) return { root: cursor, packageJson: document };
    } catch {
      // Keep walking to the package boundary.
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error(`cannot resolve package root for ${expectedName}`);
    cursor = parent;
  }
}

async function foundationPackageRoots() {
  const contractsEntry = requireFromKit.resolve("skill-family-contracts");
  const harnessEntry = requireFromKit.resolve("skill-family-harness-node");
  const contracts = await packageRootOf(contractsEntry, "skill-family-contracts");
  const harness = await packageRootOf(harnessEntry, "skill-family-harness-node");
  const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  return { contracts, harness, kitRoot };
}

async function readSourceText(root, relPath) {
  return readFile(path.join(root, relPath), "utf8");
}

/**
 * Reads one consumer schema file. The absolute root is only a read anchor and
 * never enters any output byte; containment is re-proven lexically and by
 * realpath so links cannot escape the consumer schema root.
 */
async function readConsumerSchema(root, relPath) {
  const rootReal = await realpath(root);
  const absPath = path.resolve(rootReal, relPath);
  let stats;
  try {
    stats = await stat(absPath);
  } catch {
    throw buildError(`consumer schema does not exist: ${relPath}`);
  }
  if (!stats.isFile()) {
    throw buildError(`consumer schema is not a regular file: ${relPath}`);
  }
  const fileReal = await realpath(absPath);
  if (fileReal !== rootReal && !fileReal.startsWith(`${rootReal}${path.sep}`)) {
    throw buildError(`consumer schema escapes the consumer schema root: ${relPath}`);
  }
  return readFile(absPath, "utf8");
}

// The pnpm version comes exclusively from the installed kit package's own
// managed package.json. Real pnpm pack strips packageManager from tarballs,
// so the tarball-safe pin lives in the managed engines.pnpm field. In a
// consumer install layout kitRoot is node_modules/skill-family-engineering-kit,
// so any upward or sibling read would hit consumer-owned files; the builder
// never does that and never falls back to the consumer package, the workspace
// root, environment variables, subprocesses, Git, network, or a hardcoded
// version constant.
async function readPnpmVersion(kitRoot) {
  let kitPackageJson;
  try {
    kitPackageJson = JSON.parse(await readFile(path.join(kitRoot, "package.json"), "utf8"));
  } catch {
    throw new Error(
      "buildQuickstartProfileProjection: the kit package.json is unreadable, and it alone pins the pnpm version",
    );
  }
  const engines = kitPackageJson.engines;
  const pinned =
    engines !== null && typeof engines === "object" && !Array.isArray(engines)
      ? engines.pnpm
      : undefined;
  if (typeof pinned !== "string" || !/^\d+\.\d+\.\d+$/.test(pinned)) {
    throw new Error(
      "buildQuickstartProfileProjection: the kit package.json must pin engines.pnpm as an exact x.y.z version",
    );
  }
  return pinned;
}

// ---------------------------------------------------------------------------
// Fixed-anchor source extraction (bytes carried unchanged into the bundle).
// ---------------------------------------------------------------------------

function extractFunctionBlock(sourceText, functionName) {
  const marker = `function ${functionName}(`;
  const start = sourceText.indexOf(marker);
  if (start === -1) throw new Error(`bundle source extraction failed: ${functionName} not found`);
  const openBrace = sourceText.indexOf("{", start);
  if (openBrace === -1) throw new Error(`bundle source extraction failed: ${functionName} has no body`);
  let depth = 0;
  for (let index = openBrace; index < sourceText.length; index += 1) {
    const char = sourceText[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return sourceText.slice(start, index + 1);
    }
  }
  throw new Error(`bundle source extraction failed: ${functionName} body is unbalanced`);
}

function extractRegion(sourceText, startMarker, endMarker) {
  const start = sourceText.indexOf(startMarker);
  if (start === -1) throw new Error(`bundle source extraction failed: start marker not found: ${startMarker}`);
  const end = sourceText.indexOf(endMarker, start + startMarker.length);
  if (end === -1) throw new Error(`bundle source extraction failed: end marker not found: ${endMarker}`);
  return sourceText.slice(start, end + endMarker.length);
}

// ---------------------------------------------------------------------------
// Schema-graph intake (fail-closed).
// ---------------------------------------------------------------------------

// Schema-valued keyword positions per supported dialect. Ordinary-data
// keywords (const, enum, examples, default, required, title, ...) are never
// descended into, so data that merely looks like a schema (for example
// { const: { format: "uri" } } or { examples: [{ $ref: "ordinary-data" }] })
// stays data. Boolean subschemas are valid schemas with nothing to scan.
const SCHEMA_POSITION_KEYWORDS = Object.freeze({
  "draft-07": Object.freeze({
    single: Object.freeze([
      "not",
      "contains",
      "additionalProperties",
      "additionalItems",
      "propertyNames",
      "if",
      "then",
      "else",
    ]),
    singleOrArray: Object.freeze(["items"]),
    arrayOfSchemas: Object.freeze(["allOf", "anyOf", "oneOf"]),
    schemaMap: Object.freeze(["properties", "patternProperties", "definitions", "dependencies"]),
  }),
  "2020-12": Object.freeze({
    single: Object.freeze([
      "not",
      "contains",
      "additionalProperties",
      "propertyNames",
      "if",
      "then",
      "else",
      "unevaluatedItems",
      "unevaluatedProperties",
      "contentSchema",
    ]),
    singleOrArray: Object.freeze(["items"]),
    arrayOfSchemas: Object.freeze(["allOf", "anyOf", "oneOf", "prefixItems"]),
    schemaMap: Object.freeze(["properties", "patternProperties", "$defs", "dependentSchemas"]),
  }),
});

function walkSchema(node, dialect, visit) {
  if (typeof node === "boolean") return;
  if (node === null || typeof node !== "object" || Array.isArray(node)) return;
  visit(node);
  const positions = SCHEMA_POSITION_KEYWORDS[dialect];
  for (const keyword of positions.single) {
    const child = node[keyword];
    if (child !== undefined) walkSchema(child, dialect, visit);
  }
  for (const keyword of positions.singleOrArray) {
    const child = node[keyword];
    if (child === undefined) continue;
    if (Array.isArray(child)) {
      for (const item of child) walkSchema(item, dialect, visit);
    } else {
      walkSchema(child, dialect, visit);
    }
  }
  for (const keyword of positions.arrayOfSchemas) {
    const child = node[keyword];
    if (Array.isArray(child)) {
      for (const item of child) walkSchema(item, dialect, visit);
    }
  }
  for (const keyword of positions.schemaMap) {
    const child = node[keyword];
    if (child === null || typeof child !== "object" || Array.isArray(child)) continue;
    for (const item of Object.values(child)) walkSchema(item, dialect, visit);
  }
}

function dialectOf(schema, relPath) {
  const uri = schema.$schema;
  for (const [dialect, dialectUri] of Object.entries(DIALECT_URIS)) {
    if (uri === dialectUri) return dialect;
  }
  throw buildError(
    `consumer schema ${relPath} must declare $schema as one of the supported dialect URIs` +
      ` (${Object.values(DIALECT_URIS).join(", ")}), got ${JSON.stringify(uri)}`,
  );
}

function scanFormats(schema, relPath, dialect) {
  walkSchema(schema, dialect, (node) => {
    const format = node.format;
    if (format === undefined) return;
    if (typeof format !== "string" || !SUPPORTED_FORMATS.includes(format)) {
      throw buildError(
        `consumer schema ${relPath} uses unsupported format ${JSON.stringify(format)};` +
          ` only ${SUPPORTED_FORMATS.join(", ")} is implemented by Foundation`,
      );
    }
  });
}

/**
 * Ref intake is fail-closed but not literal-URL-only: local fragment refs
 * stay allowed, and every other ref is resolved with standard URL resolution
 * against the owning top-level schema $id before matching the known-$id
 * index. A ref such as "detail.json" inside a schema whose $id is
 * https://consumer.example/v1/request.json therefore resolves to
 * https://consumer.example/v1/detail.json.
 */
function scanRefs(schema, relPath, dialect, idsByDialect, allKnownIds) {
  walkSchema(schema, dialect, (node) => {
    const ref = node.$ref;
    if (typeof ref !== "string" || ref.length === 0) return;
    if (ref.startsWith("#")) return;
    let resolved;
    try {
      resolved = new URL(ref, schema.$id).href;
    } catch {
      throw buildError(
        `consumer schema ${relPath} uses an unresolvable $ref: ${JSON.stringify(ref)}`,
      );
    }
    const hashIndex = resolved.indexOf("#");
    const base = hashIndex === -1 ? resolved : resolved.slice(0, hashIndex);
    if (base.length === 0) return;
    if (!allKnownIds.has(base)) {
      throw buildError(`consumer schema ${relPath} references an unknown $id: ${JSON.stringify(base)}`);
    }
    if (idsByDialect.get(base) !== dialect) {
      throw buildError(`consumer schema ${relPath} crosses JSON Schema dialects via $ref: ${JSON.stringify(base)}`);
    }
  });
}

function buildSchemaGraph(consumerRecords, foundationSchemaDocuments) {
  const idsByDialect = new Map();
  const allKnownIds = new Set();
  const claim = (schemaId, dialect, where) => {
    if (allKnownIds.has(schemaId)) {
      throw buildError(`duplicate schema $id in the bundle graph: ${schemaId} (${where})`);
    }
    allKnownIds.add(schemaId);
    idsByDialect.set(schemaId, dialect);
  };
  for (const { document } of foundationSchemaDocuments) {
    claim(document.$id, "2020-12", "foundation schema");
  }
  const byDialect = { "draft-07": [], "2020-12": [] };
  for (const record of consumerRecords) {
    const schema = record.document;
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
      throw buildError(`consumer schema ${record.path} must be a JSON object`);
    }
    if (typeof schema.$id !== "string" || schema.$id.length === 0) {
      throw buildError(`consumer schema ${record.path} must declare a non-empty $id`);
    }
    record.dialect = dialectOf(schema, record.path);
    claim(schema.$id, record.dialect, `consumer schema ${record.path}`);
    byDialect[record.dialect].push(record);
  }
  for (const record of consumerRecords) {
    scanFormats(record.document, record.path, record.dialect);
    scanRefs(record.document, record.path, record.dialect, idsByDialect, allKnownIds);
  }
  const sortById = (a, b) => (a.document.$id < b.document.$id ? -1 : 1);
  byDialect["draft-07"].sort(sortById);
  byDialect["2020-12"].sort(sortById);
  return byDialect;
}

// ---------------------------------------------------------------------------
// Standalone validator generation.
// ---------------------------------------------------------------------------

function ajvOptions(codegen) {
  return {
    code: { source: true, esm: true, ...(codegen ?? {}) },
    coerceTypes: false,
    useDefaults: false,
    allErrors: true,
    validateFormats: true,
    strict: true,
  };
}

/**
 * Ajv emits CJS-flavoured `require("<specifier>").default` initializers inside
 * the ESM standalone source. Each occurrence is rewritten through the fixed
 * bundle dependency map and hoisted into a real ESM default import; anything
 * outside the map fails the build.
 */
function rewriteGeneratedRequires(code, runtimeDependencyMap) {
  const imports = [];
  const bindings = new Map();
  const rewritten = code.replace(/require\("([^"]+)"\)\.default/g, (whole, specifier) => {
    const target = runtimeDependencyMap.get(specifier);
    if (!target) {
      throw new Error(`standalone validator generated an unmapped runtime dependency: ${specifier}`);
    }
    let binding = bindings.get(specifier);
    if (!binding) {
      binding = `__bundleDependency${bindings.size}`;
      bindings.set(specifier, binding);
      imports.push(`import ${binding} from "${target}";`);
    }
    return binding;
  });
  if (/require\(/.test(rewritten)) {
    throw new Error(
      `standalone validator generated an unexpected require() form: ` +
        [...rewritten.matchAll(/require\([^)]*\)\.?[a-zA-Z]*/g)].map((m) => m[0]).join(" | "),
    );
  }
  if (imports.length === 0) return rewritten;
  const strictMarker = '"use strict";';
  if (!rewritten.startsWith(strictMarker)) {
    throw new Error("standalone validator output missing the strict marker");
  }
  return `${strictMarker}\n${imports.join("\n")}\n${rewritten.slice(strictMarker.length)}`;
}

async function generateStandaloneModule({
  AjvCtor,
  schemas,
  runtimeDependencyMap,
  codegenTemplate,
  standaloneCode,
  isValidDateTime,
}) {
  // Both supported dialects register the same mechanically projected
  // date-time implementation; the generated ESM references the same
  // bundle-relative format runtime through FORMAT_RUNTIME_SPECIFIER.
  const options = ajvOptions({
    formats: codegenTemplate`require("__SKILL_FAMILY_BUNDLE_FORMAT_RUNTIME__").default`,
  });
  const ajv = new AjvCtor(options);
  ajv.addFormat("date-time", { type: "string", validate: isValidDateTime });
  const ordered = [...schemas].sort((a, b) => (a.$id < b.$id ? -1 : 1));
  for (const schema of ordered) ajv.addSchema(schema);
  for (const schema of ordered) {
    if (!ajv.getSchema(schema.$id)) {
      throw new Error(`standalone generation failed to compile schema: ${schema.$id}`);
    }
  }
  const moduleMap = Object.fromEntries(ordered.map((schema, index) => [`validate${index}`, schema.$id]));
  const raw = standaloneCode(ajv, moduleMap);
  return rewriteGeneratedRequires(raw, runtimeDependencyMap);
}

// ---------------------------------------------------------------------------
// Generated runtime module sources.
// ---------------------------------------------------------------------------

const IMPORT_SPECIFIER_PATTERN = /(?:import|export)[^;]*?from\s*"([^"]+)"/g;

function projectModuleWithImportMap(sourceText, importMap, sourceLabel) {
  let projected = sourceText;
  for (const [from, to] of importMap) {
    projected = projected.replaceAll(`"${from}"`, `"${to}"`);
  }
  for (const match of projected.matchAll(IMPORT_SPECIFIER_PATTERN)) {
    const specifier = match[1];
    if (specifier.startsWith("node:")) continue;
    if (specifier.startsWith("./") || specifier.startsWith("../")) continue;
    throw new Error(
      `bundle projection of ${sourceLabel} left an unmapped import specifier: ${specifier}`,
    );
  }
  return projected;
}

function contractsIndexSource() {
  return [
    "// Fixed bundle surface: the exact stable contracts exports consumed by the",
    "// projected quickstart harness, re-exported from mechanically projected sources.",
    "export {",
    "  ContractsError,",
    "  ERROR_CODES,",
    "  errorCodeRegistry,",
    "  errorCodeInfo,",
    "  isRegisteredErrorCode,",
    "  assertRegisteredErrorCode,",
    "  stableError,",
    '} from "./errors.mjs";',
    'export { canonicalJson, digestDocument } from "./canonical.mjs";',
    "",
  ].join("\n");
}

function canonicalSource(auditSurfaceSourceText) {
  const algorithmSet = extractRegion(
    auditSurfaceSourceText,
    "/** Frozen digest algorithm set",
    'Object.freeze(["sha256"]);',
  );
  const region = extractRegion(
    auditSurfaceSourceText,
    "/**\n * Canonical JSON serialization",
    '.digest("hex");\n}',
  );
  if (
    !region.includes("export function canonicalJson(") ||
    !region.includes("export function digestDocument(")
  ) {
    throw new Error("bundle source extraction failed: canonical region is incomplete");
  }
  return `import { createHash } from "node:crypto";\n\n${algorithmSet}\n\n${region}\n`;
}

function jsonBoundarySource(candidateIndexSourceText) {
  const region = extractRegion(
    candidateIndexSourceText,
    "function normalizeErrors(",
    'return probeJsonValue(value, "", new Set());\n}',
  );
  if (
    !region.includes("function escapePointerSegment(") ||
    !region.includes("export function findNonJsonValue(")
  ) {
    throw new Error("bundle source extraction failed: JSON boundary region is incomplete");
  }
  return [
    "// Verbatim projection of the candidate JSON-boundary probe and the Ajv error",
    "// normalization from the contracts candidate validation entry.",
    region,
    "export { normalizeErrors as normalizeValidationError };",
    "",
  ].join("\n");
}

function formatsSource(candidateIndexSourceText) {
  const patternDeclaration = extractRegion(candidateIndexSourceText, "const DATE_TIME_PATTERN =", ";");
  const isValidDateTime = extractFunctionBlock(candidateIndexSourceText, "isValidDateTime");
  return [
    "// Verbatim projection of the Foundation date-time format implementation.",
    "// Each format entry carries the shape Ajv standalone codegen consumes:",
    "// a record whose validate member is the projected implementation.",
    patternDeclaration,
    "",
    isValidDateTime,
    "",
    'const FORMATS = Object.freeze({ "date-time": Object.freeze({ validate: isValidDateTime }) });',
    "",
    "export default FORMATS;",
    "",
  ].join("\n");
}

// The standalone-validator binding transform replaces the frozen Ajv-backed
// getCollection implementation. The digest pins every byte of that source
// function: a rename, an added statement, or any other body drift fails the
// projection closed instead of being silently discarded by the replacement.
const GET_COLLECTION_AJV_SOURCE_SHA256 =
  "21308a4660e3706ff4e9ce1a08ac98b3d1422d779867665a4d6f651b9ddc39ad";

const GET_COLLECTION_STANDALONE_BINDING = `function getCollection() {
  if (collection) return collection;
  const bound = {};
  for (const kind of VALIDATE_KINDS) {
    const validate = standaloneValidators[documents[kind].$id];
    if (typeof validate !== "function") {
      throw new Error(
        \`standalone validator is missing the quickstart profile schema: \${documents[kind].$id}\`,
      );
    }
    bound[kind] = validate;
  }
  collection = Object.freeze(bound);
  return collection;
}`;

/**
 * Deterministic projection of the real contracts candidate validation entry.
 * The full source text is the only input; the sole allowed transforms are the
 * Ajv build-time dependency, the registry lookup import, the schema load
 * paths, and the standalone-validator binding. Each transform has a unique
 * anchor and must hit exactly once: a missing or repeated anchor fails the
 * build closed instead of emitting a stale or partial wrapper.
 */
function projectContractsCandidateIndex(sourceText) {
  let projected = sourceText;
  const applyOnce = (anchor, replacement, label) => {
    const hits = projected.split(anchor).length - 1;
    if (hits !== 1) {
      throw new Error(
        `contracts candidate projection failed: the ${label} anchor matched ${hits} times (expected exactly 1)`,
      );
    }
    projected = projected.replace(anchor, () => replacement);
  };
  applyOnce(
    'import Ajv2020 from "ajv/dist/2020.js";',
    'import standaloneValidators from "../generated/standalone-map.mjs";',
    "Ajv build-time dependency",
  );
  applyOnce(
    'import { findSchemaRegistration } from "../../src/registry.mjs";\n',
    "",
    "stable registry lookup import",
  );
  for (const [fileName] of FOUNDATION_SCHEMA_FILES) {
    applyOnce(
      `load("${fileName}")`,
      `load("../../schemas/foundation/${fileName}")`,
      `schema load path ${fileName}`,
    );
  }

  const getCollectionMarker = "function getCollection(";
  const getCollectionHits = projected.split(getCollectionMarker).length - 1;
  if (getCollectionHits !== 1) {
    throw new Error(
      `contracts candidate projection failed: getCollection matched ${getCollectionHits} times (expected exactly 1)`,
    );
  }
  const getCollectionSource = extractFunctionBlock(projected, "getCollection");
  const getCollectionDigest = digestBytes(Buffer.from(getCollectionSource, "utf8"));
  if (getCollectionDigest !== GET_COLLECTION_AJV_SOURCE_SHA256) {
    throw new Error(
      `contracts candidate projection failed: getCollection body digest drifted: ${getCollectionDigest}`,
    );
  }
  applyOnce(
    getCollectionSource,
    GET_COLLECTION_STANDALONE_BINDING,
    "standalone validator binding",
  );
  for (const leftover of [
    "Ajv2020",
    "findSchemaRegistration",
    "addFormat",
    "addSchema",
    "ajv/dist/2020.js",
    "../../src/registry.mjs",
  ]) {
    if (projected.includes(leftover)) {
      throw new Error(
        `contracts candidate projection left an Ajv-era binding behind: ${leftover}`,
      );
    }
  }
  return projected;
}

function standaloneMapSource({ entries2020, entriesDraft07 }) {
  const lines = [
    "// Fixed dispatch: every registered schema $id mapped to its generated",
    "// standalone validator function.",
    'import * as validate202012 from "./validate-2020-12.mjs";',
  ];
  if (entriesDraft07.length > 0) {
    lines.push('import * as validateDraft07 from "./validate-draft-07.mjs";');
  }
  lines.push("", "const STANDALONE_VALIDATORS = Object.freeze({");
  for (const entry of entries2020) {
    lines.push(`  ${JSON.stringify(entry.schemaId)}: validate202012.${entry.exportName},`);
  }
  for (const entry of entriesDraft07) {
    lines.push(`  ${JSON.stringify(entry.schemaId)}: validateDraft07.${entry.exportName},`);
  }
  lines.push("});", "", "export default STANDALONE_VALIDATORS;", "");
  return lines.join("\n");
}

function validatorsSource() {
  return `import standaloneValidators from "./runtime/generated/standalone-map.mjs";
import { findNonJsonValue, normalizeValidationError } from "./runtime/json-boundary.mjs";

/** Every schema $id compiled into this bundle (Foundation graph + consumer schemas). */
export function listValidatableSchemaIds() {
  return Object.keys(standaloneValidators).sort();
}

/**
 * Validates one document against the schema registered under schemaId.
 * Unknown $ids are a caller error (TypeError). Validation never mutates the
 * caller input; the returned errors carry only plain JSON fields and expose
 * no validator instance or shared mutable state.
 */
export function validateBySchemaId(schemaId, document) {
  if (typeof schemaId !== "string" || !Object.hasOwn(standaloneValidators, schemaId)) {
    throw new TypeError(\`validateBySchemaId: unknown schema $id: \${String(schemaId)}\`);
  }
  const target = document === undefined ? null : document;
  const jsonIssue = findNonJsonValue(target);
  if (jsonIssue) {
    return {
      valid: false,
      errors: [
        {
          keyword: "json-value",
          instancePath: jsonIssue.instancePath,
          schemaPath: "#",
          message: \`value is not representable as JSON: \${jsonIssue.reason}\`,
          params: { reason: jsonIssue.reason },
        },
      ],
    };
  }
  const validate = standaloneValidators[schemaId];
  const clone = structuredClone(target);
  const valid = validate(clone) === true;
  return {
    valid,
    errors: valid ? [] : normalizeValidationError(validate.errors),
  };
}
`;
}

function runnerSource() {
  return [
    "// Quickstart Profile v2 offline runner: the projected Foundation harness",
    "// mechanisms and the standalone-backed candidate validation entry.",
    'export * from "./runtime/harness/quickstart-profile.mjs";',
    'export { validateQuickstartProfileDocument } from "./runtime/contracts-candidate/index.mjs";',
    "",
  ].join("\n");
}

function ucs2lengthSource(ajvRuntimeSourceText) {
  const body = extractFunctionBlock(ajvRuntimeSourceText, "ucs2length");
  return `${body}\nexport default ucs2length;\n`;
}

function equalSource() {
  return 'import equal from "../fast-deep-equal/index.mjs";\nexport default equal;\n';
}

function fastDeepEqualSource(indexJsSourceText) {
  const exportLine = "module.exports = function equal(";
  if (!indexJsSourceText.includes(exportLine)) {
    throw new Error("fast-deep-equal index.js has an unexpected layout");
  }
  return indexJsSourceText.replace(exportLine, "export default function equal(");
}

function noticeSource(licenseRecords) {
  const lines = [
    "Foundation Quickstart Profile offline bundle: third-party notice.",
    "Each entry lists the package actually carried in runtime/, the locked",
    "version, the projected source files, and the license file in licenses/.",
    "",
  ];
  for (const record of licenseRecords) {
    lines.push(
      `- ${record.name} ${record.version}`,
      `  source files: ${record.sourceFiles.join(", ")}`,
      `  license file: ${record.licenseFile}`,
      "",
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Builder.
// ---------------------------------------------------------------------------

/**
 * Build the deterministic, offline Quickstart Profile v2 bundle.
 *
 * Inputs are explicit and caller-frozen: a contained target prefix, the
 * consumer schema root plus relative schema paths (read only at build time),
 * and the caller-provided source repository / base commit identities. The
 * builder fails closed and returns no half manifest on any violation.
 */
export async function buildQuickstartProfileProjection({
  targetPrefix = DEFAULT_TARGET_PREFIX,
  consumerSchemaRoot,
  consumerSchemaPaths,
  sourceRepository,
  sourceBaseCommit,
} = {}) {
  const prefix = assertContainedPosixPath(targetPrefix, "targetPrefix");
  if (typeof consumerSchemaRoot !== "string" || !path.isAbsolute(consumerSchemaRoot)) {
    throw buildError("consumerSchemaRoot must be an absolute build-time directory");
  }
  if (!Array.isArray(consumerSchemaPaths) || consumerSchemaPaths.length === 0) {
    throw buildError("consumerSchemaPaths must carry at least one schema");
  }
  const normalizedPaths = consumerSchemaPaths.map((relPath) =>
    assertContainedPosixPath(relPath, "consumer schema path"),
  );
  if (new Set(normalizedPaths).size !== normalizedPaths.length) {
    throw buildError("consumerSchemaPaths contains a duplicate path");
  }
  normalizedPaths.sort();
  const repository = assertSourceIdentity(sourceRepository, "sourceRepository");
  const baseCommit = assertSourceIdentity(sourceBaseCommit, "sourceBaseCommit");

  const roots = await foundationPackageRoots();
  const contractsRoot = roots.contracts.root;
  const harnessRoot = roots.harness.root;
  const kitRoot = roots.kitRoot;

  // --- Foundation source reads (every byte that can influence the output). ---
  const sources = {};
  sources.auditSurface = await readSourceText(contractsRoot, "src/audit-surface.mjs");
  sources.contractsIndex = await readSourceText(contractsRoot, "src/index.mjs");
  sources.contractsErrors = await readSourceText(contractsRoot, "src/errors.mjs");
  sources.errorCodes = await readSourceText(contractsRoot, "src/error-codes.json");
  sources.operationRequest = await readSourceText(contractsRoot, "src/schemas/operation-request.schema.json");
  sources.operationResult = await readSourceText(contractsRoot, "src/schemas/operation-result.schema.json");
  sources.candidateIndex = await readSourceText(contractsRoot, "candidate/quickstart-profile/index.mjs");
  const candidateSchemaTexts = {};
  for (const [fileName] of FOUNDATION_SCHEMA_FILES) {
    candidateSchemaTexts[fileName] = await readSourceText(
      contractsRoot,
      `candidate/quickstart-profile/${fileName}`,
    );
  }
  sources.harnessIndex = await readSourceText(harnessRoot, "src/index.mjs");
  sources.harnessCandidate = await readSourceText(harnessRoot, "candidate/quickstart-profile.mjs");
  sources.harnessClosure = await readSourceText(harnessRoot, "src/closure.mjs");
  sources.harnessErrors = await readSourceText(harnessRoot, "src/errors.mjs");
  sources.harnessPaths = await readSourceText(harnessRoot, "src/paths.mjs");
  // The package manifests are recorded as complete original bytes below, so
  // every provenance path digest recomputes from the real file.
  const contractsPackageJsonText = await readSourceText(contractsRoot, "package.json");
  const harnessPackageJsonText = await readSourceText(harnessRoot, "package.json");
  const kitPackageJsonText = await readSourceText(kitRoot, "package.json");
  const contractsVersion = JSON.parse(contractsPackageJsonText).version;
  const kitBuilderSource = await readSourceText(kitRoot, "candidate/profile-bundle.mjs");
  const kitCliSource = await readSourceText(kitRoot, "candidate/projection-bundle-cli.mjs");

  // --- Consumer schema intake (contained reads; the absolute root never
  // --- enters any output byte). ---
  const consumerRecords = [];
  for (const relPath of normalizedPaths) {
    const text = await readConsumerSchema(consumerSchemaRoot, relPath);
    let document;
    try {
      document = JSON.parse(text);
    } catch {
      throw buildError(`consumer schema is not valid JSON: ${relPath}`);
    }
    consumerRecords.push({ path: relPath, sha256: digestBytes(Buffer.from(text, "utf8")), document });
  }

  const foundationSchemaDocuments = [
    { name: "operation-request", text: sources.operationRequest },
    { name: "operation-result", text: sources.operationResult },
    ...["resource.schema.json", "task.schema.json", "result.schema.json"].map((fileName) => ({
      name: fileName,
      text: candidateSchemaTexts[fileName],
    })),
  ].map((entry) => ({ name: entry.name, document: JSON.parse(entry.text) }));

  const graph = buildSchemaGraph(consumerRecords, foundationSchemaDocuments);

  // --- Standalone validator generation (Ajv build dependency only). ---
  const fromContracts = createRequire(pathToFileURL(path.join(contractsRoot, "package.json")));
  const ajvEntry = fromContracts.resolve("ajv");
  const ajv = await packageRootOf(ajvEntry, "ajv");
  const fromAjv = createRequire(pathToFileURL(path.join(ajv.root, "package.json")));
  const fastDeepEqual = await packageRootOf(fromAjv.resolve("fast-deep-equal"), "fast-deep-equal");
  const importDefault = async (resolved) => (await import(pathToFileURL(resolved).href)).default;
  const AjvDraft07 = await importDefault(ajvEntry);
  const Ajv2020 = await importDefault(fromContracts.resolve("ajv/dist/2020.js"));
  const standaloneCode = await importDefault(fromContracts.resolve("ajv/dist/standalone"));
  const codegenModule = await import(pathToFileURL(fromContracts.resolve("ajv/dist/compile/codegen")).href);
  const codegenTemplate = codegenModule._ ?? codegenModule.default._;

  // The build-time date-time implementation is imported from the very module
  // text that ships in the bundle (data URL), so build-time and runtime
  // formats are byte-identical without any dynamic code compilation.
  const formatsModuleSource = formatsSource(sources.candidateIndex);
  const formatsModule = await import(`data:text/javascript,${encodeURIComponent(formatsModuleSource)}`);
  const isValidDateTime = formatsModule.default["date-time"].validate;

  const runtimeDependencyMap = new Map([
    ["ajv/dist/runtime/ucs2length", "../ajv/ucs2length.mjs"],
    ["ajv/dist/runtime/equal", "../ajv/equal.mjs"],
    [FORMAT_RUNTIME_SPECIFIER, "./formats.mjs"],
  ]);

  const schemas2020 = [
    ...foundationSchemaDocuments.map((entry) => entry.document),
    ...graph["2020-12"].map((record) => record.document),
  ];
  const generated2020 = await generateStandaloneModule({
    AjvCtor: Ajv2020,
    schemas: schemas2020,
    runtimeDependencyMap,
    codegenTemplate,
    standaloneCode,
    isValidDateTime,
  });
  const schemasDraft07 = graph["draft-07"].map((record) => record.document);
  const withDraft07 = schemasDraft07.length > 0;
  const generatedDraft07 = withDraft07
    ? await generateStandaloneModule({
        AjvCtor: AjvDraft07,
        schemas: schemasDraft07,
        runtimeDependencyMap,
        codegenTemplate,
        standaloneCode,
        isValidDateTime,
      })
    : null;

  // --- Runtime helpers actually referenced by the generated code. ---
  const carriesUcs2length =
    generated2020.includes("../ajv/ucs2length.mjs") || (generatedDraft07 ?? "").includes("../ajv/ucs2length.mjs");
  const carriesEqual =
    generated2020.includes("../ajv/equal.mjs") || (generatedDraft07 ?? "").includes("../ajv/equal.mjs");
  const ajvUcs2lengthSource = carriesUcs2length ? await readSourceText(ajv.root, "dist/runtime/ucs2length.js") : null;
  const ajvLicense = await readSourceText(ajv.root, "LICENSE");
  const ajvPackageJsonText = await readSourceText(ajv.root, "package.json");
  const fastDeepEqualIndex = carriesEqual ? await readSourceText(fastDeepEqual.root, "index.js") : null;
  const fastDeepEqualLicense = carriesEqual ? await readSourceText(fastDeepEqual.root, "LICENSE") : null;
  const fastDeepEqualPackageJsonText = carriesEqual
    ? await readSourceText(fastDeepEqual.root, "package.json")
    : null;

  // --- Bundle assembly (all members are deterministic functions of the
  // --- frozen inputs; code-unit ordering everywhere). ---
  const files = new Map();
  const setText = (relPath, text) => {
    if (files.has(relPath)) throw new Error(`duplicate bundle member: ${relPath}`);
    files.set(relPath, text);
  };

  setText("runner.mjs", runnerSource());
  setText("validators.mjs", validatorsSource());
  for (const [fileName, bundlePath] of FOUNDATION_SCHEMA_FILES) {
    setText(bundlePath, candidateSchemaTexts[fileName]);
  }
  setText("schemas/foundation/operation-request.schema.json", sources.operationRequest);
  setText("schemas/foundation/operation-result.schema.json", sources.operationResult);
  for (const record of consumerRecords) {
    setText(`schemas/consumer/${record.path}`, `${JSON.stringify(record.document, null, 2)}\n`);
  }
  setText(
    "runtime/harness/quickstart-profile.mjs",
    projectModuleWithImportMap(sources.harnessCandidate, HARNESS_IMPORT_MAP, "harness candidate/quickstart-profile.mjs"),
  );
  setText("runtime/harness/closure.mjs", projectModuleWithImportMap(sources.harnessClosure, new Map(), "harness src/closure.mjs"));
  setText(
    "runtime/harness/errors.mjs",
    projectModuleWithImportMap(sources.harnessErrors, new Map([["skill-family-contracts", "../contracts/index.mjs"]]), "harness src/errors.mjs"),
  );
  setText("runtime/harness/paths.mjs", projectModuleWithImportMap(sources.harnessPaths, new Map(), "harness src/paths.mjs"));
  setText("runtime/contracts/index.mjs", contractsIndexSource());
  setText("runtime/contracts/errors.mjs", sources.contractsErrors);
  setText("runtime/contracts/error-codes.json", sources.errorCodes);
  setText("runtime/contracts/canonical.mjs", canonicalSource(sources.auditSurface));
  setText("runtime/contracts-candidate/index.mjs", projectContractsCandidateIndex(sources.candidateIndex));
  setText("runtime/json-boundary.mjs", jsonBoundarySource(sources.candidateIndex));
  setText("runtime/generated/validate-2020-12.mjs", generated2020);
  if (withDraft07) {
    setText("runtime/generated/validate-draft-07.mjs", generatedDraft07);
  }
  const sortById = (a, b) => (a.$id < b.$id ? -1 : 1);
  const entries2020 = [...schemas2020]
    .sort(sortById)
    .map((schema, index) => ({ schemaId: schema.$id, exportName: `validate${index}` }));
  const entriesDraft07 = [...schemasDraft07]
    .sort(sortById)
    .map((schema, index) => ({ schemaId: schema.$id, exportName: `validate${index}` }));
  setText("runtime/generated/standalone-map.mjs", standaloneMapSource({ entries2020, entriesDraft07 }));
  setText("runtime/generated/formats.mjs", formatsModuleSource);
  if (carriesUcs2length) {
    setText("runtime/ajv/ucs2length.mjs", ucs2lengthSource(ajvUcs2lengthSource));
  }
  if (carriesEqual) {
    setText("runtime/ajv/equal.mjs", equalSource());
    setText("runtime/fast-deep-equal/index.mjs", fastDeepEqualSource(fastDeepEqualIndex));
  }

  const licenseRecords = [
    {
      name: "ajv",
      version: ajv.packageJson.version,
      licenseFile: "licenses/ajv-LICENSE",
      sourceFiles: [
        ...(carriesUcs2length ? ["ajv/dist/runtime/ucs2length.js"] : []),
        "generated standalone validator code",
      ],
    },
  ];
  if (carriesEqual) {
    licenseRecords.push({
      name: "fast-deep-equal",
      version: fastDeepEqual.packageJson.version,
      licenseFile: "licenses/fast-deep-equal-LICENSE",
      sourceFiles: ["fast-deep-equal/index.js"],
    });
  }
  licenseRecords.sort((a, b) => (a.name < b.name ? -1 : 1));
  setText("licenses/ajv-LICENSE", ajvLicense);
  if (carriesEqual) {
    setText("licenses/fast-deep-equal-LICENSE", fastDeepEqualLicense);
  }
  setText("licenses/NOTICE", noticeSource(licenseRecords));

  // --- Provenance (payload digest excludes the provenance file itself). ---
  const payloadFiles = [...files.entries()]
    .map(([filePath, text]) => ({ path: filePath, sha256: digestBytes(Buffer.from(text, "utf8")) }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  const sha256Of = (text) => digestBytes(Buffer.from(text, "utf8"));
  const foundationRecords = [
    ["packages/skill-family-contracts/package.json", contractsPackageJsonText, "identity"],
    ["packages/skill-family-contracts/src/index.mjs", sources.contractsIndex, "imported-surface"],
    ["packages/skill-family-contracts/src/schemas/operation-request.schema.json", sources.operationRequest, "projected"],
    ["packages/skill-family-contracts/src/schemas/operation-result.schema.json", sources.operationResult, "projected"],
    ["packages/skill-family-contracts/src/errors.mjs", sources.contractsErrors, "projected"],
    ["packages/skill-family-contracts/src/error-codes.json", sources.errorCodes, "projected"],
    ["packages/skill-family-contracts/src/audit-surface.mjs", sources.auditSurface, "extraction-input"],
    ["packages/skill-family-contracts/candidate/quickstart-profile/protocol.json", candidateSchemaTexts["protocol.json"], "projected"],
    ["packages/skill-family-contracts/candidate/quickstart-profile/resource.schema.json", candidateSchemaTexts["resource.schema.json"], "projected"],
    ["packages/skill-family-contracts/candidate/quickstart-profile/task.schema.json", candidateSchemaTexts["task.schema.json"], "projected"],
    ["packages/skill-family-contracts/candidate/quickstart-profile/result.schema.json", candidateSchemaTexts["result.schema.json"], "projected"],
    ["packages/skill-family-contracts/candidate/quickstart-profile/index.mjs", sources.candidateIndex, "extraction-input"],
    ["packages/skill-family-harness-node/package.json", harnessPackageJsonText, "identity"],
    ["packages/skill-family-harness-node/src/index.mjs", sources.harnessIndex, "imported-surface"],
    ["packages/skill-family-harness-node/candidate/quickstart-profile.mjs", sources.harnessCandidate, "projected"],
    ["packages/skill-family-harness-node/src/closure.mjs", sources.harnessClosure, "projected"],
    ["packages/skill-family-harness-node/src/errors.mjs", sources.harnessErrors, "projected"],
    ["packages/skill-family-harness-node/src/paths.mjs", sources.harnessPaths, "projected"],
    ["packages/skill-family-engineering-kit/package.json", kitPackageJsonText, "identity"],
    ["packages/skill-family-engineering-kit/candidate/profile-bundle.mjs", kitBuilderSource, "builder"],
    ["packages/skill-family-engineering-kit/candidate/projection-bundle-cli.mjs", kitCliSource, "builder"],
  ]
    .map(([recordPath, text, role]) => ({ path: recordPath, sha256: sha256Of(text), role }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  const thirdPartyRecords = [
    ["ajv/package.json", ajvPackageJsonText, "identity"],
    ["ajv/LICENSE", ajvLicense, "license"],
    ...(carriesUcs2length ? [["ajv/dist/runtime/ucs2length.js", ajvUcs2lengthSource, "projected"]] : []),
    ...(carriesEqual
      ? [
          ["fast-deep-equal/package.json", fastDeepEqualPackageJsonText, "identity"],
          ["fast-deep-equal/LICENSE", fastDeepEqualLicense, "license"],
          ["fast-deep-equal/index.js", fastDeepEqualIndex, "projected"],
        ]
      : []),
  ]
    .map(([recordPath, text, role]) => ({ path: recordPath, sha256: sha256Of(text), role }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));

  const provenance = {
    schemaVersion: 1,
    kind: "skill-family.foundation-projection",
    profile: {
      id: QUICKSTART_PROFILE_ID,
      version: QUICKSTART_PROFILE_VERSION,
      contractsVersion: CONTRACTS_VERSION,
    },
    source: {
      repository,
      baseCommit,
      foundation: foundationRecords,
      thirdParty: thirdPartyRecords,
      consumerSchemas: consumerRecords
        .map((record) => ({
          path: record.path,
          $id: record.document.$id,
          dialect: record.dialect,
          sha256: record.sha256,
        }))
        .sort((a, b) => (a.path < b.path ? -1 : 1)),
    },
    toolchain: {
      node: process.version,
      pnpm: await readPnpmVersion(kitRoot),
      ajv: ajv.packageJson.version,
      fastDeepEqual: fastDeepEqual.packageJson.version,
    },
    licenses: licenseRecords,
    payload: {
      digestAlgorithm: "sha256",
      files: payloadFiles,
      digest: digestBytes(Buffer.from(canonicalJson(payloadFiles), "utf8")),
    },
  };
  setText(PROVENANCE_FILE, `${JSON.stringify(provenance, null, 2)}\n`);

  const entries = [...files.entries()]
    .map(([filePath, text]) => ({ path: `${prefix}/${filePath}`, text }))
    .sort((a, b) => (a.path < b.path ? -1 : 1))
    .map(({ path: entryPath, text }) => ({
      path: entryPath,
      content: { text },
      expect: { state: "absent" },
    }));
  return {
    manifest: {
      schemaVersion: 1,
      kind: "skill-family.projection-manifest",
      entries,
    },
    provenance,
  };
}

export const QUICKSTART_PROFILE_TARGET_PREFIX = DEFAULT_TARGET_PREFIX;
