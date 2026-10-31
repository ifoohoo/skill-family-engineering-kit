import path from "node:path";
import { ContractsError, findSchemaByObject, validateDocument } from "skill-family-contracts";
import { computeResourceClosure, readFileStrict, resolveContained } from "skill-family-harness-node";
import { invalidParamsError } from "./errors.mjs";
import { KIT_TOOL_NAME, KIT_VERSION } from "./skeleton.mjs";
import { resolveTargetRoot } from "./workspace.mjs";

const REFERENCE_FIELDS = ["sourceRef", "line", "literal", "baseDir"];
const LIMITATIONS = [
  "Only caller-selected fixed file references were checked; the caller owns actual-call selection, resolution bases and scope completeness.",
  "This check does not validate schemas, arguments, permissions, control flow, host loading or target execution.",
  "Read receipts and the resource closure describe observed bytes, not an atomic snapshot or isolation from concurrent processes.",
];

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactFields(value, fields) {
  return object(value) && Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field));
}

function requestSnapshot(options) {
  if (!exactFields(options, ["root", "references"]) || typeof options.root !== "string" || !options.root) {
    throw invalidParamsError("runStaticReferenceCheck requires only root and references, with an explicit non-empty root");
  }
  if (!Array.isArray(options.references) || options.references.length === 0) {
    throw invalidParamsError("references must be a non-empty array");
  }
  const seen = new Set();
  const references = [];
  for (const reference of options.references) {
    if (!exactFields(reference, REFERENCE_FIELDS)
      || !["sourceRef", "literal", "baseDir"].every((field) => typeof reference[field] === "string" && reference[field].length > 0)
      || !Number.isSafeInteger(reference.line) || reference.line < 1) {
      throw invalidParamsError("every reference requires sourceRef, positive safe-integer line, literal and baseDir, with no other fields");
    }
    const copy = Object.fromEntries(REFERENCE_FIELDS.map((field) => [field, reference[field]]));
    const key = JSON.stringify(copy);
    if (seen.has(key)) throw invalidParamsError("references contains a duplicate selection");
    seen.add(key);
    references.push(copy);
  }
  return { root: options.root, references };
}

function fixedLiteral(literal) {
  const relative = literal.startsWith("./") ? literal.slice(2) : literal;
  return relative.split("/").every((segment) => /^[A-Za-z0-9_.-]+$/.test(segment) && segment !== "." && segment !== "..");
}

function boundOnLine(content, reference) {
  const line = content.split("\n")[reference.line - 1];
  if (line === undefined) return false;
  const at = line.indexOf(reference.literal);
  if (at < 0 || line.indexOf(reference.literal, at + 1) >= 0) return false;
  const boundary = (char) => char === undefined || /[\s'"`]/u.test(char);
  return boundary(line[at - 1]) && boundary(line[at + reference.literal.length]);
}

function receipt(ref, read) {
  // Derive both refs from verified relative bindings. A lexical root may be
  // a directory alias, whereas the Harness's absolute receipt is canonical.
  return { ref: path.posix.normalize(ref), sha256: read.sha256, bytes: read.bytes };
}

function mechanismCause(error) {
  if (error?.code !== "SFC2004" || typeof error.details?.kind !== "string") throw error;
  return { code: error.code, kind: error.details.kind };
}

function insufficient(record, reason, cause) {
  record.status = "insufficient";
  record.reason = reason;
  if (cause !== undefined) record.cause = cause;
}

/**
 * Read only the caller-selected, semantically established fixed references.
 * No discovery, target execution, output file, process or network activity.
 */
export async function runStaticReferenceCheck(options) {
  const selected = requestSnapshot(options);
  const root = await resolveTargetRoot(selected.root);
  const records = [];
  for (const [offset, reference] of selected.references.entries()) {
    const record = { index: offset + 1, ...reference, status: "insufficient", reason: "not checked", source: null, target: null };
    records.push(record);
    try {
      const source = await readFileStrict(root, reference.sourceRef, { encoding: "utf8" });
      record.source = receipt(reference.sourceRef, source);
      if (!boundOnLine(source.content, reference)) {
        insufficient(record, "the selected line does not bind exactly one delimited occurrence of the literal");
        continue;
      }
      if (!fixedLiteral(reference.literal)) {
        insufficient(record, "the literal is outside the supported fixed ASCII relative-path subset");
        continue;
      }
      if (reference.baseDir !== ".") await resolveContained(root, reference.baseDir);
      const targetRef = path.posix.join(reference.baseDir, reference.literal);
      const target = await readFileStrict(root, targetRef);
      record.target = receipt(targetRef, target);
      record.status = "checked";
      record.reason = "the selected source binding and target file were read";
    } catch (error) {
      const cause = mechanismCause(error);
      insufficient(record, `the selected reference could not be read (${cause.kind})`, cause);
    }
  }

  const candidates = records.filter((record) => record.status === "checked");
  let closure = null;
  if (candidates.length > 0) {
    const resources = candidates.flatMap((record) => [record.source, record.target]);
    try {
      closure = await computeResourceClosure({ root, resources: resources.map(({ ref }) => ({ path: ref, role: "input" })) });
      const actual = new Map(closure.resources.map((resource) => [resource.path, resource.sha256]));
      const observed = new Map();
      for (const resource of resources) {
        if (!observed.has(resource.ref)) observed.set(resource.ref, new Set());
        observed.get(resource.ref).add(resource.sha256);
      }
      for (const record of candidates) {
        if ([record.source, record.target].some((resource) => observed.get(resource.ref).size !== 1 || actual.get(resource.ref) !== resource.sha256)) {
          insufficient(record, "observed resource bytes differ between strict reads and the resource closure");
        }
      }
    } catch (error) {
      const cause = mechanismCause(error);
      closure = null;
      for (const record of candidates) insufficient(record, `resource closure could not complete (${cause.kind})`, cause);
    }
  }

  const checked = records.filter((record) => record.status === "checked").map((record) => `reference:${record.index}`);
  const complete = checked.length === records.length;
  const conclusion = {
    schemaVersion: 1,
    kind: "skill-family.professional-conclusion",
    provider: { id: KIT_TOOL_NAME, version: KIT_VERSION, entry: "runStaticReferenceCheck" },
    subject: { ref: root },
    scope: {
      checked,
      limitations: [...LIMITATIONS, ...records.filter((record) => record.status === "insufficient").map((record) => `reference:${record.index}: ${record.reason}`)],
    },
    outcome: {
      completion: complete ? "complete" : checked.length > 0 ? "partial" : "not-performed",
      code: complete ? "ENGINEERING_CLEAR" : "ENGINEERING_CHECK_INCOMPLETE",
      summary: complete ? "The selected fixed file references completed without findings." : "The selected fixed file references were not completely checked.",
    },
    details: { references: records, closure },
  };
  const schema = findSchemaByObject("professional-conclusion");
  const validation = validateDocument(conclusion, { schemaId: schema.$id, dialect: schema.dialect, policy: "strict" });
  if (!validation.valid) {
    throw new ContractsError("SFC1001", "generated static reference conclusion violates its public contract", { errors: validation.errors });
  }
  return validation.data;
}
