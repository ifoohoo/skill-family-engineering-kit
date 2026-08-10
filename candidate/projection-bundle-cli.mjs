#!/usr/bin/env node
import { buildQuickstartProfileProjection } from "./profile-bundle.mjs";

const args = process.argv.slice(2);
let targetPrefix;
if (args.length > 0) {
  if (args.length !== 2 || args[0] !== "--target-prefix") {
    process.stderr.write("usage: projection-bundle-cli.mjs [--target-prefix <relative-path>]\n");
    process.exitCode = 2;
  } else {
    targetPrefix = args[1];
  }
}
if (process.exitCode !== 2) {
  try {
    const { manifest } = await buildQuickstartProfileProjection({ targetPrefix });
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } catch (cause) {
    process.stderr.write(`${cause?.message ?? String(cause)}\n`);
    process.exitCode = 2;
  }
}
