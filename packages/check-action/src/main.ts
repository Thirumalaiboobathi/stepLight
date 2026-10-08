import { runCheckAction } from "./check.js";
import { appendSummary, error, info, setOutput, type Env } from "./githubIO.js";
import { readInputs } from "./inputs.js";
import { InputError } from "./paths.js";

/**
 * Entry point: read inputs, evaluate the run, publish outputs and the job summary.
 * @returns the process exit code (0 pass, 1 fail or invalid input).
 * @example process.exitCode = await main(process.env)
 */
export async function main(env: Env): Promise<number> {
  try {
    const outcome = await runCheckAction(await readInputs(env));
    setOutput(env, "result", outcome.result);
    setOutput(env, "flag-count", String(outcome.flagCount));
    setOutput(env, "max-severity", outcome.maxSeverity);
    setOutput(env, "report-file", outcome.reportFile);
    appendSummary(env, outcome.summary);
    info(outcome.log);
    if (outcome.result === "fail") {
      error("Steplight check failed: the run broke the rules or raised a flag at or above fail-on (details above and in the job summary).");
      return 1;
    }
    return 0;
  } catch (err) {
    // Only InputError messages are written by this action; anything else is reported generically
    // (never echoing run content into a workflow command).
    error(err instanceof InputError ? `Steplight check: ${err.message}` : "Steplight check: unexpected error while checking the run");
    if (!(err instanceof InputError)) info(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    return 1;
  }
}
