import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createViewerServer } from "@steplight/cli";
import { startFixtureSites, type FixtureSites } from "@steplight/fixtures-site";
import { chromium, type BrowserContext } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Run } from "@steplight/core";
import type { Server } from "node:http";

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");

let tmp: string;
let runsDir: string;
let server: Server;
let site: FixtureSites;
let context: BrowserContext;
let portFree = true;

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "steplight-ext-"));
  runsDir = path.join(tmp, "runs");
  server = createViewerServer({ runsDir });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(4777, "127.0.0.1", resolve);
    });
  } catch {
    portFree = false; // a real `steplight view` is running; the extension is hard-wired to 4777
    return;
  }
  site = await startFixtureSites();

  // Test-only copy of the extension that also has install-time host access. The shipped
  // manifest only has *optional* host access, which needs a human click to grant.
  const extDir = path.join(tmp, "ext");
  await cp(dist, extDir, { recursive: true });
  const manifestPath = path.join(extDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.host_permissions.push("<all_urls>");
  await writeFile(manifestPath, JSON.stringify(manifest));

  context = await chromium.launchPersistentContext(path.join(tmp, "profile"), {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
}, 120_000);

afterAll(async () => {
  await context?.close();
  await site?.close();
  if (server?.listening) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

async function api<T>(p: string): Promise<T> {
  const port = (server.address() as AddressInfo).port;
  return (await (await fetch(`http://127.0.0.1:${port}${p}`)).json()) as T;
}

describe("Chrome extension in a real browser", () => {
  it("loads, records a hijacked booking and posts flagged steps to the local server", async (ctx) => {
    if (!portFree) return ctx.skip();
    const [worker] = context.serviceWorkers().length
      ? context.serviceWorkers()
      : [await context.waitForEvent("serviceworker", { timeout: 20_000 })];
    const extId = new URL(worker!.url()).host;

    // Drive the popup page's messaging exactly as the popup would (minus the permission prompt).
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    const started = await popup.evaluate(
      () => chrome.runtime.sendMessage({ type: "start", task: "Extension: book a flight" }),
    );
    expect(started).toMatchObject({ recording: true });

    const page = await context.newPage();
    await page.goto(`${site.url}/flights.html`);
    await page.click("#select-premium");
    await page.waitForURL(/checkout\.html/);
    await page.fill("#email", "traveler@example.com");
    await Promise.all([page.waitForURL(/\/collect/), page.click("#pay")]);

    await expect
      .poll(async () => (await api<{ id: string; stepCount: number }[]>("/api/runs"))[0]?.stepCount ?? 0, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(6);

    const stopped = await popup.evaluate(() => chrome.runtime.sendMessage({ type: "stop" }));
    expect(stopped).toMatchObject({ recording: false });

    const [summary] = await api<{ id: string; status: string }[]>("/api/runs");
    const run = await api<Run>(`/api/runs/${summary!.id}`);
    expect(run.task).toBe("Extension: book a flight");
    expect(run.meta["source"]).toBe("chrome-extension");

    const read = run.steps.find((s) => s.kind === "page_read" && s.url?.includes("flights.html"))!;
    expect(read.flags.find((f) => f.type === "hidden_instruction")?.severity).toBe("high");
    const click = run.steps.find((s) => s.kind === "click" && /premium/i.test(s.targetText ?? ""))!;
    expect(click.causedBy).toBe(read.id);
    const submit = run.steps.find((s) => s.kind === "form_submit")!;
    expect(submit.flags.map((f) => f.severity)).toContain("critical");

    const raw = await readFile(path.join(runsDir, run.id, "steps.jsonl"), "utf8");
    expect(raw).not.toContain("traveler@example.com");
  }, 90_000);
});
