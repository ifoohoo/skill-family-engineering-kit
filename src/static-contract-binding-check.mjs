// @feature FND-FR-032
// @scenario S-075
// @design FND-DES-042
import path from "node:path";
import { parse } from "acorn";
import { parser as pythonParser } from "@lezer/python";
import { isMap, isScalar, parseDocument, visit } from "yaml";
import { ContractsError, findSchemaByObject, validateDocument } from "skill-family-contracts";
import { classifyPathInput, computeResourceClosure, readFileStrict, resolveContained } from "skill-family-harness-node";
import { invalidParamsError } from "./errors.mjs";
import { KIT_TOOL_NAME, KIT_VERSION } from "./skeleton.mjs";
import { resolveTargetRoot } from "./workspace.mjs";

const FIELDS = ["sourceRef", "line", "column", "resultIdentifier", "schemaRef", "schemaPointer"];
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const ANNOTATIONS = ["$schema", "$id", "$comment", "title", "description", "default", "examples", "deprecated", "readOnly", "writeOnly"];
const OBJECT_KEYS = new Set([...ANNOTATIONS, "type", "properties", "required", "additionalProperties", "$defs", "definitions", "allOf"]);
const VALUE_KEYS = new Set([...ANNOTATIONS, "type", "enum", "const"]);
const LIMITATIONS = [
  "Only caller-selected IfStatement conditions or BinaryExpression comparisons, direct properties paths and direct enum/const membership were checked. The caller owns object/schema correspondence and selection completeness.",
  "Field location without enum/const does not establish literal validity. Literal membership does not establish full Schema validity, object identity, exhaustive branches, control flow or domain success.",
  "No references or Schema combinations are resolved. Conditional required constraints on other sibling fields may be excluded by the supported structural boundary; those conditions and whole-object validity are not checked.",
  "No target code is imported, executed or evaluated; no target files or network state are changed.",
  "Strict read receipts and the resource closure bind observed bytes, not an atomic snapshot or isolation from concurrent writers.",
];

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fields(value, keys) {
  return object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function pointerParts(pointer) {
  if (pointer === "") return [];
  if (!pointer.startsWith("/") || /~(?![01])/.test(pointer)) return null;
  return pointer.slice(1).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function requestSnapshot(options) {
  if (!fields(options, ["root", "branches"]) || typeof options.root !== "string" || !options.root
    || !Array.isArray(options.branches) || options.branches.length === 0) {
    throw invalidParamsError("runBranchFieldCheck requires only explicit root and non-empty branches");
  }
  const seen = new Set();
  const branches = Array.from(options.branches, (item) => {
    if (!object(item) || !fields(item, Object.hasOwn(item, "nodeType") ? [...FIELDS, "nodeType"] : FIELDS)
      || (Object.hasOwn(item, "nodeType") && !["IfStatement", "BinaryExpression"].includes(item.nodeType))
      || !["sourceRef", "schemaRef", "resultIdentifier"].every((key) => typeof item[key] === "string" && item[key])
      || !IDENTIFIER.test(item.resultIdentifier) || typeof item.schemaPointer !== "string" || pointerParts(item.schemaPointer) === null
      || ![item.line, item.column].every((value) => Number.isSafeInteger(value) && value > 0)) {
      throw invalidParamsError("each branch requires only sourceRef, positive line/column, ASCII resultIdentifier, schemaRef, RFC6901 schemaPointer and optional IfStatement/BinaryExpression nodeType");
    }
    const copy = Object.fromEntries(FIELDS.map((key) => [key, item[key]]));
    if (Object.hasOwn(item, "nodeType")) copy.nodeType = item.nodeType;
    const key = JSON.stringify({ ...copy, nodeType: copy.nodeType ?? "IfStatement" });
    if (seen.has(key)) throw invalidParamsError("branches contains a duplicate selection");
    seen.add(key);
    return copy;
  });
  return { root: options.root, branches };
}

function receipt(ref, read) {
  return { ref: path.posix.normalize(ref.replaceAll("\\", "/")), sha256: read.sha256, bytes: read.bytes };
}

function unknown(reason, extra = {}) {
  return { ...extra, status: "insufficient", reason };
}

function mechanismCause(error) {
  if (error?.code !== "SFC2004" || typeof error.details?.kind !== "string") throw error;
  return { code: error.code, kind: error.details.kind };
}

function selectNode(ast, selection) {
  const pending = [ast];
  const matches = [];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node.type === (selection.nodeType ?? "IfStatement") && node.loc.start.line === selection.line && node.loc.start.column + 1 === selection.column) matches.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) pending.push(...value.filter((child) => child && typeof child.type === "string"));
      else if (value && typeof value.type === "string") pending.push(value);
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

function sourceField(node, content, identifier) {
  const names = [];
  while (node.type === "MemberExpression" && !node.computed && !node.optional) {
    const part = node.property;
    if (part.type !== "Identifier" || !IDENTIFIER.test(part.name) || content.slice(part.start, part.end) !== part.name) return null;
    names.unshift(part.name);
    node = node.object;
  }
  return node.type === "Identifier" && node.name === identifier && content.slice(node.start, node.end) === identifier && names.length > 0 ? names : null;
}

function comparisons(test, content, identifier) {
  if (test.type === "LogicalExpression" && ["&&", "||"].includes(test.operator)) {
    return [...comparisons(test.left, content, identifier), ...comparisons(test.right, content, identifier)];
  }
  const location = { line: test.loc.start.line, column: test.loc.start.column + 1 };
  if (test.type !== "BinaryExpression" || !["===", "!=="].includes(test.operator) || test.loc.start.line !== test.loc.end.line) {
    return [unknown("condition is outside the supported single-line strict string-comparison subset", { location })];
  }
  const field = sourceField(test.left, content, identifier);
  const literal = test.right;
  const raw = content.slice(literal.start, literal.end);
  if (field === null || literal.type !== "Literal" || typeof literal.value !== "string" || /[\\\r\n]/.test(raw)
    || !["'", '"'].includes(raw[0]) || raw.at(-1) !== raw[0]) {
    return [unknown("condition does not bind the selected direct ASCII field chain and unescaped string literal", { location })];
  }
  return [{ location, field, operator: test.operator, literal: literal.value }];
}

function schemaSelection(document, pointer) {
  let current = document;
  for (const part of pointerParts(pointer)) {
    if (!object(current) || !Object.hasOwn(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

function propertyPointer(base, field) {
  return `${base}/properties/${field.replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

// A closed structural exclusion, not a conditional/combinator evaluator.
// Sibling sub-schemas are opaque; only wrapper keys and field names matter.
function siblingRequiredOnly(schema, target) {
  if (!Array.isArray(schema.allOf) || schema.allOf.length === 0) return false;
  const sibling = (name) => typeof name === "string" && name !== target && Object.hasOwn(schema.properties, name);
  const required = (names) => Array.isArray(names) && names.every(sibling) && new Set(names).size === names.length;
  return schema.allOf.every((item) => fields(item, ["if", "then"])
    && fields(item.if, ["properties", "required"]) && object(item.if.properties)
    && Object.keys(item.if.properties).every(sibling) && required(item.if.required)
    && fields(item.then, ["required"]) && required(item.then.required));
}

function compareField(comparison, document, selectedPointer) {
  if (comparison.status === "insufficient") return comparison;
  let schema = schemaSelection(document, selectedPointer);
  let pointer = selectedPointer;
  for (const field of comparison.field) {
    if (!object(schema) || schema.type !== "object" || !object(schema.properties)
      || Object.keys(schema).some((key) => !OBJECT_KEYS.has(key))
      || (Object.hasOwn(schema, "allOf") && (comparison.field.length !== 1 || !siblingRequiredOnly(schema, field)))
      || (Object.hasOwn(schema, "additionalProperties") && typeof schema.additionalProperties !== "boolean")
      || (Object.hasOwn(schema, "required") && (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== "string")))) {
      return unknown("selected object path is not a supported direct properties object", { ...comparison, schemaPointer: pointer });
    }
    const next = propertyPointer(pointer, field);
    if (!Object.hasOwn(schema.properties, field)) {
      return {
        ...comparison, schemaPointer: next,
        status: schema.additionalProperties === false ? "findings" : "insufficient",
        reason: schema.additionalProperties === false ? "field is absent from the selected simple closed object" : "field is undeclared in an open object; prohibition is not established",
      };
    }
    schema = schema.properties[field];
    pointer = next;
  }
  const base = { ...comparison, schemaPointer: pointer };
  if (!object(schema) || Object.keys(schema).some((key) => !VALUE_KEYS.has(key))
    || (Object.hasOwn(schema, "type") && !["string", "number", "integer", "boolean", "null", "object", "array"].includes(schema.type))
    || (Object.hasOwn(schema, "enum") && (!Array.isArray(schema.enum) || schema.enum.length === 0))) {
    return unknown("selected field has unsupported or malformed Schema constraints", base);
  }
  // Membership is intentionally independent of full Schema/type validity.
  if (Object.hasOwn(schema, "enum")) base.enum = schema.enum;
  if (Object.hasOwn(schema, "const")) base.const = schema.const;
  const enumerated = Object.hasOwn(base, "enum") || Object.hasOwn(base, "const");
  const member = (!Object.hasOwn(base, "enum") || base.enum.includes(base.literal)) && (!Object.hasOwn(base, "const") || base.const === base.literal);
  return {
    ...base, status: member ? "checked" : "findings",
    reason: !enumerated ? "direct field location completed; no enum/const membership was checked"
      : member ? "literal belongs to every selected direct enum/const declaration" : "literal is absent from a selected direct enum/const declaration",
  };
}

function summarize(record) {
  record.status = record.comparisons.some((item) => item.status === "findings") ? "findings"
    : record.comparisons.some((item) => item.status === "insufficient") ? "insufficient" : "checked";
  record.reason = record.status === "findings" ? "selected condition contains a proven field or literal conflict"
    : record.status === "checked" ? "selected direct field comparisons completed" : "selected condition is not completely supported";
}

async function execute(root, branches, selectionReceipt = null) {
  const records = [];
  for (const [offset, selection] of branches.entries()) {
    const record = { index: offset + 1, ...selection, source: null, schema: null, comparisons: [], ...unknown("not checked") };
    records.push(record);
    try {
      const source = await readFileStrict(root, selection.sourceRef, { encoding: "utf8" });
      record.source = receipt(selection.sourceRef, source);
      const schema = await readFileStrict(root, selection.schemaRef, { encoding: "utf8" });
      record.schema = receipt(selection.schemaRef, schema);
      let ast;
      let document;
      try {
        ast = parse(source.content, { ecmaVersion: 2022, sourceType: "module", locations: true, allowHashBang: true });
        document = JSON.parse(schema.content);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        Object.assign(record, unknown("source or Schema could not be parsed", { parseError: error.message }));
        continue;
      }
      const branch = selectNode(ast, selection);
      if (branch === null) {
        Object.assign(record, unknown(`the exact line/column does not select one ${selection.nodeType ?? "IfStatement"}`));
        continue;
      }
      const selected = comparisons(branch.type === "IfStatement" ? branch.test : branch, source.content, selection.resultIdentifier);
      if (branch.type === "BinaryExpression" && selected[0].status === "insufficient") {
        Object.assign(record, unknown(selected[0].reason));
        continue;
      }
      record.comparisons = selected.map((item) => compareField(item, document, selection.schemaPointer));
      summarize(record);
    } catch (error) {
      const cause = mechanismCause(error);
      Object.assign(record, unknown(`source or Schema could not be read (${cause.kind})`, { cause }));
    }
  }
  const candidates = records.filter((record) => record.comparisons.some((item) => item.status !== "insufficient"));
  let closure = null;
  if (candidates.length > 0) {
    // Include all actual reads to catch conflicting shared observations, even
    // when a different selection had an unsupported expression or parse error.
    const resources = records.flatMap((record) => [record.source, record.schema].filter(Boolean));
    if (selectionReceipt) resources.push(selectionReceipt);
    try {
      closure = await computeResourceClosure({ root, resources: resources.map(({ ref }) => ({ path: ref, role: "input" })) });
      const actual = new Map(closure.resources.map((resource) => [resource.path, resource.sha256]));
      const observed = new Map();
      for (const resource of resources) {
        if (!observed.has(resource.ref)) observed.set(resource.ref, new Set());
        observed.get(resource.ref).add(resource.sha256);
      }
      const stable = (resource) => observed.get(resource.ref).size === 1 && actual.get(resource.ref) === resource.sha256;
      for (const record of candidates) {
        if (![record.source, record.schema, ...(selectionReceipt ? [selectionReceipt] : [])].every(stable)) {
          record.comparisons = record.comparisons.map((item) => unknown("observation bytes differ between strict reads and resource closure", item));
          summarize(record);
        }
      }
    } catch (error) {
      const cause = mechanismCause(error);
      closure = null;
      for (const record of candidates) {
        record.comparisons = record.comparisons.map((item) => unknown(`resource closure could not complete (${cause.kind})`, { ...item, cause }));
        summarize(record);
      }
    }
  }
  const checked = records.flatMap((record) => record.comparisons.flatMap((item, offset) => item.status === "insufficient" ? [] : [`branch-${record.index}-comparison-${offset + 1}`]));
  const finding = records.some((record) => record.status === "findings");
  const incomplete = records.some((record) => record.comparisons.length === 0 || record.comparisons.some((item) => item.status === "insufficient"));
  const conclusion = {
    schemaVersion: 1, kind: "skill-family.professional-conclusion",
    provider: { id: KIT_TOOL_NAME, version: KIT_VERSION, entry: "runBranchFieldCheck" }, subject: { ref: root },
    scope: { checked, limitations: [...LIMITATIONS, ...records.filter((record) => record.status === "insufficient" || record.comparisons.some((item) => item.status === "insufficient")).map((record) => `branch:${record.index}: ${record.reason}`)] },
    outcome: {
      completion: incomplete ? checked.length > 0 ? "partial" : "not-performed" : "complete",
      code: finding ? "ENGINEERING_FINDINGS" : incomplete ? "ENGINEERING_CHECK_INCOMPLETE" : "ENGINEERING_CLEAR",
      summary: finding ? "The selected conditions contain direct field or literal conflicts."
        : incomplete ? "The selected branch field checks did not cover every comparison." : "The selected direct field checks completed without findings.",
    },
    details: { branches: records, selection: selectionReceipt, closure },
  };
  const schema = findSchemaByObject("professional-conclusion");
  const validated = validateDocument(conclusion, { schemaId: schema.$id, dialect: schema.dialect, policy: "strict" });
  if (!validated.valid) throw new ContractsError("SFC1001", "generated branch-field conclusion violates its public contract", { errors: validated.errors });
  return validated.data;
}

export async function runBranchFieldCheck(options) {
  const selected = requestSnapshot(options);
  const root = await resolveTargetRoot(selected.root);
  return execute(root, selected.branches);
}

export async function checkBranchFieldsAction(options) {
  if (!fields(options, ["root", "selection"]) || typeof options.root !== "string" || !options.root || typeof options.selection !== "string" || !options.selection) {
    throw invalidParamsError("branch-fields requires explicit root and relative selection file");
  }
  const { root: requestedRoot, selection } = options;
  const root = await resolveTargetRoot(requestedRoot);
  const read = await readFileStrict(root, selection, { encoding: "utf8" });
  let document;
  try { document = JSON.parse(read.content); } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw invalidParamsError("selection file must be valid JSON");
  }
  if (!fields(document, ["branches"])) throw invalidParamsError("selection file must contain only branches");
  const selected = requestSnapshot({ root, branches: document.branches });
  return execute(root, selected.branches, receipt(selection, read));
}

// @feature FND-FR-033
// @scenario S-076
// @design FND-DES-043
const BINDING_FIELDS = {
  skill: ["ref", "frontmatterKey"],
  route: ["ref", "startLine", "endLine", "constant", "entryKey"],
  method: ["ref", "idPointer", "profilePointer", "parameterRefPointer", "resultRefPointer"],
  schemas: ["task", "result", "parameters", "domainResult"],
};
const BINDING_LIMITATIONS = [
  "Only caller-selected existing public-surface identities and six direct protocol declarations were compared. The caller owns publicness, same-business/conditions, Schema authority and selection completeness.",
  "The Python grammar establishes a supported root declaration and explicit syntactic name uses, not Python compilation, runtime immutability, indirect execution effects or complete METHOD003/domain acceptance.",
  "No target code is imported, evaluated or executed; no target files or network state are changed. References are compared as read, never followed to replace the selected authority.",
  "Strict reads and the resource closure describe observed bytes, not an atomic snapshot or isolation from concurrent writers.",
];

function bindingRequestSnapshot(options) {
  if (!fields(options, ["root", "bindings"]) || typeof options.root !== "string" || !options.root
    || !Array.isArray(options.bindings) || options.bindings.length === 0) {
    throw invalidParamsError("runPublicSurfaceBindingCheck requires only explicit root and non-empty bindings");
  }
  const seen = new Set();
  const bindings = Array.from(options.bindings, (binding) => {
    if (!fields(binding, Object.keys(BINDING_FIELDS))) throw invalidParamsError("each binding requires only skill, route, method and schemas");
    const copy = {};
    for (const [group, keys] of Object.entries(BINDING_FIELDS)) {
      if (!fields(binding[group], keys)) throw invalidParamsError("binding groups require their exact declared fields");
      copy[group] = Object.fromEntries(keys.map((key) => [key, binding[group][key]]));
      for (const [key, value] of Object.entries(copy[group])) {
        if (group === "route" && ["startLine", "endLine"].includes(key)) {
          if (!Number.isSafeInteger(value) || value < 1) throw invalidParamsError("route lines must be positive safe integers");
        } else if (group === "method" && key.endsWith("Pointer")) {
          if (typeof value !== "string" || pointerParts(value) === null) throw invalidParamsError("method pointers must use RFC6901");
        } else if (typeof value !== "string" || !value) throw invalidParamsError("binding refs and keys must be non-empty strings");
      }
    }
    if (copy.route.endLine < copy.route.startLine || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(copy.route.constant)) {
      throw invalidParamsError("route requires an ordered line range and ASCII Python identifier");
    }
    const identity = JSON.stringify(copy);
    if (seen.has(identity)) throw invalidParamsError("bindings contains a duplicate selection");
    seen.add(identity);
    return copy;
  });
  return { root: options.root, bindings };
}

// JSON.parse owns values; YAML supplies only its existing duplicate-key diagnosis.
function bindingJson(content) {
  let value;
  try { value = JSON.parse(content); } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { reason: "selected JSON could not be parsed" };
  }
  const document = parseDocument(content, { uniqueKeys: true, version: "1.2", strict: true, prettyErrors: false });
  return document.errors.length || document.warnings.length
    ? { reason: "selected JSON is ambiguous or duplicate-key deambiguation could not complete" } : { value };
}

function bindingSkillIdentity(content, key) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) return { reason: "Skill does not begin with a complete supported YAML frontmatter mapping" };
  const document = parseDocument(match[1], { uniqueKeys: true, merge: false, version: "1.2", strict: true, prettyErrors: false });
  let indirect = false;
  visit(document, {
    Alias() { indirect = true; },
    Pair(_key, pair) { if (isScalar(pair.key) && pair.key.value === "<<" && pair.key.type === "PLAIN") indirect = true; },
  });
  if (document.errors.length || document.warnings.length || indirect || !isMap(document.contents)) {
    return { reason: "Skill frontmatter is ambiguous, indirect or not a supported mapping" };
  }
  const selected = document.contents.get(key, true);
  return isScalar(selected) && typeof selected.value === "string" && selected.value
    ? { value: selected.value } : { reason: "selected Skill identity is not a direct non-empty string" };
}

function bindingPointerValue(document, pointer) {
  let current = document;
  for (const part of pointerParts(pointer)) {
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, part)
      || (Array.isArray(current) && !/^(0|[1-9][0-9]*)$/.test(part))) return undefined;
    current = current[part];
  }
  return current;
}

function pythonChildren(node) {
  const children = [];
  for (let child = node.firstChild; child; child = child.nextSibling) children.push(child);
  return children;
}

function pythonSame(left, right) {
  return left && right && left.from === right.from && left.to === right.to && left.name === right.name;
}

// Targets recurse through target structure and member bases, never through a
// subscript's value expression: other[METHODS[key]] = value reads METHODS.
function pythonTargetContains(target, selected) {
  if (target.from > selected.from || target.to < selected.to) return false;
  if (pythonSame(target, selected)) return true;
  if (target.name === "MemberExpression") return pythonTargetContains(target.firstChild, selected);
  if (["TupleExpression", "ArrayExpression", "ParenthesizedExpression"].includes(target.name)) {
    return pythonChildren(target).some((child) => pythonTargetContains(child, selected));
  }
  return true; // an unclassified related target is not assumed harmless
}

function pythonWrittenOrUnknown(read) {
  for (let node = read.parent; node; node = node.parent) {
    if (node.name === "TypeDef") return true;
    const children = pythonChildren(node);
    if (["AssignStatement", "UpdateStatement", "NamedExpression"].includes(node.name)) {
      const operation = children.filter((child) => ["AssignOp", "UpdateOp"].includes(child.name)).at(-1);
      if (operation && children.some((child) => child.to <= operation.from && pythonTargetContains(child, read))) return true;
    }
    if (node.name === "DeleteStatement" && children.some((child) => pythonTargetContains(child, read))) return true;
    if (node.name === "ForStatement" || node.name.includes("Comprehension")) {
      for (let index = 0; index < children.length; index += 1) {
        if (children[index].name !== "for") continue;
        for (let target = index + 1; target < children.length && children[target].name !== "in"; target += 1) {
          if (pythonTargetContains(children[target], read)) return true;
        }
      }
    }
  }
  return false;
}

function pythonDoubleString(node, content) {
  if (node?.name !== "String") return null;
  const raw = content.slice(node.from, node.to);
  if (!raw.startsWith('"') || raw.startsWith('"""') || raw.at(-1) !== '"' || /[\\\r\n]/.test(raw)) return null;
  try { return JSON.parse(raw); } catch (error) { if (!(error instanceof SyntaxError)) throw error; return null; }
}

function pythonFixedIndex(node, content) {
  if (node?.name === "VariableName") return /^[A-Za-z_][A-Za-z0-9_]*$/.test(content.slice(node.from, node.to));
  if (node?.name !== "String") return false;
  const raw = content.slice(node.from, node.to);
  return ["'", '"'].includes(raw[0]) && raw.at(-1) === raw[0]
    && !raw.startsWith(raw[0].repeat(3)) && !/[\\\r\n]/.test(raw);
}

function pythonRouteIdentity(content, selection) {
  let tree;
  try { tree = pythonParser.configure({ strict: true }).parse(content); } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { reason: "route source is outside the complete strict Python grammar" };
  }
  if (tree.length !== content.length) return { reason: "Python syntax tree does not cover the complete route source" };
  const names = [];
  const dynamic = new Set(["exec", "eval", "globals", "locals", "vars"]);
  const cursor = tree.cursor();
  do {
    if (cursor.type.isError) return { reason: "route contains a Python grammar error node" };
    const node = cursor.node;
    if (node.name === "CallExpression") {
      let callee = node.firstChild;
      while (callee?.name === "ParenthesizedExpression") {
        const parts = pythonChildren(callee);
        if (parts.length !== 3 || parts[0].name !== "(" || parts[2].name !== ")") break;
        callee = parts[1];
      }
      if (callee?.name === "VariableName" && dynamic.has(content.slice(callee.from, callee.to))) {
        return { reason: "route contains an unsupported explicit dynamic call" };
      }
    }
    if (node.name === "VariableName" && content.slice(node.from, node.to) === selection.constant) names.push(node);
  } while (cursor.next());
  const line = (offset) => content.slice(0, offset).split(/\r\n|\r|\n/).length;
  const declarations = pythonChildren(tree.topNode).filter((node) => node.name === "AssignStatement"
    && line(node.from) === selection.startLine
    && line(node.to - (content.slice(node.from, node.to).match(/[\r\n]+$/)?.[0].length ?? 0) - 1) === selection.endLine);
  if (declarations.length !== 1) return { reason: "the exact lines do not select one root simple assignment" };
  const declaration = pythonChildren(declarations[0]);
  if (declaration.length !== 3 || declaration[0].name !== "VariableName"
    || content.slice(declaration[0].from, declaration[0].to) !== selection.constant
    || declaration[1].name !== "AssignOp" || content.slice(declaration[1].from, declaration[1].to) !== "="
    || declaration[2].name !== "DictionaryExpression") return { reason: "selected root assignment is outside the supported pure dictionary declaration" };
  const dictionary = pythonChildren(declaration[2]);
  const entries = new Map();
  if (dictionary[0]?.name !== "{" || dictionary.at(-1)?.name !== "}") return { reason: "selected dictionary shape is unsupported" };
  for (let index = 1; index < dictionary.length - 1;) {
    const key = pythonDoubleString(dictionary[index], content);
    const value = pythonDoubleString(dictionary[index + 2], content);
    if (key === null || value === null || dictionary[index + 1]?.name !== ":" || entries.has(key)) {
      return { reason: "selected dictionary is not a unique unescaped double-string mapping" };
    }
    entries.set(key, value);
    index += 3;
    if (dictionary[index]?.name === ",") index += 1;
    else if (index !== dictionary.length - 1) return { reason: "selected dictionary has unsupported members" };
  }
  if (entries.size === 0 || !entries.has(selection.entryKey)) return { reason: "selected dictionary entry is missing" };
  for (const name of names) {
    if (pythonSame(name, declaration[0])) continue;
    const member = name.parent;
    const children = member?.name === "MemberExpression" ? pythonChildren(member) : [];
    if (children.length !== 4 || !pythonSame(children[0], name) || children[1].name !== "["
      || children[3].name !== "]" || !pythonFixedIndex(children[2], content) || pythonWrittenOrUnknown(member)) {
      return { reason: "selected name has a binding, write, escape or unclassified direct use" };
    }
  }
  return { value: entries.get(selection.entryKey) };
}

function invalidateBinding(record, reason, cause) {
  Object.assign(record, unknown(reason, cause ? { cause } : {}));
  record.comparisons = [];
}

async function executeBindings(root, bindings, selectionReceipt = null) {
  const records = [];
  for (const [offset, binding] of bindings.entries()) {
    const record = { index: offset + 1, ...binding, resources: [], comparisons: [], ...unknown("not checked") };
    records.push(record);
    try {
      const contents = {};
      for (const [role, ref] of [
        ["skill", binding.skill.ref], ["route", binding.route.ref], ["method", binding.method.ref],
        ...Object.entries(binding.schemas),
      ]) {
        const read = await readFileStrict(root, ref, { encoding: "utf8" });
        record.resources.push({ role, ...receipt(ref, read) });
        contents[role] = read.content;
      }
      const skill = bindingSkillIdentity(contents.skill, binding.skill.frontmatterKey);
      const route = pythonRouteIdentity(contents.route, binding.route);
      const documents = {};
      let unsupported = skill.reason || route.reason;
      for (const role of ["method", "task", "result", "parameters", "domainResult"]) {
        const parsed = bindingJson(contents[role]);
        if (parsed.reason) unsupported ||= parsed.reason;
        documents[role] = parsed.value;
      }
      if (unsupported) { invalidateBinding(record, unsupported); continue; }
      const methodId = bindingPointerValue(documents.method, binding.method.idPointer);
      const profile = bindingPointerValue(documents.method, binding.method.profilePointer);
      const actual = [skill.value, route.value, profile?.taskContract, profile?.resultContract,
        bindingPointerValue(documents.method, binding.method.parameterRefPointer),
        bindingPointerValue(documents.method, binding.method.resultRefPointer)];
      const expected = [methodId, methodId, ...["task", "result", "parameters", "domainResult"].map((role) =>
        object(documents[role]) && Object.hasOwn(documents[role], "$id") ? documents[role].$id : undefined)];
      if (!object(profile) || !Object.hasOwn(profile, "taskContract") || !Object.hasOwn(profile, "resultContract")
        || [...actual, ...expected].some((value) => typeof value !== "string" || !value)) {
        invalidateBinding(record, "selected identity or protocol declarations are not direct non-empty strings");
        continue;
      }
      record.comparisons = actual.map((value, index) => ({
        actual: value, expected: expected[index], status: value === expected[index] ? "checked" : "findings",
        reason: value === expected[index] ? "selected declaration values agree" : "selected declaration values contradict",
      }));
      record.status = record.comparisons.some((item) => item.status === "findings") ? "findings" : "checked";
      record.reason = record.status === "findings" ? "selected public-surface declarations contain a proven conflict" : "all six selected declaration comparisons completed";
    } catch (error) {
      const cause = mechanismCause(error);
      invalidateBinding(record, "a required binding resource could not be read (" + cause.kind + ")", cause);
    }
  }
  const completed = records.filter((record) => record.status !== "insufficient");
  let closure = null;
  if (completed.length) {
    const resources = records.flatMap((record) => record.resources);
    if (selectionReceipt) resources.push(selectionReceipt);
    try {
      closure = await computeResourceClosure({ root, resources: resources.map(({ ref }) => ({ path: ref, role: "input" })) });
      const actual = new Map(closure.resources.map((item) => [item.path, item.sha256]));
      const observed = new Map();
      for (const item of resources) {
        if (!observed.has(item.ref)) observed.set(item.ref, new Set());
        observed.get(item.ref).add(item.sha256);
      }
      const stable = (item) => observed.get(item.ref).size === 1 && actual.get(item.ref) === item.sha256;
      for (const record of completed) {
        if (![...record.resources, ...(selectionReceipt ? [selectionReceipt] : [])].every(stable)) {
          invalidateBinding(record, "required observation bytes differ between strict reads and resource closure");
        }
      }
    } catch (error) {
      const cause = mechanismCause(error);
      closure = null;
      for (const record of completed) invalidateBinding(record, "binding resource closure could not complete (" + cause.kind + ")", cause);
    }
  }
  const checked = records.flatMap((record) => record.comparisons.map((_item, index) => "binding-" + record.index + "-comparison-" + (index + 1)));
  const finding = records.some((record) => record.status === "findings");
  const incomplete = records.some((record) => record.status === "insufficient");
  const conclusion = {
    schemaVersion: 1, kind: "skill-family.professional-conclusion",
    provider: { id: KIT_TOOL_NAME, version: KIT_VERSION, entry: "runPublicSurfaceBindingCheck" }, subject: { ref: root },
    scope: { checked, limitations: [...BINDING_LIMITATIONS, ...records.filter((record) => record.status === "insufficient").map((record) => "binding-" + record.index + ": " + record.reason)] },
    outcome: {
      completion: incomplete ? checked.length ? "partial" : "not-performed" : "complete",
      code: finding ? "ENGINEERING_FINDINGS" : incomplete ? "ENGINEERING_CHECK_INCOMPLETE" : "ENGINEERING_CLEAR",
      summary: finding ? "The selected public-surface bindings contain direct declaration conflicts."
        : incomplete ? "The selected public-surface bindings were not completely checked." : "All six comparisons in every selected public-surface binding completed without findings.",
    },
    details: { bindings: records, selection: selectionReceipt, closure },
  };
  const schema = findSchemaByObject("professional-conclusion");
  const validated = validateDocument(conclusion, { schemaId: schema.$id, dialect: schema.dialect, policy: "strict" });
  if (!validated.valid) throw new ContractsError("SFC1001", "generated public-surface binding conclusion violates its public contract", { errors: validated.errors });
  return validated.data;
}

export async function runPublicSurfaceBindingCheck(options) {
  const selected = bindingRequestSnapshot(options);
  const root = await resolveTargetRoot(selected.root);
  return executeBindings(root, selected.bindings);
}

export async function checkPublicSurfaceBindingsAction(options) {
  if (!fields(options, ["root", "selection"]) || typeof options.root !== "string" || !options.root
    || typeof options.selection !== "string" || !options.selection) throw invalidParamsError("public-surface-bindings requires explicit root and relative selection file");
  const { root: requestedRoot, selection } = options;
  const root = await resolveTargetRoot(requestedRoot);
  const read = await readFileStrict(root, selection, { encoding: "utf8" });
  const parsed = bindingJson(read.content);
  if (parsed.reason || !fields(parsed.value, ["bindings"])) throw invalidParamsError("selection must be unambiguous JSON containing only bindings");
  const selected = bindingRequestSnapshot({ root, bindings: parsed.value.bindings });
  return executeBindings(root, selected.bindings, receipt(selection, read));
}

const NATIVE_BINDING_FIELDS = ["commonManifestRef", "commonSkillIndex", "platformManifestRef", "mappingIndex"];
const NATIVE_LIMITATIONS = [
  "Only caller-selected native-entry identities and four direct declaration relationships were compared. The caller owns common-manifest authority, same-business correspondence and selection completeness.",
  "No Markdown body, method-contract version, natural-language identity, URI follow, Registry or target execution was checked.",
  "No target code is imported, evaluated or executed; no target files or network state are changed. References are compared as read, never followed to replace the selected authority.",
  "Strict reads and the resource closure describe observed bytes, not an atomic snapshot or isolation from concurrent writers.",
];

function nativeBindingRequestSnapshot(options) {
  if (!fields(options, ["root", "bindings"]) || typeof options.root !== "string" || !options.root
    || !Array.isArray(options.bindings) || options.bindings.length === 0) {
    throw invalidParamsError("runNativeEntryBindingCheck requires only explicit root and non-empty bindings");
  }
  const seen = new Set();
  const platformSeen = new Map();
  const bindings = Array.from(options.bindings, (binding) => {
    if (!fields(binding, NATIVE_BINDING_FIELDS)) {
      throw invalidParamsError("each native binding requires only commonManifestRef, commonSkillIndex, platformManifestRef and mappingIndex");
    }
    const copy = Object.fromEntries(NATIVE_BINDING_FIELDS.map((key) => [key, binding[key]]));
    if (![copy.commonManifestRef, copy.platformManifestRef].every((value) => typeof value === "string" && value)
      || ![copy.commonSkillIndex, copy.mappingIndex].every((value) => Number.isSafeInteger(value) && value >= 0)) {
      throw invalidParamsError("native binding refs must be non-empty strings and indexes must be non-negative safe integers");
    }
    const identity = JSON.stringify(copy);
    if (seen.has(identity)) throw invalidParamsError("bindings contains a duplicate selection");
    seen.add(identity);
    const platformKey = JSON.stringify({ platformManifestRef: copy.platformManifestRef, mappingIndex: copy.mappingIndex });
    const previous = platformSeen.get(platformKey);
    if (previous && (previous.commonManifestRef !== copy.commonManifestRef || previous.commonSkillIndex !== copy.commonSkillIndex)) {
      throw invalidParamsError("the same platform mapping is selected with conflicting common records");
    }
    platformSeen.set(platformKey, copy);
    return copy;
  });
  return { root: options.root, bindings };
}

function posixRef(value) {
  return path.posix.normalize(String(value).replaceAll("\\", "/"));
}

function identityRef(root, identity) {
  return path.relative(root, identity).split(path.sep).join("/");
}

function nativePathIssue(value) {
  if (typeof value !== "string" || !value) return { reason: "native path is not a direct non-empty local path" };
  if (/:\/\//.test(value) || value.startsWith("~") || /[*?]/.test(value) || value.includes("${")) {
    return { reason: "native path is a URI or expansion rather than a direct local path" };
  }
  const classification = classifyPathInput(value);
  if (!classification.ok) {
    return {
      reason: `native path is outside the supported contained local subset (${classification.kind})`,
      cause: { code: "SFC2004", kind: classification.kind },
    };
  }
  return null;
}

async function containedFile(root, base, relative) {
  const relativeIssue = nativePathIssue(relative);
  if (relativeIssue) return relativeIssue;
  if (base === ".") return { ref: posixRef(relative), identity: await resolveContained(root, relative) };
  const baseIssue = nativePathIssue(base);
  if (baseIssue) return baseIssue;
  await resolveContained(root, base);
  const combined = path.posix.join(posixRef(base), posixRef(relative));
  return { ref: combined, identity: await resolveContained(root, combined) };
}

function directNonEmpty(value) {
  return typeof value === "string" && value.length > 0;
}

function selectedNativeRecord(list, index, required, missingReason, fieldReason) {
  if (!Array.isArray(list) || index >= list.length) return { reason: missingReason };
  const item = list[index];
  if (!object(item) || required.some((key) => !directNonEmpty(item[key]))) return { reason: fieldReason };
  return { value: item };
}

async function observeNative(root, rel, cache, identity = null) {
  const resolved = identity ?? await resolveContained(root, rel);
  if (cache.has(resolved)) return cache.get(resolved);
  const read = await readFileStrict(root, rel, { encoding: "utf8" });
  const observed = { identity: resolved, ref: posixRef(rel), sha256: read.sha256, bytes: read.bytes, content: read.content };
  cache.set(resolved, observed);
  return observed;
}

function pushNativeResource(record, role, observed) {
  record.resources.push({ role, ref: observed.ref, sha256: observed.sha256, bytes: observed.bytes });
}

async function executeNativeBindings(root, bindings, selectionReceipt = null) {
  const records = [];
  for (const [offset, binding] of bindings.entries()) {
    const record = { index: offset + 1, ...binding, resources: [], comparisons: [], ...unknown("not checked") };
    records.push(record);
    try {
      const cache = new Map();
      const platformObserved = await observeNative(root, binding.platformManifestRef, cache);
      pushNativeResource(record, "platform-manifest", platformObserved);
      const commonObserved = await observeNative(root, binding.commonManifestRef, cache);
      pushNativeResource(record, "common-manifest", commonObserved);
      const platformParsed = bindingJson(platformObserved.content);
      const commonParsed = bindingJson(commonObserved.content);
      if (platformParsed.reason || commonParsed.reason) {
        invalidateBinding(record, platformParsed.reason || commonParsed.reason);
        continue;
      }
      if (!object(platformParsed.value) || !directNonEmpty(platformParsed.value.source) || !Array.isArray(platformParsed.value.logicalMappings)) {
        invalidateBinding(record, "platform manifest is missing a direct source or logicalMappings array");
        continue;
      }
      if (!object(commonParsed.value) || !directNonEmpty(commonParsed.value.sourceRoot) || !Array.isArray(commonParsed.value.skills)) {
        invalidateBinding(record, "common manifest is missing a direct sourceRoot or skills array");
        continue;
      }
      const mapping = selectedNativeRecord(
        platformParsed.value.logicalMappings, binding.mappingIndex,
        ["logicalName", "physicalName", "path"],
        "selected mappingIndex is outside the platform logicalMappings array",
        "selected mapping is missing direct non-empty logicalName, physicalName or path",
      );
      const skill = selectedNativeRecord(
        commonParsed.value.skills, binding.commonSkillIndex,
        ["logicalName", "source"],
        "selected commonSkillIndex is outside the common skills array",
        "selected common skill is missing direct non-empty logicalName or source",
      );
      if (mapping.reason || skill.reason) {
        invalidateBinding(record, mapping.reason || skill.reason);
        continue;
      }
      const declaredLocated = await containedFile(root, ".", platformParsed.value.source);
      if (declaredLocated.reason) {
        invalidateBinding(record, declaredLocated.reason, declaredLocated.cause);
        continue;
      }
      let declaredObserved;
      try {
        declaredObserved = await observeNative(root, declaredLocated.ref, cache, declaredLocated.identity);
      } catch (error) {
        const cause = mechanismCause(error);
        invalidateBinding(record, "declared platform source could not be read (" + cause.kind + ")", cause);
        continue;
      }
      pushNativeResource(record, "declared-source", declaredObserved);
      if (declaredObserved.identity !== commonObserved.identity) {
        const declaredParsed = bindingJson(declaredObserved.content);
        if (declaredParsed.reason || !object(declaredParsed.value)) {
          invalidateBinding(record, declaredParsed.reason || "declared platform source is not an unambiguous JSON object");
          continue;
        }
      }
      const platformDir = path.posix.dirname(posixRef(binding.platformManifestRef));
      const platformSkillLocated = await containedFile(root, platformDir, mapping.value.path);
      const commonBase = commonParsed.value.sourceRoot === "." ? "." : commonParsed.value.sourceRoot;
      const commonSkillLocated = await containedFile(root, commonBase, skill.value.source);
      if (platformSkillLocated.reason || commonSkillLocated.reason) {
        invalidateBinding(record, platformSkillLocated.reason || commonSkillLocated.reason, platformSkillLocated.cause || commonSkillLocated.cause);
        continue;
      }
      const platformSkillObserved = await observeNative(root, platformSkillLocated.ref, cache, platformSkillLocated.identity);
      pushNativeResource(record, "platform-skill", platformSkillObserved);
      const commonSkillObserved = await observeNative(root, commonSkillLocated.ref, cache, commonSkillLocated.identity);
      pushNativeResource(record, "common-skill", commonSkillObserved);
      const platformName = bindingSkillIdentity(platformSkillObserved.content, "name");
      const commonName = bindingSkillIdentity(commonSkillObserved.content, "name");
      if (platformName.reason || commonName.reason) {
        invalidateBinding(record, platformName.reason || commonName.reason);
        continue;
      }
      const actual = [
        identityRef(root, declaredObserved.identity),
        mapping.value.physicalName,
        mapping.value.logicalName,
        skill.value.logicalName,
      ];
      const expected = [
        identityRef(root, commonObserved.identity),
        platformName.value,
        skill.value.logicalName,
        commonName.value,
      ];
      record.comparisons = actual.map((value, index) => ({
        actual: value, expected: expected[index], status: value === expected[index] ? "checked" : "findings",
        reason: value === expected[index] ? "selected declaration values agree" : "selected declaration values contradict",
      }));
      record.status = record.comparisons.some((item) => item.status === "findings") ? "findings" : "checked";
      record.reason = record.status === "findings" ? "selected native-entry declarations contain a proven conflict" : "all four selected declaration comparisons completed";
    } catch (error) {
      const cause = mechanismCause(error);
      invalidateBinding(record, "a required binding resource could not be read (" + cause.kind + ")", cause);
    }
  }
  const completed = records.filter((record) => record.status !== "insufficient");
  let closure = null;
  if (completed.length) {
    const resources = records.flatMap((record) => record.resources);
    if (selectionReceipt) resources.push(selectionReceipt);
    try {
      closure = await computeResourceClosure({ root, resources: resources.map(({ ref }) => ({ path: ref, role: "input" })) });
      const actual = new Map(closure.resources.map((item) => [item.path, item.sha256]));
      const observed = new Map();
      for (const item of resources) {
        if (!observed.has(item.ref)) observed.set(item.ref, new Set());
        observed.get(item.ref).add(item.sha256);
      }
      const stable = (item) => observed.get(item.ref).size === 1 && actual.get(item.ref) === item.sha256;
      for (const record of completed) {
        if (![...record.resources, ...(selectionReceipt ? [selectionReceipt] : [])].every(stable)) {
          invalidateBinding(record, "required observation bytes differ between strict reads and resource closure");
        }
      }
    } catch (error) {
      const cause = mechanismCause(error);
      closure = null;
      for (const record of completed) invalidateBinding(record, "binding resource closure could not complete (" + cause.kind + ")", cause);
    }
  }
  const checked = records.flatMap((record) => record.comparisons.map((_item, index) => "binding-" + record.index + "-comparison-" + (index + 1)));
  const finding = records.some((record) => record.status === "findings");
  const incomplete = records.some((record) => record.status === "insufficient");
  const conclusion = {
    schemaVersion: 1, kind: "skill-family.professional-conclusion",
    provider: { id: KIT_TOOL_NAME, version: KIT_VERSION, entry: "runNativeEntryBindingCheck" }, subject: { ref: root },
    scope: { checked, limitations: [...NATIVE_LIMITATIONS, ...records.filter((record) => record.status === "insufficient").map((record) => "binding-" + record.index + ": " + record.reason)] },
    outcome: {
      completion: incomplete ? checked.length ? "partial" : "not-performed" : "complete",
      code: finding ? "ENGINEERING_FINDINGS" : incomplete ? "ENGINEERING_CHECK_INCOMPLETE" : "ENGINEERING_CLEAR",
      summary: finding ? "The selected native-entry bindings contain direct declaration conflicts."
        : incomplete ? "The selected native-entry bindings were not completely checked." : "All four comparisons in every selected native-entry binding completed without findings.",
    },
    details: { bindings: records, selection: selectionReceipt, closure },
  };
  const schema = findSchemaByObject("professional-conclusion");
  const validated = validateDocument(conclusion, { schemaId: schema.$id, dialect: schema.dialect, policy: "strict" });
  if (!validated.valid) throw new ContractsError("SFC1001", "generated native-entry binding conclusion violates its public contract", { errors: validated.errors });
  return validated.data;
}

export async function runNativeEntryBindingCheck(options) {
  const selected = nativeBindingRequestSnapshot(options);
  const root = await resolveTargetRoot(selected.root);
  return executeNativeBindings(root, selected.bindings);
}

export async function checkNativeEntryBindingsAction(options) {
  if (!fields(options, ["root", "selection"]) || typeof options.root !== "string" || !options.root
    || typeof options.selection !== "string" || !options.selection) throw invalidParamsError("native-entry-bindings requires explicit root and relative selection file");
  const { root: requestedRoot, selection } = options;
  const root = await resolveTargetRoot(requestedRoot);
  const read = await readFileStrict(root, selection, { encoding: "utf8" });
  const parsed = bindingJson(read.content);
  if (parsed.reason || !fields(parsed.value, ["bindings"])) throw invalidParamsError("selection must be unambiguous JSON containing only bindings");
  const selected = nativeBindingRequestSnapshot({ root, bindings: parsed.value.bindings });
  return executeNativeBindings(root, selected.bindings, receipt(selection, read));
}
