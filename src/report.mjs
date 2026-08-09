import process from "node:process";
import { lstat, readFile, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  buildBinding,
  checkReport,
  computeModelDigest,
  computeResultDigest,
  digestReport,
  readFileContained,
  renderReportMarkdown,
  resolveContained,
  validateReportModel,
  writeFileAtomic,
} from "skill-family-harness-node";
import { ContractsError } from "skill-family-contracts";
import { invalidParamsError, kitError, KIT_ERROR_KINDS } from "./errors.mjs";
import { resolveTargetRoot } from "./workspace.mjs";

/**
 * Report sub-actions of the existing kit commands (FND-ADR-005 / FND-DES-004).
 *
 * These are positional sub-actions, not new top-level commands: the kit keeps
 * exactly four commands.
 *
 *   projection report  — render one validated report model to neutral Markdown
 *   check report       — grade one rendered report against its model and source result
 *
 * Write discipline: rendering writes nothing by default (Markdown goes to
 * stdout); a file is written only when explicit --out/--binding paths are
 * given, and every such path is contained inside --root and written
 * atomically. `check report` never writes. Hard failures and advisory style
 * warnings are separate outputs: style warnings never block a
 * machine-correct report, and hard failures never exit 0.
 *
 * Actions return { status: "ok" | "findings" | "rejected", output }; the CLI
 * maps status onto KIT_EXIT_CODES (0/1/2). Throws carry registered SFC codes.
 */

async function readReportJson(rootAbs, relPath, role) {
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw invalidParamsError(`${role} path must be a non-empty relative path`, { flag: `--${role}` });
  }
  let text;
  try {
    text = await readFileContained(rootAbs, relPath, { encoding: "utf8" });
  } catch (cause) {
    throw kitError(
      KIT_ERROR_KINDS.REPORT_INPUT_MISSING,
      `report ${role} is missing or unreadable: ${relPath}`,
      { path: relPath, causeKind: cause && cause.details ? cause.details.kind : undefined },
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw kitError(
      KIT_ERROR_KINDS.CONTRACT_PARSE_FAILED,
      `report ${role} is not valid JSON: ${relPath}`,
      { path: relPath },
    );
  }
}

async function readReportText(rootAbs, relPath, role) {
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw invalidParamsError(`${role} path must be a non-empty relative path`, { flag: `--${role}` });
  }
  try {
    return await readFileContained(rootAbs, relPath, { encoding: "utf8" });
  } catch (cause) {
    throw kitError(
      KIT_ERROR_KINDS.REPORT_INPUT_MISSING,
      `report ${role} is missing or unreadable: ${relPath}`,
      { path: relPath, causeKind: cause && cause.details ? cause.details.kind : undefined },
    );
  }
}

async function canonicalCandidate(absPath) {
  try {
    return await realpath(absPath);
  } catch {
    const missing = [path.basename(absPath)];
    let ancestor = path.dirname(absPath);
    while (true) {
      try {
        return path.join(await realpath(ancestor), ...missing);
      } catch {
        const parent = path.dirname(ancestor);
        if (parent === ancestor) return absPath;
        missing.unshift(path.basename(ancestor));
        ancestor = parent;
      }
    }
  }
}

async function describeReportPath(rootAbs, relPath, role, { output = false } = {}) {
  const absPath = await resolveContained(rootAbs, relPath);
  let entry = null;
  try {
    entry = await lstat(absPath);
  } catch {
    entry = null;
  }
  if (output && entry?.isSymbolicLink()) {
    throw kitError(
      KIT_ERROR_KINDS.REPORT_PATH_CONFLICT,
      `report ${role} must not be a symbolic link`,
      { role, path: relPath },
    );
  }
  if (output && entry && !entry.isFile()) {
    throw kitError(
      KIT_ERROR_KINDS.REPORT_PATH_CONFLICT,
      `report ${role} must be absent or a regular file`,
      { role, path: relPath },
    );
  }
  let identity = null;
  if (entry) {
    try {
      const inspected = await stat(absPath);
      identity = `${inspected.dev}:${inspected.ino}`;
    } catch {
      identity = null;
    }
  }
  return {
    role,
    relPath,
    absPath,
    canonicalPath: await canonicalCandidate(absPath),
    identity,
    existed: entry !== null,
  };
}

function samePath(left, right) {
  return left.canonicalPath === right.canonicalPath ||
    (left.identity !== null && left.identity === right.identity);
}

async function stageReportOutputs(rootAbs, options, markdown, bindingDocument) {
  const inputs = [
    await describeReportPath(rootAbs, options.model, "model"),
    await describeReportPath(rootAbs, options.result, "result"),
  ];
  const outputs = [
    await describeReportPath(rootAbs, options.out, "out", { output: true }),
    await describeReportPath(rootAbs, options.binding, "binding", { output: true }),
  ];
  for (const [index, output] of outputs.entries()) {
    for (const other of [...inputs, ...outputs.slice(0, index)]) {
      if (samePath(output, other)) {
        throw kitError(
          KIT_ERROR_KINDS.REPORT_PATH_CONFLICT,
          `report ${output.role} aliases ${other.role}; inputs and outputs must be distinct`,
          { role: output.role, path: output.relPath, conflictsWith: other.role },
        );
      }
    }
  }
  const contents = [markdown, `${JSON.stringify(bindingDocument, null, 2)}\n`];
  return Promise.all(outputs.map(async (output, index) => ({
    ...output,
    content: contents[index],
    priorBytes: output.existed ? await readFile(output.absPath) : null,
  })));
}

async function rollbackReportOutputs(rootAbs, written, rollbackWrite = writeFileAtomic) {
  const failures = [];
  for (const output of [...written].reverse()) {
    try {
      if (output.priorBytes === null) {
        await rm(output.absPath, { force: true });
      } else {
        await rollbackWrite(rootAbs, output.relPath, output.priorBytes);
      }
    } catch (cause) {
      failures.push({ role: output.role, message: cause?.message ?? String(cause) });
    }
  }
  return failures;
}

async function commitReportOutputs(rootAbs, staged, fileOps = {}) {
  const commitWrite = fileOps.commitWrite ?? writeFileAtomic;
  const rollbackWrite = fileOps.rollbackWrite ?? writeFileAtomic;
  const written = [];
  try {
    for (const output of staged) {
      await commitWrite(rootAbs, output.relPath, output.content);
      written.push(output);
    }
  } catch (cause) {
    const rollbackFailures = await rollbackReportOutputs(rootAbs, written, rollbackWrite);
    if (rollbackFailures.length === 0 && cause instanceof ContractsError) throw cause;
    throw kitError(
      KIT_ERROR_KINDS.REPORT_WRITE_FAILED,
      "report output group commit failed; committed outputs were rolled back",
      {
        causeCode: cause?.code,
        causeKind: cause?.details?.kind,
        causeMessage: cause?.message ?? String(cause),
        rollbackFailures,
      },
    );
  }
}

/**
 * `projection report`: deterministic render of one caller-authored report model.
 *
 * Options: root, model (required), result (required), out, binding.
 * Without --out the Markdown goes to stdout and nothing is written; with
 * --out, --binding is mandatory and only those explicit contained paths are
 * written, atomically. A missing report element rejects with an SFC3002 list
 * and writes nothing (no half report).
 */
export async function renderReportAction(options = {}) {
  const rootAbs = await resolveTargetRoot(options.root ?? ".");
  if (!options.model) {
    throw invalidParamsError("projection report: --model <path> is required", { flag: "--model" });
  }
  if (!options.result) {
    throw invalidParamsError("projection report: --result <path> is required", { flag: "--result" });
  }
  if (options.out && !options.binding) {
    return {
      status: "rejected",
      output: {
        kind: "skill-family.kit.report-render",
        ok: false,
        errors: [{
          code: "SFC3002",
          message: "missing report element: binding",
          details: { element: "binding" },
        }],
      },
    };
  }
  if (!options.out && options.binding) {
    throw invalidParamsError("projection report: --binding requires --out", { flag: "--binding" });
  }
  const reportModel = await readReportJson(rootAbs, options.model, "model");
  const resultDocument = await readReportJson(rootAbs, options.result, "result");
  const validated = validateReportModel(reportModel, { resultDocument });
  if (!validated.ok) {
    return {
      status: "rejected",
      output: {
        kind: "skill-family.kit.report-render",
        ok: false,
        errors: validated.hardFailures,
      },
    };
  }

  const markdown = renderReportMarkdown(reportModel);
  const summary = {
    kind: "skill-family.kit.report-render",
    ok: true,
    runId: reportModel.identity.runId,
    locale: reportModel.identity.locale,
    modelDigest: computeModelDigest(reportModel),
    resultDigest: computeResultDigest(resultDocument),
    reportDigest: digestReport(markdown),
    bytes: Buffer.byteLength(markdown, "utf8"),
    writes: [],
  };

  if (options.out) {
    const bindingDocument = buildBinding(reportModel, resultDocument, markdown);
    const staged = await stageReportOutputs(rootAbs, options, markdown, bindingDocument);
    await commitReportOutputs(rootAbs, staged, options.fileOps);
    summary.writes.push({ path: options.out, role: "report" });
    summary.writes.push({ path: options.binding, role: "binding" });
  } else {
    // stdout mode: the Markdown itself is the only stdout payload.
    process.stdout.write(markdown);
  }
  return { status: "ok", output: options.out ? summary : undefined };
}

/**
 * `check report`: graded diagnosis of one rendered report.
 *
 * Options: root, report (required), model (required), result (required), binding.
 * Read-only, never writes. Hard failures (SFC3001/SFC3002/SFC3003)
 * are findings (exit 1); advisory style warnings are reported alongside but
 * never change the verdict; usage/mechanism problems throw (exit 2).
 */
export async function checkReportAction(options = {}) {
  const rootAbs = await resolveTargetRoot(options.root ?? ".");
  if (!options.report) {
    throw invalidParamsError("check report: --report <path> is required", { flag: "--report" });
  }
  if (!options.model) {
    throw invalidParamsError("check report: --model <path> is required", { flag: "--model" });
  }
  if (!options.result) {
    throw invalidParamsError("check report: --result <path> is required", { flag: "--result" });
  }
  const reportMarkdown = await readReportText(rootAbs, options.report, "report");
  const reportModel = await readReportJson(rootAbs, options.model, "model");
  const resultDocument = await readReportJson(rootAbs, options.result, "result");
  const binding = options.binding
    ? await readReportJson(rootAbs, options.binding, "binding")
    : undefined;

  const graded = checkReport({
    reportMarkdown,
    reportModel,
    resultDocument,
    binding,
  });

  return {
    status: graded.ok ? "ok" : "findings",
    output: {
      kind: "skill-family.kit.report-check",
      ok: graded.ok,
      hardFailures: graded.hardFailures,
      styleWarnings: graded.styleWarnings,
      digests: {
        model: computeModelDigest(reportModel),
        report: digestReport(reportMarkdown),
        result: computeResultDigest(resultDocument),
      },
    },
  };
}
