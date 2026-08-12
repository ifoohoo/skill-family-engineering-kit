#!/usr/bin/env node
import { checkPluginSkillNaming } from "./skill-naming.mjs";

/**
 * Build-time CLI for the candidate plugin skill naming check. It only emits
 * the report on stdout; diagnostics go to stderr. Exit codes: 0 = every
 * skill passes, 1 = at least one rule FAIL, 2 = usage or mechanism error.
 * The CLI never writes anywhere.
 */

const USAGE = [
  "usage: skill-naming-cli.mjs",
  "  --skills-root <directory>     (required; each immediate child with SKILL.md is one published skill)",
  "  --plugin-slug <slug>          (required; the published plugin slug, required as description signal)",
  "  --name-prefix <prefix>        (optional approved name prefix; defaults to the plugin slug)",
  "  --domain-signal <word>        (repeatable; extra domain words accepted as description signals)",
  "  --policy <path>               (optional; defaults to the bundled candidate policy)",
].join("\n");

function fail(message) {
  process.stderr.write(`${message}\n${USAGE}\n`);
  process.exit(2);
}

const args = process.argv.slice(2);
const options = { domainSignals: [] };
for (let index = 0; index < args.length; index += 1) {
  const flag = args[index];
  const next = args[index + 1];
  switch (flag) {
    case "--skills-root":
    case "--plugin-slug":
    case "--name-prefix":
    case "--domain-signal":
    case "--policy":
      if (next === undefined) fail(`missing value for ${flag}`);
      index += 1;
      if (flag === "--skills-root") options.skillsRoot = next;
      else if (flag === "--plugin-slug") options.pluginSlug = next;
      else if (flag === "--name-prefix") options.namePrefix = next;
      else if (flag === "--domain-signal") options.domainSignals.push(next);
      else options.policyPath = next;
      break;
    default:
      fail(`unknown argument: ${flag}`);
  }
}
if (!options.skillsRoot) fail("--skills-root is required");
if (!options.pluginSlug) fail("--plugin-slug is required");

try {
  const report = await checkPluginSkillNaming(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.ok ? 0 : 1);
} catch (cause) {
  const kind = cause && cause.details && cause.details.kind ? ` (${cause.details.kind})` : "";
  process.stderr.write(`${cause?.code ?? "SFC2004"}${kind}: ${cause?.message ?? String(cause)}\n`);
  process.exit(2);
}
