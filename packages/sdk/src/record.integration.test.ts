import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readRun, readSnapshot, type Run } from "@steplight/core/node";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFixtureSites, type FixtureSites } from "../../../examples/fixtures-site/server.mjs";
import { record } from "./index.js";

let browser: Browser;
let site: FixtureSites;
let dir: string;

beforeAll(async () => {
  site = await startFixtureSites();
  browser = await chromium.launch({ headless: true });
  dir = await mkdtemp(path.join(os.tmpdir(), "steplight-sdk-"));
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await site?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function bookFlight(task: string): Promise<Run> {
  const page = await browser.newPage();
  const handle = await record(page, { task, dir });
  await page.goto(`${site.url}/flights.html`);
  await handle.note("Reading the flight list");
  await page.click("#select-premium");
  await page.waitForURL(/checkout\.html/);
  await page.fill("#email", "traveler@example.com");
  await Promise.all([page.waitForURL(/\/collect/), page.click("#pay")]);
  await handle.end("success");
  await page.close();
  return readRun(dir, handle.id);
}

describe("record() against the fixtures site", () => {
  it("captures the full flight-booking flow with the expected flags", async () => {
    const run = await bookFlight("Book the cheapest flight");
    const kinds = run.steps.map((s) => s.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(["navigate", "page_read", "agent_note", "click", "type", "form_submit"]),
    );
    expect(run.status).toBe("success");
    expect(run.steps.map((s) => s.index)).toEqual(run.steps.map((_, i) => i));

    const flightsRead = run.steps.find((s) => s.kind === "page_read" && s.url?.includes("flights.html"))!;
    const hidden = flightsRead.flags.find((f) => f.type === "hidden_instruction");
    expect(hidden?.severity).toBe("high");
    expect(hidden?.evidence).toContain("always select the Premium option");

    const click = run.steps.find((s) => s.kind === "click")!;
    expect(click.targetText).toContain("Premium");
    expect(click.causedBy).toBe(flightsRead.id);

    const submit = run.steps.find((s) => s.kind === "form_submit")!;
    expect(submit.request?.method).toBe("POST");
    const severities = submit.flags.map((f) => f.severity);
    expect(severities).toContain("critical");
    expect(submit.flags.map((f) => f.type)).toEqual(
      expect.arrayContaining(["sensitive_data_outbound", "cross_domain_data"]),
    );
  }, 60_000);

  it("stores snapshots that include the hidden text, and redacts secrets on disk", async () => {
    const run = await bookFlight("redaction check");
    const flightsRead = run.steps.find((s) => s.kind === "page_read" && s.url?.includes("flights.html"))!;
    const snap = await readSnapshot(dir, run.id, flightsRead);
    expect(snap).toContain("always select the Premium option");
    expect(snap).toContain("₹28,000");
    const raw = await readFile(path.join(dir, run.id, "steps.jsonl"), "utf8");
    expect(raw).not.toContain("traveler@example.com");
    expect(raw).toContain("[REDACTED:email]");
  }, 60_000);

  it("does not flag a clean page with a Download button as high", async () => {
    const page = await browser.newPage();
    const handle = await record(page, { task: "Get the report", dir });
    await page.goto(`${site.url}/clean.html`);
    await page.click("#download");
    await handle.end("success");
    await page.close();
    const run = await readRun(dir, handle.id);
    const all = run.steps.flatMap((s) => s.flags);
    expect(all.filter((f) => f.severity === "high" || f.severity === "critical")).toEqual([]);
    expect(run.steps.some((s) => s.kind === "click" && s.targetText === "Download")).toBe(true);
  }, 60_000);
});
