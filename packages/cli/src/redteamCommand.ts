import { writeFile } from "node:fs/promises";
import path from "node:path";
import { listRuns, readRun } from "@steplight/core/node";
import {
  buildScorecard,
  formatScorecardMarkdown,
  formatScorecardText,
  startRedteamServer,
} from "@steplight/redteam";
import type { Command } from "commander";

/**
 * Render a scorecard for the runs in a directory.
 * @example const text = await renderScorecard(".steplight/runs", "markdown")
 */
export async function renderScorecard(dir: string, format: "text" | "markdown" | "json"): Promise<string> {
  const root = path.resolve(dir);
  const runs = await Promise.all((await listRuns(root)).map((s) => readRun(root, s.id)));
  const card = buildScorecard(runs);
  if (format === "json") {
    return JSON.stringify({ ...card, results: card.results.map((r) => ({ ...r, attack: r.attack.id })) }, null, 2);
  }
  return format === "markdown" ? formatScorecardMarkdown(card) : formatScorecardText(card);
}

/**
 * Add `steplight redteam serve|report` to a commander program.
 * @example registerRedteam(program, ".steplight/runs")
 */
export function registerRedteam(program: Command, defaultDir: string): void {
  const redteam = program
    .command("redteam")
    .description("Prompt-injection red-team pack: attack pages for testing YOUR OWN agents locally");

  redteam
    .command("serve")
    .description("Serve the attack pages (and a separate collector origin) on localhost")
    .option("-p, --port <port>", "port for the attack pages", "4790")
    .option("--collector-port <port>", "port for the collector origin (default: port + 1)")
    .action(async (opts: { port: string; collectorPort?: string }) => {
      const port = Number(opts.port);
      try {
        const site = await startRedteamServer({
          port,
          collectorPort: opts.collectorPort ? Number(opts.collectorPort) : port + 1,
        });
        console.log(`Steplight red-team pack: ${site.url}`);
        console.log(`Collector (unknown-domain stand-in): ${site.collectorUrl}`);
        console.log("Point YOUR agent at the pages (list: /attacks.json), record with Steplight, then run: steplight redteam report");
        console.log("These pages are for testing your own agents locally.");
      } catch (err) {
        console.error(`steplight: cannot start the red-team server: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  redteam
    .command("report")
    .description("Scorecard of which attacks the recorded agent runs fell for (score out of 100)")
    .option("-f, --format <format>", "text | markdown | json", "text")
    .option("-o, --out <file>", "write the report to a file")
    .option("-d, --dir <dir>", "runs directory", defaultDir)
    .action(async (opts: { format: string; out?: string; dir: string }) => {
      if (!["text", "markdown", "json"].includes(opts.format)) {
        console.error(`steplight: unknown format "${opts.format}" (use text, markdown or json)`);
        process.exitCode = 2;
        return;
      }
      const text = await renderScorecard(opts.dir, opts.format as "text" | "markdown" | "json");
      if (opts.out) {
        await writeFile(path.resolve(opts.out), text);
        console.log(`Wrote ${opts.format} scorecard to ${opts.out}`);
      } else {
        console.log(text);
      }
    });
}
