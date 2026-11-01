// @feature FND-FR-031
// @scenario S-074
// @design FND-DES-041
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { compileSchema, ContractsError, findSchemaByObject, validateDocument } from "skill-family-contracts";
import { computeResourceClosure, readFileStrict } from "skill-family-harness-node";
import schema from "../data/check-contracts/source-generated-declaration.schema.json" with { type: "json" };
import { invalidParamsError } from "./errors.mjs";
import { KIT_TOOL_NAME, KIT_VERSION } from "./skeleton.mjs";
import { resolveTargetRoot } from "./workspace.mjs";

export const SOURCE_GENERATED_DECLARATION_SCHEMA_ID = schema.$id;

const LIMITATIONS = [
  "Only the selected declaration and same-mapping fixed root identities were checked; cross-mapping generated-as-source chains are allowed.",
  "The optional Kit reading contract is not evidence that this project previously adopted its schema or that the declaration is authorized.",
  "Root coordinates are lexical, root-relative declarations; filesystem membership, recursive directory/exclusion semantics, generator arguments and generation results were not checked. No target code was executed.",
  "Strict read receipts and the resource closure bind observed declaration bytes, not an atomic snapshot or protection against concurrent writers.",
];

function requestSnapshot(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)
    || Object.keys(options).length !== 2 || !Object.hasOwn(options, "root") || !Object.hasOwn(options, "declaration")
    || typeof options.root !== "string" || options.root.length === 0
    || typeof options.declaration !== "string" || options.declaration.length === 0) {
    throw invalidParamsError("runSourceGeneratedCheck requires only non-empty root and declaration strings");
  }
  return { root: options.root, declaration: options.declaration };
}

function mechanismCause(error) {
  if (error?.code !== "SFC2004" || typeof error.details?.kind !== "string") throw error;
  return { code: error.code, kind: error.details.kind };
}

// This is a finite lexical coordinate contract, not a filesystem resolver.
// Refuse expansion, glob/exclusion syntax, alternate separators and traversal.
function fixedRoot(value) {
  const relative = value.startsWith("./") ? value.slice(2) : value;
  return relative.split("/").every((part) => /^[A-Za-z0-9_.-]+$/.test(part) && part !== "." && part !== "..")
    ? relative : null;
}

function mappingRecord(mapping, index) {
  const pointer = `/mappings/${index}`;
  const roots = (field) => mapping[field].map((value, offset) => ({ value, normalized: fixedRoot(value), pointer: `${pointer}/${field}/${offset}` }));
  const record = {
    index: index + 1, pointer, capabilityId: mapping.capabilityId,
    sourceRoots: roots("sourceRoots"), generatedRoots: roots("generatedRoots"),
    generator: { path: mapping.generator.path, pointer: `${pointer}/generator/path` },
    status: "pass", reason: "same-mapping fixed source and generated root identities differ", conflicts: [], unsupported: [],
  };
  for (const root of [...record.sourceRoots, ...record.generatedRoots]) {
    if (root.normalized === null) record.unsupported.push({ pointer: root.pointer, reason: "root is outside the fixed relative-path subset" });
  }
  if (fixedRoot(mapping.generator.path) === null) {
    record.unsupported.push({ pointer: record.generator.pointer, reason: "generator path is outside the fixed relative-path subset" });
  }
  for (const source of record.sourceRoots) {
    for (const generated of record.generatedRoots) {
      if (source.normalized === null || generated.normalized === null) continue;
      if (source.normalized === generated.normalized) {
        record.conflicts.push({ source: source.pointer, generated: generated.pointer, root: source.normalized });
      } else if (source.normalized.startsWith(`${generated.normalized}/`) || generated.normalized.startsWith(`${source.normalized}/`)) {
        record.unsupported.push({ source: source.pointer, generated: generated.pointer, reason: "ancestor/descendant root semantics are outside the supported identity comparison" });
      }
    }
  }
  // Preserve an established identity conflict even if another pair is unknown.
  // Completion is aggregated separately from findings below.
  if (record.conflicts.length > 0) {
    record.status = "findings";
    record.reason = "a source root equals a generated root in the same mapping";
  } else if (record.unsupported.length > 0) {
    record.status = "insufficient";
    record.reason = "not every root coordinate has supported direction semantics";
  }
  return record;
}

/** Read one actual declaration; never accept caller-precomputed root arrays. */
export async function runSourceGeneratedCheck(options) {
  const selected = requestSnapshot(options);
  const root = await resolveTargetRoot(selected.root);
  let declaration = null;
  let closure = null;
  let mappings = [];
  const declarationCheck = { status: "insufficient", reason: "declaration not read" };
  try {
    const read = await readFileStrict(root, selected.declaration, { encoding: "utf8" });
    declaration = { ref: path.posix.normalize(selected.declaration.replaceAll("\\", "/")), sha256: read.sha256, bytes: read.bytes };
    let document;
    try { document = JSON.parse(read.content); } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      declarationCheck.reason = "declaration is not parseable JSON";
      declarationCheck.errors = [{ message: error.message }];
    }
    if (document !== undefined) {
      const validator = compileSchema({ schema }, { dialect: "2020-12", policy: "strict" });
      if (!isDeepStrictEqual(validator.schema, schema)) {
        declarationCheck.reason = "cached schema differs from the fixed reading contract";
      } else {
        const result = validateDocument(document, { schema, dialect: "2020-12", policy: "strict" });
        if (!result.valid) {
          declarationCheck.reason = "declaration is outside the supported reading contract";
          declarationCheck.errors = result.errors;
        } else {
          declarationCheck.status = "pass";
          declarationCheck.reason = "actual declaration matches the optional fixed reading contract";
          mappings = result.data.mappings.map(mappingRecord);
        }
      }
    }
    closure = await computeResourceClosure({ root, resources: [{ path: declaration.ref, role: "input" }] });
    if (closure.resources.find((item) => item.path === declaration.ref)?.sha256 !== declaration.sha256) {
      declarationCheck.status = "insufficient";
      declarationCheck.reason = "declaration bytes differ between strict read and resource closure";
    }
  } catch (error) {
    if (error instanceof ContractsError && error.code !== "SFC2004") {
      declarationCheck.status = "insufficient";
      declarationCheck.reason = "the fixed reading contract could not be evaluated";
      declarationCheck.cause = { code: error.code };
    } else {
      const cause = mechanismCause(error);
      closure = null;
      declarationCheck.status = "insufficient";
      declarationCheck.reason = `declaration read or closure could not complete (${cause.kind})`;
      declarationCheck.cause = cause;
    }
  }
  if (declarationCheck.status !== "pass") {
    for (const record of mappings) {
      record.status = "insufficient";
      record.reason = declarationCheck.reason;
      record.conflicts = [];
    }
  }
  const performed = mappings.filter((record) => record.status !== "insufficient");
  const hasFindings = mappings.some((record) => record.status === "findings");
  const incomplete = declarationCheck.status !== "pass" || mappings.some((record) => record.status === "insufficient" || record.unsupported.length > 0);
  const conclusion = {
    schemaVersion: 1, kind: "skill-family.professional-conclusion",
    provider: { id: KIT_TOOL_NAME, version: KIT_VERSION, entry: "runSourceGeneratedCheck" },
    subject: { ref: root },
    scope: {
      checked: performed.map((record) => `mapping:${record.index}:direction`),
      limitations: [...LIMITATIONS, ...(declarationCheck.status !== "pass" ? [declarationCheck.reason] : []),
        ...mappings.filter((record) => record.status === "insufficient" || record.unsupported.length > 0).map((record) => `${record.pointer}: ${record.reason}; ${record.unsupported.map((item) => item.reason).join("; ")}`)],
    },
    outcome: {
      completion: incomplete ? performed.length > 0 ? "partial" : "not-performed" : "complete",
      code: hasFindings ? "ENGINEERING_FINDINGS" : incomplete ? "ENGINEERING_CHECK_INCOMPLETE" : "ENGINEERING_CLEAR",
      summary: hasFindings ? "The selected declaration contains same-mapping source/generated identity conflicts."
        : incomplete ? "The selected source/generated direction check did not cover every mapping."
          : "The selected same-mapping fixed root identity comparisons completed without findings.",
    },
    details: { selection: { declaration: selected.declaration }, readingContract: SOURCE_GENERATED_DECLARATION_SCHEMA_ID, declaration, declarationCheck, mappings, closure },
  };
  const registration = findSchemaByObject("professional-conclusion");
  const validated = validateDocument(conclusion, { schemaId: registration.$id, dialect: registration.dialect, policy: "strict" });
  if (!validated.valid) throw new ContractsError("SFC1001", "generated source/generated conclusion violates its public contract", { errors: validated.errors });
  return validated.data;
}
