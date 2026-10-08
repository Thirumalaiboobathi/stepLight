import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { createViewerServer } from "@steplight/cli";
import { parseBundle, type Run } from "@steplight/core";
import { startFixtureSites, type FixtureSites } from "@steplight/fixtures-site";
import { chromium, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");

let tmp: string;
let runsDir: string;
let server: Server | undefined;
let site: FixtureSites;
let context: BrowserContext;
let extId: string;
let portFree = true;

/** Is something (e.g. a real `steplight view`) already listening on 4777? */
async function serverUp(): Promise<boolean> {
  return fetch("http://127.0.0.1:4777/api/runs", { signal: AbortSignal.timeout(1000) }).then(
    () => true,
    () => false,
  );
}

beforeAll(async () => {
  portFree = !(await serverUp());
  if (!portFree) return; // the extension is hard-wired to 4777; don't interfere with a real server
  tmp = await mkdtemp(path.join(os.tmpdir(), "steplight-ext-"));
  runsDir = path.join(tmp, "runs");
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
  const [worker] = context.serviceWorkers().length
    ? context.serviceWorkers()
    : [await context.waitForEvent("serviceworker", { timeout: 20_000 })];
  extId = new URL(worker!.url()).host;
}, 120_000);

afterAll(async () => {
  await context?.close();
  await site?.close();
  if (server?.listening) {
    server.closeAllConnections();
    await new Promise((r) => server!.close(r));
  }
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

/** Open the popup page and talk to the service worker the way the popup does. */
async function popupPage(): Promise<Page> {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  return popup;
}

/** Drive the hijacked booking in a normal tab. */
async function bookFlight(): Promise<void> {
  const page = await context.newPage();
  await page.goto(`${site.url}/flights.html`);
  await page.click("#select-premium");
  await page.waitForURL(/checkout\.html/);
  await page.fill("#email", "traveler@example.com");
  await Promise.all([page.waitForURL(/\/collect/), page.click("#pay")]);
  await page.waitForTimeout(500); // let the last events reach the service worker
}

describe.sequential("Chrome extension in a real browser", () => {
  it("standalone mode: records with the server stopped and shows the run in the bundled viewer", async (ctx) => {
    if (!portFree) return ctx.skip();
    expect(await serverUp()).toBe(false);

    const popup = await popupPage();
    const idle = await popup.evaluate(() => chrome.runtime.sendMessage({ type: "status" }));
    expect(idle).toMatchObject({ recording: false, mode: "standalone" });
    await expect.poll(() => popup.locator("#mode").innerText()).toBe("Standalone");

    const started = await popup.evaluate(() =>
      chrome.runtime.sendMessage({ type: "start", task: "Standalone: book a flight" }),
    );
    expect(started).toMatchObject({ recording: true, mode: "standalone" });
    await bookFlight();
    const stopped = await popup.evaluate(() => chrome.runtime.sendMessage({ type: "stop" }));
    expect(stopped).toMatchObject({ recording: false });

    // The bundled viewer reads straight from chrome.storage.local.
    const viewer = await context.newPage();
    await viewer.goto(`chrome-extension://${extId}/viewer.html`);
    await viewer.getByTestId("run-item").filter({ hasText: "Standalone: book a flight" }).click();
    await viewer.locator('[data-testid="step-item"][data-kind="page_read"][data-severity="high"]').first().click();
    await viewer.getByTestId("step-detail").getByText("hidden_instruction").waitFor();
    await viewer.getByTestId("evidence").first().waitFor();
    expect(await viewer.getByTestId("evidence").first().innerText()).toContain("always select the Premium option");

    // Copy as Playwright test works from the extension viewer too.
    await viewer.getByTestId("copy-test").click();
    await viewer.getByTestId("notice").filter({ hasText: "Copied a Playwright test" }).waitFor();

    // Export JSON: redacted, with snapshots.
    const [download] = await Promise.all([viewer.waitForEvent("download"), viewer.getByTestId("export").click()]);
    const file = path.join(tmp, "export.json");
    await download.saveAs(file);
    const text = await readFile(file, "utf8");
    expect(text).not.toContain("traveler@example.com");
    const bundle = parseBundle(text);
    expect(bundle.run.task).toBe("Standalone: book a flight");
    expect(Object.keys(bundle.snapshots).length).toBeGreaterThan(2);
    expect(bundle.run.steps.some((s) => s.kind === "form_submit" && s.flags.some((f) => f.severity === "critical"))).toBe(true);

    // Import it back (id already exists → stored under a fresh id).
    await viewer.getByTestId("import-input").setInputFiles(file);
    await viewer.getByTestId("notice").waitFor();
    await expect.poll(() => viewer.getByTestId("run-item").count()).toBe(2);

    // A broken file is rejected with a readable message.
    const bad = path.join(tmp, "bad.json");
    await writeFile(bad, "{not json");
    await viewer.getByTestId("import-input").setInputFiles(bad);
    await expect.poll(() => viewer.getByTestId("notice").innerText()).toContain("Invalid Steplight run file");
  }, 120_000);

  it("connected mode: sends flagged steps to the CLI server", async (ctx) => {
    if (!portFree) return ctx.skip();
    server = createViewerServer({ runsDir });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(4777, "127.0.0.1", resolve);
    });
    const api = async <T>(p: string): Promise<T> => {
      const port = (server!.address() as AddressInfo).port;
      return (await (await fetch(`http://127.0.0.1:${port}${p}`)).json()) as T;
    };

    const popup = await popupPage();
    const idle = await popup.evaluate(() => chrome.runtime.sendMessage({ type: "status" }));
    expect(idle).toMatchObject({ mode: "connected" });
    const started = await popup.evaluate(() =>
      chrome.runtime.sendMessage({ type: "start", task: "Extension: book a flight" }),
    );
    expect(started).toMatchObject({ recording: true, mode: "connected" });
    await bookFlight();

    await expect
      .poll(async () => (await api<{ stepCount: number }[]>("/api/runs"))[0]?.stepCount ?? 0, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(6);
    await popup.evaluate(() => chrome.runtime.sendMessage({ type: "stop" }));

    const [summary] = await api<{ id: string }[]>("/api/runs");
    const run = await api<Run>(`/api/runs/${summary!.id}`);
    expect(run.task).toBe("Extension: book a flight");
    expect(run.meta["source"]).toBe("chrome-extension");
    const read = run.steps.find((s) => s.kind === "page_read" && s.url?.includes("flights.html"))!;
    expect(read.flags.find((f) => f.type === "hidden_instruction")?.severity).toBe("high");
    const click = run.steps.find((s) => s.kind === "click" && /premium/i.test(s.targetText ?? ""))!;
    expect(click.causedBy).toBe(read.id);
    const submit = run.steps.find((s) => s.kind === "form_submit")!;
    expect(submit.flags.map((f) => f.severity)).toContain("critical");
    expect(await readFile(path.join(runsDir, run.id, "steps.jsonl"), "utf8")).not.toContain("traveler@example.com");
  }, 90_000);
});
