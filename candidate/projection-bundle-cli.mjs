#!/usr/bin/env node
import path from "node:path";
import { buildQuickstartProfileProjection } from "./profile-bundle.mjs";

/**
 * Build-time CLI for the Quickstart Profile v2 offline bundle. It only emits
 * the projection manifest on stdout; diagnostics go to stderr and every
 * argument or build failure exits 2. Writing stays with runProjection.
 */

const USAGE = [
  "usage: projection-bundle-cli.mjs",
  "  [--target-prefix <relative-path>]",
  "  --consumer-schema-root <absolute-build-time-root>",
  "  --consumer-schema <relative-path>   (repeatable)",
  "  --source-repository <identity>",
  "  --source-base-commit <identity>",
  "  [--fixed-set-release-receipt <absolute-path>]",
  "  [--fixed-set-candidate-root <absolute-path>]",
].join("\n");

function fail(message) {
  process.stderr.write(`${message}\n${USAGE}\n`);
  process.exit(2);
}

const args = process.argv.slice(2);
const options = { consumerSchemaPaths: [] };
for (let index = 0; index < args.length; index += 1) {
  const flag = args[index];
  const next = args[index + 1];
  switch (flag) {
    case "--target-prefix":
    case "--consumer-schema-root":
    case "--consumer-schema":
    case "--source-repository":
    case "--source-base-commit":
    case "--fixed-set-release-receipt":
    case "--fixed-set-candidate-root":
      if (next === undefined) fail(`missing value for ${flag}`);
      index += 1;
      if (flag === "--consumer-schema") options.consumerSchemaPaths.push(next);
      else if (flag === "--target-prefix") options.targetPrefix = next;
      else if (flag === "--consumer-schema-root") options.consumerSchemaRoot = next;
      else if (flag === "--source-repository") options.sourceRepository = next;
      else if (flag === "--fixed-set-release-receipt") {
        options.fixedSetCandidate = { ...(options.fixedSetCandidate ?? {}), releaseReceiptPath: next };
      }
      else if (flag === "--fixed-set-candidate-root") {
        options.fixedSetCandidate = { ...(options.fixedSetCandidate ?? {}), root: next };
      }
      else options.sourceBaseCommit = next;
      break;
    default:
      fail(`unknown argument: ${flag}`);
  }
}
if (!options.consumerSchemaRoot) fail("--consumer-schema-root is required");
if (!path.isAbsolute(options.consumerSchemaRoot)) {
  fail("--consumer-schema-root must be an absolute directory");
}
if (options.consumerSchemaPaths.length === 0) {
  fail("at least one --consumer-schema is required");
}
if (!options.sourceRepository) fail("--source-repository is required");
if (!options.sourceBaseCommit) fail("--source-base-commit is required");
if (options.fixedSetCandidate) {
  if (!path.isAbsolute(options.fixedSetCandidate.releaseReceiptPath ?? "")) {
    fail("--fixed-set-release-receipt must be an absolute path");
  }
  if (!path.isAbsolute(options.fixedSetCandidate.root ?? "")) {
    fail("--fixed-set-candidate-root must be an absolute path");
  }
}

try {
  const { manifest } = await buildQuickstartProfileProjection(options);
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
} catch (cause) {
  process.stderr.write(`${cause?.message ?? String(cause)}\n`);
  process.exit(2);
}
