import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { DEFAULT_RUNS_DIR, clearRuns, exportRunOtlp, generatePlaywrightTest, readRun, DEFAULT_OTLP_ENDPOINT } from "@steplight/core/node";
import { runCheck } from "./checkCommand.js";
import { registerRedteam } from "./redteamCommand.js";
import type { CheckFormat } from "./checkFormats.js";
import { diffStored, formatDiff } from "./diffCommand.js";
import { createViewerServer, findViewerDir } from "./server.js";

/** Default port of the local viewer / ingest server. */
export const DEFAULT_PORT = 4777;

/**
 * Build the `steplight` command-line program.
 * @example await buildProgram().parseAsync(["node", "steplight", "view", "--port", "4777"])
 */
export function buildProgram(): Command {
  const program = new Command();
  program
    .name("steplight")
    .description("Replay and trace every step your AI agent takes.")
    .version("0.1.0");

  program
    .command("view")
    .description("Serve the replay viewer and JSON API for recorded runs (localhost only)")
    .option("-p, --port <port>", "port to listen on", String(DEFAULT_PORT))
    .option("-d, --dir <dir>", "runs directory", process.env.STEPLIGHT_DIR ?? DEFAULT_RUNS_DIR)
    .action((opts: { port: string; dir: string }) => {
      const here = path.dirname(fileURLToPath(import.meta.url));
      const runsDir = path.resolve(opts.dir);
      const server = createViewerServer({ runsDir, viewerDir: findViewerDir(here) });
      const port = Number(opts.port);
      server.on("error", (err) => {
        console.error(`steplight: cannot listen on port ${port}: ${err.message}`);
        process.exitCode = 1;
      });
      server.listen(port, "127.0.0.1", () => {
        console.log(`Steplight viewer: http://localhost:${port}\nRuns directory:   ${runsDir}`);
      });
    });

  program
    .command("export <runId>")
    .description("Export a stored run: print JSON, or re-send it as OpenTelemetry spans with --otlp")
    .option("--otlp", "send the run to the OTLP/HTTP endpoint")
    .option("--endpoint <url>", `OTLP endpoint (default: $OTEL_EXPORTER_OTLP_ENDPOINT or ${DEFAULT_OTLP_ENDPOINT})`)
    .option("-d, --dir <dir>", "runs directory", process.env.STEPLIGHT_DIR ?? DEFAULT_RUNS_DIR)
    .action(async (runId: string, opts: { otlp?: boolean; endpoint?: string; dir: string }) => {
      try {
        const run = await readRun(path.resolve(opts.dir), runId);
        if (!opts.otlp) {
          console.log(JSON.stringify(run, null, 2));
          return;
        }
        const ok = await exportRunOtlp(run, { endpoint: opts.endpoint });
        console.log(
          ok
            ? `Sent run ${run.id} (${run.steps.length} steps) to ${opts.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? DEFAULT_OTLP_ENDPOINT}`
            : "Export failed (is a collector listening?)",
        );
        if (!ok) process.exitCode = 1;
      } catch (err) {
        console.error(`steplight: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  program
    .command("clear")
    .description("Delete recorded runs (all, or all but the newest N with --keep)")
    .option("-k, --keep <n>", "keep the newest N runs", "0")
    .option("-d, --dir <dir>", "runs directory", process.env.STEPLIGHT_DIR ?? DEFAULT_RUNS_DIR)
    .action(async (opts: { keep: string; dir: string }) => {
      const keep = Number(opts.keep);
      if (!Number.isInteger(keep) || keep < 0) {
        console.error("steplight: --keep must be a non-negative integer");
        process.exitCode = 1;
        return;
      }
      const deleted = await clearRuns(path.resolve(opts.dir), { keep });
      console.log(`Deleted ${deleted.length} run${deleted.length === 1 ? "" : "s"}${keep ? `, kept the newest ${keep}` : ""}.`);
    });

  program
    .command("diff <runA> <runB>")
    .description("Compare two runs: find where they first diverge and what each saw there (exit 1 if they differ)")
    .option("--json", "print the diff as JSON")
    .option("-d, --dir <dir>", "runs directory", process.env.STEPLIGHT_DIR ?? DEFAULT_RUNS_DIR)
    .action(async (a: string, b: string, opts: { json?: boolean; dir: string }) => {
      try {
        const { diff } = await diffStored(path.resolve(opts.dir), a, b);
        console.log(opts.json ? JSON.stringify(diff, null, 2) : formatDiff(diff));
        if (!diff.identical) process.exitCode = 1;
      } catch (err) {
        console.error(`steplight: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 2;
      }
    });

  program
    .command("replay-script <runId>")
    .description("Generate a Playwright test that replays a recorded run (navigations, clicks, inputs, URL assertions)")
    .option("-o, --out <file>", "write to a file instead of stdout")
    .option("--base-url <url>", "origin the site was served from (default: the recorded one)")
    .option("-d, --dir <dir>", "runs directory", process.env.STEPLIGHT_DIR ?? DEFAULT_RUNS_DIR)
    .action(async (runId: string, opts: { out?: string; baseUrl?: string; dir: string }) => {
      try {
        const run = await readRun(path.resolve(opts.dir), runId);
        const code = generatePlaywrightTest(run, { baseUrl: opts.baseUrl });
        if (opts.out) {
          await writeFile(path.resolve(opts.out), code);
          console.log(`Wrote ${opts.out}. Run it with: BASE_URL=<site> npx playwright test ${opts.out}`);
        } else {
          process.stdout.write(code);
        }
      } catch (err) {
        console.error(`steplight: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  program
    .command("check [runId]")
    .description("Fail (exit 1) when a run breaks the rules in steplight.rules.yml: for CI")
    .option("--latest", "check the newest run")
    .option("-r, --rules <file>", "rules file", "steplight.rules.yml")
    .option("-f, --format <format>", "text | junit | sarif", "text")
    .option("-o, --out <file>", "write the report to a file")
    .option("-d, --dir <dir>", "runs directory", process.env.STEPLIGHT_DIR ?? DEFAULT_RUNS_DIR)
    .action(async (runId: string | undefined, opts: { latest?: boolean; rules: string; format: string; out?: string; dir: string }) => {
      if (!["text", "junit", "sarif"].includes(opts.format)) {
        console.error(`steplight: unknown format "${opts.format}" (use text, junit or sarif)`);
        process.exitCode = 2;
        return;
      }
      const { output, exitCode } = await runCheck({
        runId,
        latest: opts.latest,
        rulesFile: opts.rules,
        format: opts.format as CheckFormat,
        dir: opts.dir,
        out: opts.out,
      });
      (exitCode === 2 ? console.error : console.log)(output);
      process.exitCode = exitCode;
    });

  registerRedteam(program, process.env.STEPLIGHT_DIR ?? DEFAULT_RUNS_DIR);

  return program;
}
export { createViewerServer, findViewerDir } from "./server.js";
export type { IngestMessage, ServerOptions } from "./server.js";
export { diffStored, formatDiff } from "./diffCommand.js";
export { runCheck } from "./checkCommand.js";
export { formatCheck } from "./checkFormats.js";
