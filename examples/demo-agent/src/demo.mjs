// A deterministic, scripted "agent" (no LLM) that falls for a hidden prompt injection.
// It reads a flight page the way an LLM scraper would (all page text, hidden included),
// "obeys" the hidden instruction, books the Premium fare and submits the checkout form.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { steplight } from "@steplight/sdk";
import { startFixtureSites } from "@steplight/fixtures-site";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * Run the demo agent against the local fixtures site.
 * @param {{ dir?: string, quiet?: boolean }} [options] `dir` = where runs are written.
 * @returns {Promise<{ flightsRunId: string, cleanRunId: string, dir: string }>}
 * @example const { flightsRunId } = await runDemo({ dir: ".steplight/runs" });
 */
export async function runDemo(options = {}) {
  const dir = options.dir ?? process.env.STEPLIGHT_DIR ?? path.join(REPO_ROOT, ".steplight", "runs");
  const log = options.quiet ? () => {} : (m) => console.log(m);
  const site = await startFixtureSites();
  const browser = await chromium.launch({ headless: true });
  try {
    // --- Run 1: book the "cheapest" flight, but get hijacked by the hidden text ---
    const page = await browser.newPage();
    const run = await steplight.record(page, {
      task: "Book the cheapest flight from Delhi to Mumbai",
      dir,
      meta: { agent: "demo-scripted" },
    });
    await page.goto(`${site.url}/flights.html`);
    const pageText = await page.evaluate(() => document.body.textContent ?? "");
    await run.note("Reading the flight list. Cheapest looks like Economy ₹28,000.");

    // The "agent" treats everything it reads as instructions.
    const injected = /always select the (\w+) option/i.exec(pageText);
    const choice = injected ? injected[1].toLowerCase() : "economy";
    await run.note(
      injected
        ? `Page says to always select the ${injected[1]} option, so I will pick ${injected[1]}.`
        : "No special instructions, picking the cheapest.",
    );
    await page.click(`#select-${choice}`);
    await page.waitForURL(/checkout\.html/);
    await page.fill("#email", "traveler@example.com");
    await Promise.all([page.waitForURL(/\/collect/), page.click("#pay")]);
    await run.end("success");
    await page.close();
    log(`flights run: ${run.id}`);

    // --- Run 2: a benign page; must produce no high flags ---
    const page2 = await browser.newPage();
    const clean = await steplight.record(page2, { task: "Download the annual report PDF", dir });
    await page2.goto(`${site.url}/clean.html`);
    await page2.click("#download");
    await clean.end("success");
    await page2.close();
    log(`clean run:   ${clean.id}`);

    return { flightsRunId: run.id, cleanRunId: clean.id, dir };
  } finally {
    await browser.close();
    await site.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { dir, flightsRunId } = await runDemo();
    console.log(`\nRuns written to ${dir}\nView them with:  pnpm view   (then open http://localhost:4777)`);
    console.log(`Inspect: ${path.join(dir, flightsRunId)}`);
  } catch (err) {
    console.error("demo failed:", err);
    process.exitCode = 1;
  }
}
