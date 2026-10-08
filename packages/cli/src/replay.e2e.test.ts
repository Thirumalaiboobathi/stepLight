import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generatePlaywrightTest, readRun } from "@steplight/core/node";
import { steplight } from "@steplight/sdk";
import { startFixtureSites, type FixtureSites } from "@steplight/fixtures-site";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildProgram } from "./index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let site: FixtureSites;
let browser: Browser;
let runsDir: string;
const reproDir = path.resolve(here, "../.repro");

beforeAll(async () => {
  site = await startFixtureSites();
  browser = await chromium.launch({ headless: true });
  runsDir = await mkdtemp(path.join(os.tmpdir(), "steplight-repro-"));
  await rm(reproDir, { recursive: true, force: true });
  await mkdir(reproDir, { recursive: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await site?.close();
  await rm(runsDir, { recursive: true, force: true });
  await rm(reproDir, { recursive: true, force: true });
});

describe("replay-script", () => {
  it("generates tests from real recordings that pass against the fixtures site", async () => {
    // 1. A hijacked booking (hidden instruction → Premium → checkout → cross-origin submit).
    const page = await browser.newPage();
    const booking = await steplight.record(page, { task: "Book the cheapest flight", dir: runsDir });
    await page.goto(`${site.url}/flights.html`);
    await page.click("#select-premium");
    await page.waitForURL(/checkout\.html/);
    await page.fill("#email", "traveler@example.com");
    await Promise.all([page.waitForURL(/\/collect/), page.click("#pay")]);
    await booking.end("success");
    await page.close();

    // 2. A failing agent: the click on a covered button times out (the bug to reproduce).
    const page2 = await browser.newPage();
    const stuck = await steplight.record(page2, { task: "Place the order", dir: runsDir });
    await page2.goto(`${site.url}/stuck.html`);
    await page2.click("#covered-btn", { timeout: 800 }).catch(() => undefined);
    await stuck.end("failed");
    await page2.close();

    // 3. Generate via the CLI command (for one) and the library (for the other).
    const specBooking = path.join(reproDir, "booking.spec.ts");
    await buildProgram().parseAsync(["node", "steplight", "replay-script", booking.id, "--out", specBooking, "--dir", runsDir]);
    await writeFile(path.join(reproDir, "stuck.spec.ts"), generatePlaywrightTest(await readRun(runsDir, stuck.id)));

    // 4. Run both with Playwright Test against a *fresh* fixtures instance's URL.
    const cli = path.join(path.dirname(require.resolve("@playwright/test/package.json")), "cli.js");
    // Async spawn: the fixtures server lives in this process and must keep serving requests.
    const result = await new Promise<{ status: number | null; output: string }>((resolve) => {
      const child = spawn(process.execPath, [cli, "test", "--reporter=line", "--workers=1", "--timeout=40000"], {
        cwd: reproDir,
        env: { ...process.env, BASE_URL: site.url },
      });
      let output = "";
      child.stdout.on("data", (d) => (output += d));
      child.stderr.on("data", (d) => (output += d));
      child.on("close", (status) => resolve({ status, output }));
    });
    expect(result.output).toMatch(/2 passed/);
    expect(result.status).toBe(0);
  }, 180_000);
});
