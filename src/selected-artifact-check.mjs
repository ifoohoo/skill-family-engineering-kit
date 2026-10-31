import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { compileSchema, ContractsError, findSchemaByObject, SUPPORTED_DIALECTS, validateDocument } from "skill-family-contracts";
import { computeResourceClosure, readFileStrict } from "skill-family-harness-node";
import { invalidParamsError } from "./errors.mjs";
import { KIT_TOOL_NAME, KIT_VERSION } from "./skeleton.mjs";
import { resolveTargetRoot } from "./workspace.mjs";

const LIMITATIONS = [
  "Only caller-selected document schemas and trusted byte baselines were checked; unselected checks are not performed.",
  "The caller owns actual schema adoption, baseline trust, version-to-file facts, platform semantics and selection completeness. Version labels are not extracted content versions or host support certification.",
  "This read-only check does not scan the target tree, execute target code, contact a network, write files or certify host loading, installation or activation.",
  "Read receipts and the resource closure describe observed bytes, not an atomic snapshot or isolation from concurrent processes. Schema cache comparison assumes callers do not mutate previously compiled schemas or validators in the same process.",
];

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fields(value, required, optional = []) {
  return object(value) && required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

function text(value) {
  return typeof value === "string" && value.length > 0;
}

function requestSnapshot(options) {
  if (!fields(options, ["root", "artifacts"]) || !text(options.root)
    || !Array.isArray(options.artifacts) || options.artifacts.length === 0) {
    throw invalidParamsError("runSelectedArtifactCheck requires only explicit non-empty root and non-empty artifacts");
  }
  const seen = new Set();
  const artifacts = Array.from(options.artifacts, (item) => {
    if (!fields(item, ["path"], ["schema", "baseline"]) || !text(item.path)
      || (!Object.hasOwn(item, "schema") && !Object.hasOwn(item, "baseline")) || seen.has(item.path)) {
      throw invalidParamsError("each unique artifact path requires schema or baseline, with no unknown fields");
    }
    seen.add(item.path);
    const selected = { path: item.path };
    if (Object.hasOwn(item, "schema")) {
      if (!fields(item.schema, ["path", "dialect"]) || !text(item.schema.path) || !text(item.schema.dialect)) {
        throw invalidParamsError("schema requires only non-empty path and dialect");
      }
      selected.schema = { path: item.schema.path, dialect: item.schema.dialect };
    }
    if (Object.hasOwn(item, "baseline")) {
      if (!fields(item.baseline, ["sha256"], ["version"]) || typeof item.baseline.sha256 !== "string"
        || !/^[a-f0-9]{64}$/.test(item.baseline.sha256)
        || (Object.hasOwn(item.baseline, "version") && !text(item.baseline.version))) {
        throw invalidParamsError("baseline requires a lowercase SHA256 and optional non-empty version, with no other fields");
      }
      selected.baseline = { sha256: item.baseline.sha256 };
      if (Object.hasOwn(item.baseline, "version")) selected.baseline.version = item.baseline.version;
    }
    return selected;
  });
  return { root: options.root, artifacts };
}

function receipt(ref, read) {
  // Normalize only after the original path has passed the Harness read.
  return { ref: path.posix.normalize(ref.replaceAll("\\", "/")), sha256: read.sha256, bytes: read.bytes };
}

function insufficient(reason, cause) {
  return { status: "insufficient", reason, ...(cause === undefined ? {} : { cause }) };
}

function mechanismCause(error) {
  if (error?.code !== "SFC2004" || typeof error.details?.kind !== "string") throw error;
  return { code: error.code, kind: error.details.kind };
}

function supportedSchema(schema) {
  if (!object(schema)) return "the selected schema must be a JSON object; boolean schemas are not supported";
  const pending = [schema];
  while (pending.length > 0) {
    const value = pending.pop();
    for (const key of ["$ref", "$dynamicRef"]) {
      const child = value[key];
      if (!Object.hasOwn(value, key)) continue;
      if ((key === "$ref" || key === "$dynamicRef") && (typeof child !== "string" || !child.startsWith("#"))) {
        return "only self-contained fragment references beginning with # are supported";
      }
    }
    if (value.$async === true) return "asynchronous schemas are not supported";
    // Visit schema-valued positions only. Property names and const/enum/default/
    // examples data are not schema keywords; Contracts still owns interpretation.
    for (const key of ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas", "dependencies"]) {
      if (object(value[key])) pending.push(...Object.values(value[key]).filter(object));
    }
    for (const key of ["items", "prefixItems", "allOf", "anyOf", "oneOf"]) {
      if (object(value[key])) pending.push(value[key]);
      else if (Array.isArray(value[key])) pending.push(...value[key].filter(object));
    }
    for (const key of ["additionalProperties", "unevaluatedProperties", "propertyNames", "additionalItems", "unevaluatedItems", "contains", "not", "if", "then", "else", "contentSchema"]) {
      if (object(value[key])) pending.push(value[key]);
    }
  }
  return null;
}

function checkSchema(documentText, schemaText, dialect) {
  if (!Object.hasOwn(SUPPORTED_DIALECTS, dialect)) {
    return insufficient(`unsupported dialect: ${dialect}`, { code: "SFC1006" });
  }
  let schema;
  try {
    schema = JSON.parse(schemaText);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { ...insufficient("the selected schema is not valid JSON"), errors: [{ message: error.message }] };
  }
  const unsupported = supportedSchema(schema);
  if (unsupported) return insufficient(unsupported);
  // Keep compilation, comparison and validation in one synchronous segment.
  // Ajv exposes a mutable original schema, not a cryptographic compile receipt.
  try {
    const compiled = compileSchema({ schema }, { dialect, policy: "strict" });
    if (!isDeepStrictEqual(compiled.schema, schema)) {
      return insufficient("the cached compiled schema differs from the selected schema bytes");
    }
  } catch (error) {
    if (!(error instanceof ContractsError)) throw error;
    return insufficient(error.message, { code: error.code });
  }
  let document;
  try {
    document = JSON.parse(documentText);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { status: "findings", reason: "the selected document is not valid JSON under an available schema", errors: [{ message: error.message }] };
  }
  const validation = validateDocument(document, { schema, dialect, policy: "strict" });
  if (validation.valid) return { status: "pass", reason: "the selected document conforms to the selected schema" };
  if (validation.errorCode !== "SFC1001") {
    return { ...insufficient("the selected schema validation could not complete", { code: validation.errorCode }), errors: validation.errors };
  }
  return { status: "findings", reason: "the selected document violates the selected schema", cause: { code: validation.errorCode }, errors: validation.errors };
}

async function executeSelected(root, artifacts, selectionSource = null) {
  const records = [];
  for (const [offset, selection] of artifacts.entries()) {
    const record = {
      index: offset + 1, selection, document: null, schemaSource: null,
      checks: {
        schema: selection.schema ? insufficient("not checked") : null,
        bytes: selection.baseline ? insufficient("not checked") : null,
      },
    };
    records.push(record);
    let document;
    try {
      document = await readFileStrict(root, selection.path, { encoding: "utf8" });
      record.document = receipt(selection.path, document);
    } catch (error) {
      const cause = mechanismCause(error);
      for (const key of ["schema", "bytes"]) {
        if (record.checks[key]) record.checks[key] = insufficient("the selected document could not be read", cause);
      }
      continue;
    }
    if (selection.baseline) {
      const equal = document.sha256 === selection.baseline.sha256;
      record.checks.bytes = {
        status: equal ? "pass" : "findings",
        reason: equal ? "the selected bytes match the trusted baseline" : "the selected bytes differ from the trusted baseline",
        expected: selection.baseline.sha256, actual: document.sha256,
      };
    }
    if (selection.schema) {
      try {
        const schema = await readFileStrict(root, selection.schema.path, { encoding: "utf8" });
        record.schemaSource = receipt(selection.schema.path, schema);
        record.checks.schema = checkSchema(document.content, schema.content, selection.schema.dialect);
      } catch (error) {
        const cause = mechanismCause(error);
        record.checks.schema = insufficient("the selected schema could not be read", cause);
      }
    }
  }

  const resources = records.flatMap((record) => [record.document, record.schemaSource].filter(Boolean));
  if (selectionSource) resources.push(selectionSource);
  let closure = null;
  if (resources.length > 0) {
    try {
      closure = await computeResourceClosure({ root, resources: resources.map(({ ref }) => ({ path: ref, role: "input" })) });
      const actual = new Map(closure.resources.map((resource) => [resource.path, resource.sha256]));
      const observed = new Map();
      for (const resource of resources) {
        if (!observed.has(resource.ref)) observed.set(resource.ref, new Set());
        observed.get(resource.ref).add(resource.sha256);
      }
      const changed = (resource) => resource && (observed.get(resource.ref).size !== 1 || actual.get(resource.ref) !== resource.sha256);
      for (const record of records) {
        for (const key of ["schema", "bytes"]) {
          if (record.checks[key] && (changed(selectionSource) || changed(record.document) || (key === "schema" && changed(record.schemaSource)))) {
            record.checks[key] = insufficient("observed input bytes differ between strict reads and the resource closure");
          }
        }
      }
    } catch (error) {
      const cause = mechanismCause(error);
      closure = null;
      for (const record of records) {
        for (const key of ["schema", "bytes"]) {
          if (record.checks[key]) record.checks[key] = insufficient("resource closure could not complete", cause);
        }
      }
    }
  }

  const all = records.flatMap((record) => Object.entries(record.checks).filter(([, result]) => result).map(([key, result]) => ({ id: `artifact:${record.index}:${key}`, ...result })));
  const done = all.filter((result) => result.status !== "insufficient");
  const complete = done.length === all.length;
  const findings = done.some((result) => result.status === "findings");
  const code = findings ? "ENGINEERING_FINDINGS" : complete ? "ENGINEERING_CLEAR" : "ENGINEERING_CHECK_INCOMPLETE";
  const conclusion = {
    schemaVersion: 1, kind: "skill-family.professional-conclusion",
    provider: { id: KIT_TOOL_NAME, version: KIT_VERSION, entry: "runSelectedArtifactCheck" },
    subject: { ref: root },
    scope: {
      checked: done.map((result) => result.id),
      limitations: [...LIMITATIONS, ...all.filter((result) => result.status === "insufficient").map((result) => `${result.id}: ${result.reason}`)],
    },
    outcome: {
      completion: complete ? "complete" : done.length > 0 ? "partial" : "not-performed",
      code,
      summary: findings ? "Confirmed findings remain in the selected schema or byte checks." : complete ? "All selected schema and byte checks completed without findings." : "The selected schema and byte checks did not completely finish.",
    },
    details: { artifacts: records, closure, ...(selectionSource ? { selectionSource } : {}) },
  };
  const schema = findSchemaByObject("professional-conclusion");
  const validation = validateDocument(conclusion, { schemaId: schema.$id, dialect: schema.dialect, policy: "strict" });
  if (!validation.valid) throw new ContractsError("SFC1001", "generated selected artifact conclusion violates its public contract", { errors: validation.errors });
  return validation.data;
}

/** Check only explicitly selected documents/schemas/baselines, with no writes or target execution. */
export async function runSelectedArtifactCheck(options) {
  const selected = requestSnapshot(options);
  return executeSelected(await resolveTargetRoot(selected.root), selected.artifacts);
}

/** CLI-only thin action; actual selection receipts cannot be supplied through the public API. */
export async function checkSelectedArtifactsAction(options) {
  if (!fields(options, ["root", "selection"]) || !text(options.root) || !text(options.selection)) {
    throw invalidParamsError("selected-artifacts requires explicit root and relative selection file");
  }
  const root = await resolveTargetRoot(options.root);
  const read = await readFileStrict(root, options.selection, { encoding: "utf8" });
  let document;
  try {
    document = JSON.parse(read.content);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw invalidParamsError("selection file must be valid JSON");
  }
  if (!fields(document, ["artifacts"])) throw invalidParamsError("selection file must contain only artifacts");
  const selected = requestSnapshot({ root, artifacts: document.artifacts });
  return executeSelected(root, selected.artifacts, receipt(options.selection, read));
}
