import { createRequire } from "node:module";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
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

const SOURCE_IDENTITY = "skill-family-foundation-workspace";
const DEFAULT_TARGET_PREFIX = "foundation/quickstart-profile";
const RUNTIME_EXTENSIONS = new Set([".js", ".json", ".cjs", ".mjs"]);
const requireFromKit = createRequire(import.meta.url);

function posix(relPath) {
  return relPath.split(path.sep).join("/");
}

async function packageRoot(entryPath, expectedName) {
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

async function walkFiles(root, relBase = "", accept = () => true) {
  const files = [];
  const entries = await readdir(path.join(root, relBase), { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = relBase === "" ? entry.name : path.join(relBase, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      files.push(...(await walkFiles(root, rel, accept)));
    } else if (entry.isFile() && accept(rel)) {
      files.push(posix(rel));
    }
  }
  return files;
}

function runtimeFile(relPath) {
  const base = path.basename(relPath);
  const parts = posix(relPath).split("/");
  if (
    parts.some((part) => ["test", "tests", "spec", "benchmark", "benchmarks"].includes(part)) ||
    base === ".runkit_example.js"
  ) {
    return false;
  }
  return (
    relPath === "package.json" ||
    RUNTIME_EXTENSIONS.has(path.extname(relPath)) ||
    /^LICEN[CS]E(?:[.-].*)?$/.test(base) ||
    /^NOTICE(?:[.-].*)?$/.test(base)
  );
}

async function addTree(files, sourceRoot, targetRoot, relPaths) {
  for (const rel of relPaths) {
    files.set(`${targetRoot}/${posix(rel)}`, await readFile(path.join(sourceRoot, rel)));
  }
}

async function resolveExternalClosure(contractsEntry) {
  const queue = ["ajv"];
  const packages = new Map();
  let parentRequire = createRequire(pathToFileURL(contractsEntry));
  while (queue.length > 0) {
    const name = queue.shift();
    if (packages.has(name)) continue;
    const entry = parentRequire.resolve(name);
    const resolved = await packageRoot(entry, name);
    packages.set(name, resolved);
    const requireFromPackage = createRequire(pathToFileURL(path.join(resolved.root, "package.json")));
    for (const dependency of Object.keys(resolved.packageJson.dependencies ?? {}).sort()) {
      if (!packages.has(dependency)) queue.push(dependency);
      // Resolve each dependency from the package that declares it. pnpm's
      // isolated layout requires this parent-specific resolver.
      if (!packages.has(dependency)) {
        const depEntry = requireFromPackage.resolve(dependency);
        const depRoot = await packageRoot(depEntry, dependency);
        packages.set(dependency, depRoot);
        for (const nested of Object.keys(depRoot.packageJson.dependencies ?? {}).sort()) {
          if (!packages.has(nested)) queue.push(nested);
        }
      }
    }
    parentRequire = requireFromPackage;
  }
  return packages;
}

function normalizePrefix(targetPrefix) {
  if (
    typeof targetPrefix !== "string" ||
    !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(targetPrefix)
  ) {
    throw new TypeError("targetPrefix must be a contained relative POSIX path");
  }
  return targetPrefix;
}

async function sourceClosure({ contractsRoot, harnessRoot, kitRoot }) {
  const contractCandidate = [
    "candidate/quickstart-profile/index.mjs",
    "candidate/quickstart-profile/resource.schema.json",
    "candidate/quickstart-profile/task.schema.json",
    "candidate/quickstart-profile/result.schema.json",
  ];
  const sources = [
    ...["package.json", ...(await walkFiles(contractsRoot, "src")), ...contractCandidate]
      .map((rel) => [contractsRoot, rel, `packages/skill-family-contracts/${rel}`]),
    ...["package.json", ...(await walkFiles(harnessRoot, "src")), ...(await walkFiles(harnessRoot, "candidate"))]
      .map((rel) => [harnessRoot, rel, `packages/skill-family-harness-node/${rel}`]),
    [kitRoot, "candidate/profile-bundle.mjs", "packages/skill-family-engineering-kit/candidate/profile-bundle.mjs"],
  ];
  const records = [];
  for (const [root, rel, displayPath] of sources) {
    records.push({ path: displayPath, sha256: digestBytes(await readFile(path.join(root, rel))) });
  }
  records.sort((a, b) => a.path.localeCompare(b.path));
  return { files: records, digest: digestBytes(Buffer.from(canonicalJson(records), "utf8")) };
}

/**
 * Build the deterministic, self-contained Quickstart candidate bundle.
 * The returned entries are ordinary `skill-family.projection.json` entries;
 * runProjection remains the only writer and authorization boundary.
 */
export async function buildQuickstartProfileProjection({
  targetPrefix = DEFAULT_TARGET_PREFIX,
} = {}) {
  const prefix = normalizePrefix(targetPrefix);
  const contractsEntry = requireFromKit.resolve("skill-family-contracts");
  const harnessEntry = requireFromKit.resolve("skill-family-harness-node");
  const contracts = await packageRoot(contractsEntry, "skill-family-contracts");
  const harness = await packageRoot(harnessEntry, "skill-family-harness-node");
  const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  const files = new Map();
  await addTree(
    files,
    contracts.root,
    "node_modules/skill-family-contracts",
    ["package.json", ...(await walkFiles(contracts.root, "src"))],
  );
  await addTree(
    files,
    contracts.root,
    "node_modules/skill-family-contracts",
    [
      "candidate/quickstart-profile/index.mjs",
      "candidate/quickstart-profile/resource.schema.json",
      "candidate/quickstart-profile/task.schema.json",
      "candidate/quickstart-profile/result.schema.json",
    ],
  );
  await addTree(
    files,
    harness.root,
    "node_modules/skill-family-harness-node",
    ["package.json", ...(await walkFiles(harness.root, "src"))],
  );
  await addTree(
    files,
    harness.root,
    "node_modules/skill-family-harness-node",
    await walkFiles(harness.root, "candidate"),
  );

  const external = await resolveExternalClosure(contractsEntry);
  const dependencyVersions = [];
  for (const [name, resolved] of [...external.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const relPaths = await walkFiles(resolved.root, "", runtimeFile);
    await addTree(files, resolved.root, `node_modules/${name}`, relPaths);
    dependencyVersions.push({ name, version: resolved.packageJson.version });
  }

  const schemaRoot = "node_modules/skill-family-contracts/candidate/quickstart-profile";
  for (const name of ["resource", "task", "result"]) {
    files.set(`schemas/${name}.schema.json`, files.get(`${schemaRoot}/${name}.schema.json`));
  }
  files.set(
    "runner.mjs",
    Buffer.from(
      [
        'export * from "./node_modules/skill-family-harness-node/candidate/quickstart-profile.mjs";',
        'export { validateQuickstartProfileDocument } from "./node_modules/skill-family-contracts/candidate/quickstart-profile/index.mjs";',
        "",
      ].join("\n"),
      "utf8",
    ),
  );
  files.set(
    "mechanisms-cli.mjs",
    Buffer.from(
      [
        'import { runMechanismCli } from "./node_modules/skill-family-harness-node/candidate/mechanisms-cli.mjs";',
        "process.exitCode = await runMechanismCli();",
        "",
      ].join("\n"),
      "utf8",
    ),
  );

  const source = await sourceClosure({
    contractsRoot: contracts.root,
    harnessRoot: harness.root,
    kitRoot,
  });
  const bundleFiles = [...files.entries()]
    .map(([filePath, bytes]) => ({ path: filePath, sha256: digestBytes(bytes) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const provenance = {
    schemaVersion: 1,
    kind: "skill-family.foundation-projection",
    profile: {
      id: QUICKSTART_PROFILE_ID,
      version: QUICKSTART_PROFILE_VERSION,
      contractsVersion: CONTRACTS_VERSION,
    },
    source: {
      identity: SOURCE_IDENTITY,
      closure: { digest: source.digest },
    },
    runtimeDependencies: dependencyVersions,
    bundle: {
      digestAlgorithm: "sha256",
      files: bundleFiles,
      digest: digestBytes(Buffer.from(canonicalJson(bundleFiles), "utf8")),
    },
  };
  files.set(
    "foundation-projection.json",
    Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`, "utf8"),
  );

  const entries = [...files.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([filePath, bytes]) => ({
      path: `${prefix}/${filePath}`,
      content: { text: bytes.toString("utf8") },
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
