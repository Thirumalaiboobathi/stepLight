import type { Severity } from "@steplight/core";
import { getInput, type Env } from "./githubIO.js";
import { InputError, resolveInside, validateRunId } from "./paths.js";

/** Report formats the action can write. */
export type Format = "text" | "junit" | "sarif";

export const DEFAULT_RULES_FILE = "steplight.rules.yml";
const FORMATS: readonly Format[] = ["text", "junit", "sarif"];
const SEVERITIES: readonly Severity[] = ["low", "medium", "high", "critical"];

/** Validated inputs with every path resolved inside the workspace. */
export interface ActionInputs {
  workspace: string;
  runsDir: string;
  runId?: string;
  rulesFile: string;
  /** True when `rules` was left at its default (a missing default file is not an error). */
  rulesIsDefault: boolean;
  format: Format;
  outputFile?: string;
  failOn: Severity;
}

/**
 * Read and validate all inputs.
 * @throws InputError with a message safe to show in the log.
 * @example const inputs = await readInputs(process.env)
 */
export async function readInputs(env: Env): Promise<ActionInputs> {
  const workspace = env["GITHUB_WORKSPACE"] || process.cwd();

  const format = (getInput(env, "format") || "text").toLowerCase();
  if (!(FORMATS as readonly string[]).includes(format)) throw new InputError(`format must be one of: ${FORMATS.join(", ")}`);

  const failOn = (getInput(env, "fail-on") || "high").toLowerCase();
  if (!(SEVERITIES as readonly string[]).includes(failOn)) throw new InputError(`fail-on must be one of: ${SEVERITIES.join(", ")}`);

  const runId = getInput(env, "run-id");
  if (runId) validateRunId(runId);

  const rules = getInput(env, "rules") || DEFAULT_RULES_FILE;
  const outputRaw = getInput(env, "output-file");

  return {
    workspace,
    runsDir: await resolveInside(workspace, getInput(env, "runs-dir") || ".steplight/runs", "runs-dir"),
    runId: runId || undefined,
    rulesFile: await resolveInside(workspace, rules, "rules"),
    rulesIsDefault: rules === DEFAULT_RULES_FILE,
    format: format as Format,
    outputFile: outputRaw ? await resolveInside(workspace, outputRaw, "output-file") : undefined,
    failOn: failOn as Severity,
  };
}
