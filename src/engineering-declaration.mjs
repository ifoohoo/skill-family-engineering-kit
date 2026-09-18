import { findSchemaByObject, validateDocument } from "skill-family-contracts";
import { readFileStrict } from "skill-family-harness-node";
import { PROJECT_MANIFEST_PATH } from "./skeleton.mjs";

function referenceIdentity(reference) {
  return JSON.stringify([
    reference.path,
    reference.format,
    reference.format === "json" ? reference.jsonPointer : null,
  ]);
}

function semanticProblems(engineering, section) {
  const problems = [];
  if (section === "releaseUnits") {
    const unitIds = new Set();
    const mirrorOwners = new Map();
    for (const [index, unit] of engineering.releaseUnits.entries()) {
      if (unitIds.has(unit.id)) {
        problems.push({ field: `engineering.releaseUnits[${index}].id`, reason: "duplicate-release-unit-id", value: unit.id });
      }
      unitIds.add(unit.id);
      const sourceIdentity = referenceIdentity(unit.versionSource);
      for (const [mirrorIndex, mirror] of (unit.versionMirrors ?? []).entries()) {
        const identity = referenceIdentity(mirror);
        if (identity === sourceIdentity) {
          problems.push({
            field: `engineering.releaseUnits[${index}].versionMirrors[${mirrorIndex}]`,
            reason: "mirror-equals-unit-source",
            value: mirror,
          });
        }
        if (mirrorOwners.has(identity)) {
          problems.push({
            field: `engineering.releaseUnits[${index}].versionMirrors[${mirrorIndex}]`,
            reason: "duplicate-mirror-reference",
            value: mirror,
            firstOwner: mirrorOwners.get(identity),
          });
        } else {
          mirrorOwners.set(identity, unit.id);
        }
      }
    }
  } else {
    const names = new Set();
    for (const [index, entry] of engineering.entries.entries()) {
      if (names.has(entry.name)) {
        problems.push({ field: `engineering.entries[${index}].name`, reason: "duplicate-entry-name", value: entry.name });
      }
      names.add(entry.name);
    }
  }
  return problems;
}

/** Reads and validates the one project-owned engineering declaration. */
export async function loadEngineeringDeclaration(rootAbs, section) {
  let receipt;
  try {
    receipt = await readFileStrict(rootAbs, PROJECT_MANIFEST_PATH, { encoding: "utf8" });
  } catch (cause) {
    if (cause?.details?.kind === "missing-resource") {
      return { declared: false, state: "missing", value: null, problems: [] };
    }
    throw cause;
  }

  let value;
  try {
    value = JSON.parse(receipt.content);
  } catch {
    return { declared: true, state: "parse-failed", value: null, problems: [] };
  }

  const registration = findSchemaByObject("project-manifest");
  const validation = validateDocument(value, {
    schemaId: registration.$id,
    dialect: registration.dialect,
    policy: "strict",
  });
  if (!validation.valid) {
    return {
      declared: true,
      state: "schema-invalid",
      value,
      problems: validation.errors,
    };
  }

  const engineering = validation.data.engineering;
  if (!engineering || !Array.isArray(engineering[section])) {
    return { declared: true, state: "incomplete", value: validation.data, problems: [] };
  }
  const problems = semanticProblems(engineering, section);
  if (problems.length > 0) {
    return { declared: true, state: "schema-invalid", value: validation.data, problems };
  }
  return {
    declared: true,
    state: "ok",
    value: validation.data,
    engineering,
    declaration: engineering[section],
    problems: [],
  };
}

