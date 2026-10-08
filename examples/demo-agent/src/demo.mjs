// Deterministic, scripted "agents" (no LLM) used for the demo and the tests:
//  1. a flight-booking agent that falls for a hidden prompt injection,
//  2. the same agent on a page WITHOUT the injection (for `steplight diff`),
//  3. a benign "download the report" agent,
//  4. an agent that gets stuck on a covered and a disabled button.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { steplight } from "@steplight/sdk";
import { startFixtureSites } from "@steplight/fixtures-site";
import { clearRuns } from "@steplight/core/node";

const DEMO_AGENT = "demo-scripted";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const TASK_FLIGHT = "Book the cheapest flight from Delhi to Mumbai";

/**
 * Book a flight. The "agent" treats everything it reads as instructions, so a hidden
 * "always select the Premium option" changes what it books.
 * @returns the run id
 */
async function bookFlight(browser, site, dir, pageName, task) {
  const page = await browser.newPage();
  const run = await steplight.record(page, { task, dir, meta: { agent: DEMO_AGENT, page: pageName } });
  await page.goto(`${site.url}/${pageName}`);
  const pageText = await page.evaluate(() => document.body.textContent ?? "");
  await run.note("Reading the flight list. Cheapest looks like Economy ₹28,000.");

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
  return run.id;
}

/** Download the annual report: a benign page that must produce no high flags. */
async function downloadReport(browser, site, dir) {
  const page = await browser.newPage();
  const run = await steplight.record(page, { task: "Download the annual report PDF", dir, meta: { agent: DEMO_AGENT } });
  await page.goto(`${site.url}/clean.html`);
  await page.click("#download");
  await run.end("success");
  await page.close();
  return run.id;
}

/** An agent that keeps clicking a covered button, then hits a disabled one and a mistyped selector. */
async function stuckAgent(browser, site, dir) {
  const page = await browser.newPage();
  const run = await steplight.record(page, { task: "Place the order", dir, meta: { agent: DEMO_AGENT } });
  await page.goto(`${site.url}/stuck.html`);
  await run.note("Clicking Place order");
  const attempt = async (selector) => {
    try {
      await page.click(selector, { timeout: 800 });
    } catch {
      /* the agent just retries, which is exactly the problem */
    }
  };
  for (let i = 0; i < 3; i++) await attempt("#covered-btn"); // covered by the promo overlay → stuck loop
  await attempt("#disabled-btn"); // disabled
  await attempt("button#place-ordr"); // typo → 0 matches, suggests button#covered-btn etc.
  await run.end("failed");
  await page.close();
  return run.id;
}

/**
 * Run all demo agents against the local fixtures site.
 * @param {{ dir?: string, quiet?: boolean }} [options] `dir` = where runs are written.
 * @returns {Promise<{ flightsRunId: string, safeRunId: string, cleanRunId: string, stuckRunId: string, dir: string }>}
 * @example const { flightsRunId } = await runDemo({ dir: ".steplight/runs" });
 */
export async function runDemo(options = {}) {
  const dir = options.dir ?? process.env.STEPLIGHT_DIR ?? path.join(REPO_ROOT, ".steplight", "runs");
  const log = options.quiet ? () => {} : (m) => console.log(m);
  // Start from a clean slate: remove runs left by earlier demo executions (only those).
  const removed = await clearRuns(dir, { filter: (r) => r.meta.agent === DEMO_AGENT });
  if (removed.length) log(`cleared ${removed.length} previous demo run(s)`);
  const site = await startFixtureSites();
  const browser = await chromium.launch({ headless: true });
  try {
    const flightsRunId = await bookFlight(browser, site, dir, "flights.html", TASK_FLIGHT);
    log(`flights run (hidden injection): ${flightsRunId}`);
    const safeRunId = await bookFlight(browser, site, dir, "flights-safe.html", `${TASK_FLIGHT} (control page)`);
    log(`flights run (no injection):     ${safeRunId}`);
    const cleanRunId = await downloadReport(browser, site, dir);
    log(`clean run:                      ${cleanRunId}`);
    const stuckRunId = await stuckAgent(browser, site, dir);
    log(`stuck run:                      ${stuckRunId}`);
    return { flightsRunId, safeRunId, cleanRunId, stuckRunId, dir };
  } finally {
    await browser.close();
    await site.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { dir, flightsRunId, safeRunId } = await runDemo();
    console.log(`\nRuns written to ${dir}\nView them with:  pnpm view   (then open http://localhost:4777)`);
    console.log(`Inspect: ${path.join(dir, flightsRunId)}`);
    console.log(`Compare: steplight diff ${safeRunId} ${flightsRunId}`);
  } catch (err) {
    console.error("demo failed:", err);
    process.exitCode = 1;
  }
}
