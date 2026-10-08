import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createViewerServer, type ViewerServer } from "@steplight/cli";
import { verifyAuditLog, type AuditEntry, type Run, type Settings, type Step } from "@steplight/core";
import { startRedteamServer, type RedteamServer } from "@steplight/redteam";
import { chromium, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/*
 * Network capture (fetch / XHR / beacon / pixel / WebSocket) and SPA routes, in a real Chromium
 * with the built extension loaded. Needs port 4777 (the extension talks to the CLI there).
 */

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");

let tmp: string;
let runsDir: string;
let server: ViewerServer | undefined;
let context: BrowserContext;
let extId: string;
let portFree = true;
let analytics: Server;
let analyticsPort = 0;
let redteam: RedteamServer;

async function serverUp(): Promise<boolean> {
  return fetch("http://127.0.0.1:4777/api/runs", { signal: AbortSignal.timeout(1000) }).then(
    () => true,
    () => false,
  );
}

beforeAll(async () => {
  portFree = !(await serverUp());
  if (!portFree) return;
  tmp = await mkdtemp(path.join(os.tmpdir(), "steplight-net-"));
  runsDir = path.join(tmp, "runs");
  redteam = await startRedteamServer();

  // A normal shop page that talks to an analytics provider. The provider's hostname is mapped to
  // this same local server (see --host-resolver-rules), so no real network is involved.
  analytics = createServer((req, res) => {
    if ((req.headers.host ?? "").startsWith("www.google-analytics.com")) {
      res.writeHead(204);
      return void res.end();
    }
    if (req.url?.startsWith("/pay")) {
      res.writeHead(200, { "content-type": "text/html" });
      return void res.end(`<!doctype html><title>Pay</title><h1>Checkout</h1><p>Total 1,499. Ref LAMPCODE-12345.</p>
<form id="f" method="POST" action="/api/pay?session=abc123tok">
  <input name="email" value="traveler@example.com">
  <input type="password" name="pw" value="hunter2xyz">
  <input name="card_number" value="4242 4242 4242 4242">
  <input autocomplete="one-time-code" name="sms" value="654321">
  <input name="note" value="plain note">
  <textarea name="cardnote">SECRET-CARD-NOTE</textarea>
  <button id="go" type="submit">Pay</button>
</form>
<div contenteditable aria-label="CVV" id="cvv">SECRET-CVV-TEXT</div>`);
    }
    if (req.url?.startsWith("/api/")) {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end('{"items":0}');
    }
    const ga = `http://www.google-analytics.com:${analyticsPort}`;
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><title>Acme shop</title><h1>Acme shop</h1><p>Desk lamp, free delivery over 999.</p>
<script>
fetch("${ga}/g/collect?v=2&tid=G-TEST&dl=" + encodeURIComponent(location.href) + "&dt=" + encodeURIComponent(document.title), { mode: "no-cors" });
navigator.sendBeacon("${ga}/g/collect?v=2&en=scroll");
new Image().src = "${ga}/collect?v=1&t=pageview";
fetch("/api/cart");
</script>`);
  });
  await new Promise<void>((r) => analytics.listen(0, "127.0.0.1", r));
  analyticsPort = (analytics.address() as AddressInfo).port;

  // Test-only copy of the extension with install-time host access (the shipped manifest only has
  // *optional* host access, which needs a human click).
  const extDir = path.join(tmp, "ext");
  await cp(dist, extDir, { recursive: true });
  const manifestPath = path.join(extDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.host_permissions.push("<all_urls>");
  await writeFile(manifestPath, JSON.stringify(manifest));

  context = await chromium.launchPersistentContext(path.join(tmp, "profile"), {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
      "--host-resolver-rules=MAP www.google-analytics.com 127.0.0.1",
    ],
  });
  const [worker] = context.serviceWorkers().length
    ? context.serviceWorkers()
    : [await context.waitForEvent("serviceworker", { timeout: 20_000 })];
  extId = new URL(worker!.url()).host;

  server = createViewerServer({ runsDir });
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(4777, "127.0.0.1", resolve);
  });
}, 120_000);

afterAll(async () => {
  await context?.close();
  await redteam?.close();
  analytics?.closeAllConnections();
  analytics?.close();
  if (server?.listening) {
    server.closeAllConnections();
    await new Promise((r) => server!.close(r));
  }
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

async function api<T>(p: string): Promise<T> {
  const res = await fetch(`http://127.0.0.1:4777${p}`, { headers: { authorization: `Bearer ${server!.token}` } });
  return (await res.json()) as T;
}

async function popupPage(): Promise<Page> {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  return popup;
}

let recordings = 0;

/** Record `url` in a fresh active tab and return the stored run. */
async function record(
  url: string,
  drive: (page: Page) => Promise<void> = async () => undefined,
  settings: Partial<Settings> = {},
): Promise<Run> {
  const popup = await popupPage();
  await popup.evaluate((st) => chrome.storage.local.set({ "sl-settings": st }), settings);
  const paired = await popup.evaluate(
    (t) => chrome.runtime.sendMessage({ type: "pair", link: `http://127.0.0.1:4777/#token=${t}` }),
    server!.token,
  );
  expect(paired, "pairing").toMatchObject({ paired: true });

  const page = await context.newPage();
  await page.goto("about:blank");
  await page.bringToFront();
  const task = `rec-${++recordings}`; // not the URL: task titles are redacted too
  const started = await popup.evaluate((t) => chrome.runtime.sendMessage({ type: "start", task: t }), task);
  expect(started).toMatchObject({ recording: true, mode: "connected" });
  await page.goto(url);
  await page.waitForTimeout(1600); // scripts, the delayed re-scan, an automatic SPA route
  await drive(page);
  await page.waitForTimeout(900);
  await popup.evaluate(() => chrome.runtime.sendMessage({ type: "stop" }));
  await page.close();
  await popup.close();
  let run: Run | undefined;
  await expect
    .poll(
      async () => {
        const list = await api<{ id: string; task: string; status: string }[]>("/api/runs");
        const found = list.find((r) => r.task === task && r.status === "success");
        run = found ? await api<Run>(`/api/runs/${found.id}`) : undefined;
        return Boolean(run);
      },
      { timeout: 10_000 },
    )
    .toBe(true);
  return run!;
}

const netSteps = (run: Run, marker: string): Step[] =>
  run.steps.filter((s) => s.kind === "network_request" && s.request?.url.includes(marker));
const sev = (steps: Step[]): string[] => steps.flatMap((x) => x.flags.map((f) => `${f.type}:${f.severity}`));
const typeEmail = async (page: Page): Promise<void> => {
  await page.fill("#alert", "traveler@example.com");
  await page.click("#notify");
};
async function noEmailOnDisk(): Promise<void> {
  for (const id of await readdir(runsDir)) {
    expect(await readFile(path.join(runsDir, id, "steps.jsonl"), "utf8"), id).not.toContain("traveler@example.com");
  }
}

describe.sequential("network capture and SPA routes in a real browser", () => {
  it("fetch() exfiltration: critical flag from the body; the body is not stored at the standard level", async (ctx) => {
    if (!portFree) return ctx.skip();
    const run = await record(`${redteam.url}/attacks/fetch-exfil.html`, typeEmail);
    const read = run.steps.find((s) => s.kind === "page_read" && s.url?.includes("fetch-exfil"));
    expect(read?.flags.some((f) => f.type === "hidden_instruction" && f.severity === "high")).toBe(true);
    const sent = netSteps(run, "/collect/fetch-exfil");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.request).toMatchObject({ method: "POST", resourceType: "xmlhttprequest", source: "webRequest" });
    expect(sent[0]!.request?.bodyPreview).toBeUndefined();
    expect(sent[0]!.request?.bodyBytes).toBeGreaterThan(10);
    expect(sev(sent)).toContain("sensitive_data_outbound:critical");
    expect(JSON.stringify(sent[0]!.flags)).not.toContain("traveler@example.com");
    await noEmailOnDisk();
  }, 90_000);

  it("sendBeacon exfiltration: the page-view beacon right after the hidden instruction is high, the email critical", async (ctx) => {
    if (!portFree) return ctx.skip();
    const run = await record(`${redteam.url}/attacks/beacon-exfil.html`, typeEmail);
    const passive = netSteps(run, "/telemetry/beacon-exfil");
    expect(passive[0]?.request?.resourceType).toBe("ping");
    expect(sev(passive)).toContain("cross_domain_data:high");
    expect(sev(netSteps(run, "/collect/beacon-exfil"))).toContain("sensitive_data_outbound:critical");
    await noEmailOnDisk();
  }, 90_000);

  it("image-pixel exfiltration: the email in the query string is critical (a plain GET)", async (ctx) => {
    if (!portFree) return ctx.skip();
    const run = await record(`${redteam.url}/attacks/pixel-exfil.html`, typeEmail);
    const px = netSteps(run, "/collect/pixel-exfil");
    expect(px[0]?.request).toMatchObject({ method: "GET", resourceType: "image" });
    expect(sev(px)).toContain("sensitive_data_outbound:critical");
    expect(sev(netSteps(run, "/telemetry/pixel-exfil"))).toContain("cross_domain_data:high");
    expect(px[0]!.request!.url).not.toContain("traveler"); // stored URL is redacted
    await noEmailOnDisk();
  }, 90_000);

  it("WebSocket exfiltration: the connection to a new domain is flagged; deep capture adds the payload", async (ctx) => {
    if (!portFree) return ctx.skip();
    const plain = await record(`${redteam.url}/attacks/websocket-exfil.html`, typeEmail);
    expect(netSteps(plain, "/telemetry/websocket-exfil")[0]?.request?.resourceType).toBe("websocket");
    expect(sev(netSteps(plain, "/telemetry/websocket-exfil"))).toContain("cross_domain_data:high");
    expect(netSteps(plain, "/collect/websocket-exfil").length).toBeGreaterThan(0);

    const deep = await record(`${redteam.url}/attacks/websocket-exfil.html`, typeEmail, { deepCapture: true });
    const frames = deep.steps.filter((s) => s.request?.method === "SEND" && s.request.url.includes("/collect/websocket-exfil"));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.request?.source).toBe("deep");
    expect(sev(frames)).toContain("sensitive_data_outbound:critical");
    await noEmailOnDisk();
  }, 120_000);

  it("deep capture sees fetch payloads before encoding, is off by default and does not double-record", async (ctx) => {
    if (!portFree) return ctx.skip();
    const off = await record(`${redteam.url}/attacks/fetch-exfil.html`, typeEmail);
    expect(off.steps.some((s) => s.request?.source === "deep")).toBe(false);
    const on = await record(`${redteam.url}/attacks/fetch-exfil.html`, typeEmail, { deepCapture: true, captureLevel: "full" });
    const deepStep = on.steps.find((s) => s.request?.source === "deep" && s.request.url.includes("/collect/fetch-exfil"));
    expect(deepStep, "deep step").toBeDefined();
    expect(deepStep!.request?.bodyPreview).toContain("[REDACTED:email]"); // full level keeps a redacted preview
    expect(sev([deepStep!])).toContain("sensitive_data_outbound:critical");
    expect(netSteps(on, "/collect/fetch-exfil")).toHaveLength(1);
    await noEmailOnDisk();
  }, 120_000);

  it("the deep-capture hook leaves the page's functions native-looking and working", async (ctx) => {
    if (!portFree) return ctx.skip();
    let seen: Record<string, unknown> | undefined;
    await record(
      `http://127.0.0.1:${analyticsPort}/`,
      async (page) => {
        seen = await page.evaluate(async () => {
          const ws = new WebSocket("ws://127.0.0.1:9/never");
          ws.onerror = () => undefined;
          const res = await fetch("/api/cart");
          return {
            fetchName: fetch.name,
            fetchLength: fetch.length,
            fetchSrc: Function.prototype.toString.call(fetch),
            beaconSrc: Function.prototype.toString.call(navigator.sendBeacon),
            xhrSrc: Function.prototype.toString.call(XMLHttpRequest.prototype.send),
            wsName: WebSocket.name,
            wsInstance: ws instanceof WebSocket,
            wsConstants: WebSocket.OPEN,
            fetchStillWorks: res.ok && (await res.json()).items === 0,
            beaconStillWorks: navigator.sendBeacon("/api/cart", "x") === true,
          };
        });
      },
      { deepCapture: true },
    );
    expect(seen).toMatchObject({
      fetchName: "fetch",
      fetchLength: 1,
      wsName: "WebSocket",
      wsInstance: true,
      wsConstants: 1,
      fetchStillWorks: true,
      beaconStillWorks: true,
    });
    for (const k of ["fetchSrc", "beaconSrc", "xhrSrc"]) expect(String(seen![k]), k).toContain("[native code]");
  }, 90_000);

  it("SPA route change: a navigate step is recorded and the hidden text injected afterwards is flagged", async (ctx) => {
    if (!portFree) return ctx.skip();
    const run = await record(`${redteam.url}/attacks/spa-route.html?manual=1`, async (page) => {
      await page.click("#reviews"); // pushState to ?view=reviews, then the instruction appears
      await page.waitForTimeout(1500);
    });
    const spaNav = run.steps.find((s) => s.kind === "navigate" && s.url?.includes("view=reviews"));
    expect(spaNav, "navigate step for the pushState route").toBeDefined();
    expect(spaNav!.targetText).toBe("client-side route change");
    const after = run.steps.filter((s) => s.index > spaNav!.index && s.kind === "page_read");
    expect(after.some((s) => s.flags.some((f) => f.type === "hidden_instruction" && f.severity === "high"))).toBe(true);
    const before = run.steps.filter((s) => s.index < spaNav!.index && s.kind === "page_read");
    expect(before.every((s) => !s.flags.some((f) => f.type === "hidden_instruction"))).toBe(true);
  }, 90_000);

  it("a normal site with analytics produces no high or critical flags", async (ctx) => {
    if (!portFree) return ctx.skip();
    const run = await record(`http://127.0.0.1:${analyticsPort}/`);
    const net = run.steps.filter((s) => s.kind === "network_request");
    expect(net.some((s) => s.request?.url.includes("google-analytics.com"))).toBe(true);
    expect(net.some((s) => s.request?.url.includes("/api/cart"))).toBe(true);
    const worst = run.steps.flatMap((s) => s.flags).filter((f) => f.severity === "high" || f.severity === "critical");
    expect(worst).toEqual([]);
  }, 90_000);
});


/* ------------------------------------------------------------------------------------------ */
/* Privacy controls                                                                            */
/* ------------------------------------------------------------------------------------------ */

describe.sequential("privacy controls in a real browser", () => {
  const PAY = (): string => `http://127.0.0.1:${analyticsPort}/pay?token=abcdef123456`;
  const SECRETS = ["hunter2xyz", "4242 4242 4242 4242", "4242%204242", "654321", "SECRET-CARD-NOTE", "SECRET-CVV-TEXT", "traveler@example.com", "abc123tok", "abcdef123456"];

  async function everythingOnDisk(runId?: string): Promise<string> {
    let all = "";
    const walk = async (d: string): Promise<void> => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) await walk(full);
        else all += `${await readFile(full, "utf8")}\n`;
      }
    };
    await walk(runId ? path.join(runsDir, runId) : runsDir);
    return all;
  }

  const submitForm = async (page: Page): Promise<void> => {
    await Promise.all([page.waitForURL(/api\/pay/), page.click("#go")]);
  };

  it("password, card, one-time-code and CVV fields never reach storage, at any capture level", async (ctx) => {
    if (!portFree) return ctx.skip();
    for (const captureLevel of ["minimal", "standard", "full"] as const) {
      const run = await record(PAY(), submitForm, { captureLevel });
      expect(run.steps.length, captureLevel).toBeGreaterThan(2);
      const disk = await everythingOnDisk();
      for (const secret of SECRETS) expect(disk, `${captureLevel}: ${secret}`).not.toContain(secret);
    }
  }, 180_000);

  it("full level keeps the body of ordinary fields (redacted); standard keeps none", async (ctx) => {
    if (!portFree) return ctx.skip();
    const full = await record(PAY(), submitForm, { captureLevel: "full" });
    const submit = full.steps.find((s) => s.kind === "form_submit")!;
    expect(submit.request?.bodyPreview).toContain("note=plain note");
    expect(submit.request?.bodyPreview).toContain("email=[REDACTED:email]");
    expect(submit.request?.bodyPreview).not.toMatch(/pw=|card_number|sms=|cardnote/);
    // The raw body was analysed even though it is not stored: an email going back to the page's own site is "low".
    expect(submit.flags.map((f) => `${f.type}:${f.severity}`)).toContain("sensitive_data_outbound:low");
    const standard = await record(PAY(), submitForm, { captureLevel: "standard" });
    expect(standard.steps.find((s) => s.kind === "form_submit")?.request?.bodyPreview).toBeUndefined();
  }, 120_000);

  it("minimal level stores no page text and no query strings", async (ctx) => {
    if (!portFree) return ctx.skip();
    const run = await record(PAY(), submitForm, { captureLevel: "minimal" });
    expect(run.steps.every((s) => !s.snapshotRef)).toBe(true);
    for (const s of run.steps) {
      expect(s.url ?? "", s.kind).not.toContain("?");
      expect(s.targetText, s.kind).toBeUndefined();
    }
    const disk = await everythingOnDisk(run.id);
    expect(disk).not.toContain("Checkout");
    expect(disk).not.toContain("LAMPCODE");
  }, 60_000);

  it("standard level stores redacted page text and the user's custom patterns apply", async (ctx) => {
    if (!portFree) return ctx.skip();
    const run = await record(PAY(), undefined, { customPatterns: ["LAMPCODE-\\d+", "(a+)+$"] }); // the second is rejected as unsafe
    const read = run.steps.find((s) => s.kind === "page_read")!;
    const snap = await (await fetch(`http://127.0.0.1:4777/api/runs/${run.id}/snapshot/${read.id}`, { headers: { authorization: `Bearer ${server!.token}` } })).text();
    expect(snap).toContain("Checkout");
    expect(snap).toContain("[REDACTED:custom]");
    expect(snap).not.toContain("LAMPCODE-12345");
  }, 60_000);

  it("denied sites are never recorded and say so", async (ctx) => {
    if (!portFree) return ctx.skip();
    const popup = await popupPage();
    await popup.evaluate((st) => chrome.storage.local.set({ "sl-settings": st }), { siteDenylist: ["127.0.0.1"] });
    const page = await context.newPage();
    await page.goto(PAY());
    await page.bringToFront();
    const status = await popup.evaluate(() => chrome.runtime.sendMessage({ type: "status" }));
    expect(status).toMatchObject({ paused: expect.stringContaining("deny list") });
    await popup.close();
    await page.close();
    const run = await record(PAY(), submitForm, { siteDenylist: ["127.0.0.1"] });
    expect(run.steps.map((s) => `${s.kind} ${s.url ?? ""} ${s.request?.url ?? ""}`)).toEqual([]); // not a single navigate, read, click or request
    expect(await everythingOnDisk(run.id)).not.toContain("Checkout");
  }, 90_000);

  it("shows a recording badge on the toolbar icon and a pill on the page, and removes both on stop", async (ctx) => {
    if (!portFree) return ctx.skip();
    const [worker] = context.serviceWorkers();
    const popup = await popupPage();
    await popup.evaluate((st) => chrome.storage.local.set({ "sl-settings": st }), { pageIndicator: true });
    await popup.evaluate((t) => chrome.runtime.sendMessage({ type: "pair", link: `http://127.0.0.1:4777/#token=${t}` }), server!.token);
    const page = await context.newPage();
    await page.goto("about:blank");
    await page.bringToFront();
    await popup.evaluate(() => chrome.runtime.sendMessage({ type: "start", task: "badge test" }));
    await page.goto(`http://127.0.0.1:${analyticsPort}/`);
    await expect.poll(() => worker!.evaluate(() => chrome.action.getBadgeText({}))).toBe("REC");
    await expect.poll(() => page.locator("[data-steplight-indicator]").count()).toBe(1);
    // the pill is in a closed shadow root: it is not part of the page text an agent reads
    expect(await page.evaluate(() => document.body.innerText)).not.toContain("Steplight is recording");
    await popup.evaluate(() => chrome.runtime.sendMessage({ type: "stop" }));
    await expect.poll(() => worker!.evaluate(() => chrome.action.getBadgeText({}))).toBe("");
    await expect.poll(() => page.locator("[data-steplight-indicator]").count()).toBe(0);
    await page.close();
    await popup.close();
  }, 90_000);

  it("the indicator can be turned off", async (ctx) => {
    if (!portFree) return ctx.skip();
    const popup = await popupPage();
    await popup.evaluate((st) => chrome.storage.local.set({ "sl-settings": st }), { pageIndicator: false });
    await popup.evaluate((t) => chrome.runtime.sendMessage({ type: "pair", link: `http://127.0.0.1:4777/#token=${t}` }), server!.token);
    const page = await context.newPage();
    await page.goto("about:blank");
    await page.bringToFront();
    await popup.evaluate(() => chrome.runtime.sendMessage({ type: "start", task: "no pill" }));
    await page.goto(`http://127.0.0.1:${analyticsPort}/`);
    await page.waitForTimeout(1200);
    expect(await page.locator("[data-steplight-indicator]").count()).toBe(0);
    await popup.evaluate(() => chrome.runtime.sendMessage({ type: "stop" }));
    await page.close();
    await popup.close();
  }, 60_000);

  it("retention deletes expired runs (and their snapshots) from extension storage; delete-all removes everything", async (ctx) => {
    if (!portFree) return ctx.skip();
    const popup = await popupPage();
    await popup.evaluate((st) => chrome.storage.local.set({ "sl-settings": st }), { retentionDays: 7 });
    await popup.evaluate(() => chrome.runtime.sendMessage({ type: "unpair" })); // no token -> standalone mode
    const recordStandalone = async (task: string): Promise<void> => {
      const page = await context.newPage();
      await page.goto("about:blank");
      await page.bringToFront();
      const started = await popup.evaluate((t) => chrome.runtime.sendMessage({ type: "start", task: t }), task);
      expect(started).toMatchObject({ recording: true, mode: "standalone" });
      await page.goto(`http://127.0.0.1:${analyticsPort}/pay`);
      await page.waitForTimeout(1200);
      await popup.evaluate(() => chrome.runtime.sendMessage({ type: "stop" }));
      await page.close();
    };
    const dump = (): Promise<Record<string, unknown>> => popup.evaluate(() => chrome.storage.local.get(null));
    const metaIds = async (): Promise<string[]> => keys(await dump()).filter((k) => k.startsWith("sl:meta:")).map((k) => k.slice("sl:meta:".length));
    const keys = (all: Record<string, unknown>): string[] => Object.keys(all).filter((k) => k.startsWith("sl:"));
    await recordStandalone("old run");
    const [oldId] = await metaIds();
    expect(oldId).toBeDefined();
    // Move the service worker's clock forward 10 days, then record again: the first run is now expired.
    const [worker] = context.serviceWorkers();
    await worker!.evaluate(() => {
      const real = Date.now.bind(Date);
      (globalThis as unknown as { __realNow: () => number }).__realNow = real;
      Date.now = () => real() + 10 * 86_400_000;
    });
    await recordStandalone("new run");
    await popup.evaluate(() => chrome.runtime.sendMessage({ type: "status" })); // opening the popup enforces retention
    await expect.poll(async () => (await metaIds()).length).toBe(1);
    const left = await metaIds();
    expect(left).not.toContain(oldId);
    expect(keys(await dump()).some((k) => k.includes(oldId!))).toBe(false); // meta, steps and snapshots all gone
    await worker!.evaluate(() => {
      Date.now = (globalThis as unknown as { __realNow: () => number }).__realNow;
    });

    // "Delete all Steplight data"
    await popup.evaluate(() => chrome.runtime.sendMessage({ type: "delete_all" }));
    expect(keys(await dump())).toEqual([]);
    expect(JSON.stringify(await dump())).not.toContain("Checkout");
    await popup.close();
  }, 120_000);

  it("the settings page loads, validates patterns and saves", async (ctx) => {
    if (!portFree) return ctx.skip();
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extId}/settings.html`);
    await page.locator('input[name="level"][value="minimal"]').check();
    await page.locator("#deny").fill("mybank.com\n*.hospital.org\nnot a domain");
    await page.locator("#patterns").fill("EMP-\\d{6}\n(a+)+$");
    await page.click("#save");
    await expect.poll(() => page.locator("#saved").innerText()).toContain("Not saved");
    expect(await page.locator("#patternErrors li").count()).toBe(1);
    await page.locator("#patterns").fill("EMP-\\d{6}");
    await page.click("#save");
    await expect.poll(() => page.locator("#saved").innerText()).toContain("Saved");
    const saved = await page.evaluate(() => chrome.storage.local.get("sl-settings"));
    expect(saved["sl-settings"]).toMatchObject({ captureLevel: "minimal", siteDenylist: ["mybank.com", "*.hospital.org"], customPatterns: ["EMP-\\d{6}"], firstRunDone: true });
    await page.reload();
    expect(await page.locator('input[name="level"][value="minimal"]').isChecked()).toBe(true);
    await page.locator("#firstRun").waitFor({ state: "hidden" });
    await page.close();
  }, 60_000);

  it("encrypts runs at rest: raw extension storage holds no plaintext, the key cannot be exported, the viewer still reads them", async (ctx) => {
    if (!portFree) return ctx.skip();
    const popup = await popupPage();
    await popup.evaluate((st) => chrome.storage.local.set({ "sl-settings": st }), { captureLevel: "standard", retentionDays: 7 });
    await popup.evaluate(() => chrome.runtime.sendMessage({ type: "unpair" }));
    const page = await context.newPage();
    await page.goto("about:blank");
    await page.bringToFront();
    await popup.evaluate(() => chrome.runtime.sendMessage({ type: "start", task: "ENCRYPTED-TASK-TITLE" }));
    await page.goto(`http://127.0.0.1:${analyticsPort}/pay`);
    await page.waitForTimeout(1500);
    await popup.evaluate(() => chrome.runtime.sendMessage({ type: "stop" }));
    await page.close();

    const raw = JSON.stringify(await popup.evaluate(() => chrome.storage.local.get(null)));
    for (const plain of ["ENCRYPTED-TASK-TITLE", "Checkout", "LAMPCODE", "127.0.0.1", "page_read", "hidden_instruction"]) {
      expect(raw, plain).not.toContain(plain);
    }
    expect(raw).toContain('"alg":"AES-GCM"');
    const ivs = [...raw.matchAll(/"iv":"([^"]+)"/g)].map((m) => m[1]);
    expect(ivs.length).toBeGreaterThan(3);
    expect(new Set(ivs).size).toBe(ivs.length); // a unique IV per record

    const key = await popup.evaluate(
      () =>
        new Promise<{ extractable: boolean; algorithm: string; exportRejected: boolean }>((resolve, reject) => {
          const open = indexedDB.open("steplight-keys", 1);
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const get = open.result.transaction("keys").objectStore("keys").get("storage-v1");
            get.onsuccess = async () => {
              const k = get.result as CryptoKey;
              const exportRejected = await crypto.subtle.exportKey("raw", k).then(() => false, () => true);
              resolve({ extractable: k.extractable, algorithm: k.algorithm.name, exportRejected });
            };
          };
        }),
    );
    expect(key).toEqual({ extractable: false, algorithm: "AES-GCM", exportRejected: true });

    // The bundled viewer decrypts transparently.
    const viewer = await context.newPage();
    await viewer.goto(`chrome-extension://${extId}/viewer.html`);
    await viewer.getByTestId("run-item").filter({ hasText: "ENCRYPTED-TASK-TITLE" }).click();
    await viewer.getByTestId("step-item").first().waitFor();
    await viewer.close();
    await popup.close();
  }, 90_000);
});

/* ------------------------------------------------------------------------------------------ */
/* Enterprise controls: how the UIs react to a managed policy, and the audit log               */
/* ------------------------------------------------------------------------------------------ */

describe.sequential("managed policy UI and audit log in a real browser", () => {
  // `chrome.storage.managed` cannot be filled from a test (it comes from the browser's enterprise
  // policy), so the worker's policy logic is covered by unit tests (policy.ts, background-logic).
  // Here we check what the worker publishes by default, and that every page reacts to a published policy.
  const published = {
    managed: true,
    policy: { maxCaptureLevel: "minimal", disableDeepCapture: true, disableExport: true, requireEncryption: true, retentionDays: 3 },
    lockedKeys: ["deepCapture"],
    forcedDenylist: ["bank.example"],
    forcedPatterns: ["CORP-\\d+"],
  };

  it("the worker publishes effective settings and an empty policy when none is configured", async (ctx) => {
    if (!portFree) return ctx.skip();
    const popup = await popupPage();
    await popup.evaluate((st) => chrome.storage.local.set({ "sl-settings": st }), { captureLevel: "full" });
    const status = await popup.evaluate(() => chrome.runtime.sendMessage({ type: "status" }));
    expect(status).toMatchObject({ captureLevel: "full" });
    expect(status.managed).toBeUndefined();
    const stored = await popup.evaluate(() => chrome.storage.local.get(["sl-effective", "sl-policy"]));
    expect(stored["sl-effective"]).toMatchObject({ captureLevel: "full", deepCapture: false, retentionDays: 7 });
    expect(stored["sl-policy"]).toEqual({ managed: false, policy: {}, lockedKeys: [], forcedDenylist: [], forcedPatterns: [] });
    await popup.evaluate(() => chrome.storage.local.set({ "sl-settings": {} }));
    await popup.close();
  }, 60_000);

  it("settings page and viewer lock what a published policy controls, and say why", async (ctx) => {
    if (!portFree) return ctx.skip();
    const popup = await popupPage();
    await popup.evaluate((v) => chrome.storage.local.set({ "sl-policy": v }), published);

    const settingsPage = await context.newPage();
    await settingsPage.goto(`chrome-extension://${extId}/settings.html`);
    await settingsPage.locator("#managedNote").waitFor({ state: "visible" });
    expect(await settingsPage.locator("#deep").isDisabled()).toBe(true);
    expect(await settingsPage.locator('input[name="level"][value="full"]').isDisabled()).toBe(true);
    expect(await settingsPage.locator('input[name="level"][value="standard"]').isDisabled()).toBe(true);
    expect(await settingsPage.locator('input[name="level"][value="minimal"]').isDisabled()).toBe(false);
    expect(await settingsPage.locator("#forcedDeny").innerText()).toContain("bank.example");
    expect(await settingsPage.locator("#forcedPatterns").innerText()).toContain("CORP-");
    expect(await settingsPage.locator("#days").getAttribute("max")).toBe("3");
    await settingsPage.close();

    const viewer = await context.newPage();
    await viewer.goto(`chrome-extension://${extId}/viewer.html`);
    await expect.poll(() => viewer.getByTestId("import").isDisabled()).toBe(true);
    expect(await viewer.getByTestId("export").isDisabled()).toBe(true);
    expect(await viewer.getByTestId("export-html").isDisabled()).toBe(true);
    expect(await viewer.getByTestId("import").getAttribute("title")).toContain("Managed by your organization");
    await viewer.close();

    // policy removed: controls are free again
    await popup.evaluate((v) => chrome.storage.local.set({ "sl-policy": v }), { managed: false, policy: {}, lockedKeys: [], forcedDenylist: [], forcedPatterns: [] });
    const free = await context.newPage();
    await free.goto(`chrome-extension://${extId}/settings.html`);
    await free.locator("#deep").waitFor();
    expect(await free.locator("#deep").isDisabled()).toBe(false);
    expect(await free.locator("#managedNote").isHidden()).toBe(true);
    await free.close();
    await popup.close();
  }, 90_000);

  it("keeps a tamper-evident audit log of Steplight's own actions, without page content", async (ctx) => {
    if (!portFree) return ctx.skip();
    const popup = await popupPage();
    await popup.evaluate(() => chrome.runtime.sendMessage({ type: "unpair" }));
    const page = await context.newPage();
    await page.goto("about:blank");
    await page.bringToFront();
    await popup.evaluate(() => chrome.runtime.sendMessage({ type: "start", task: "AUDIT-SECRET-TASK" }));
    await page.goto(`http://127.0.0.1:${analyticsPort}/pay`);
    await page.waitForTimeout(800);
    await popup.evaluate(() => chrome.runtime.sendMessage({ type: "stop" }));
    await popup.evaluate(() => chrome.storage.local.set({ "sl-settings": { captureLevel: "minimal" } }));
    await popup.evaluate(() => chrome.runtime.sendMessage({ type: "audit", action: "export", detail: { kind: "json", encrypted: true } }));
    await page.close();
    await new Promise((r) => setTimeout(r, 500));

    const log = (await popup.evaluate(() => chrome.storage.local.get("sl-audit")))["sl-audit"] as { entries: AuditEntry[]; anchor: string };
    const actions = log.entries.map((e) => e.action);
    for (const a of ["recording_started", "recording_stopped", "settings_changed", "export"]) expect(actions, a).toContain(a);
    expect(JSON.stringify(log)).not.toContain("AUDIT-SECRET-TASK");
    expect(JSON.stringify(log)).not.toContain("Checkout");
    expect(verifyAuditLog(log.entries, log.anchor || undefined).ok).toBe(true);

    // the settings page shows it and the chain is reported intact
    const settingsPage = await context.newPage();
    await settingsPage.goto(`chrome-extension://${extId}/settings.html`);
    await expect.poll(() => settingsPage.locator("#auditStatus").innerText()).toContain("intact");
    expect(await settingsPage.locator("#auditList li").count()).toBeGreaterThan(3);

    // tamper with an entry in storage: the page says so
    const tampered = structuredClone(log);
    tampered.entries[1]!.detail = { ...tampered.entries[1]!.detail, forged: true };
    await settingsPage.evaluate((t) => chrome.storage.local.set({ "sl-audit": t }), tampered);
    await expect.poll(() => settingsPage.locator("#auditStatus").innerText()).toContain("tampered");
    expect(verifyAuditLog(tampered.entries, tampered.anchor || undefined).ok).toBe(false);
    await settingsPage.evaluate((t) => chrome.storage.local.set({ "sl-audit": t }), log);
    await settingsPage.close();
    await popup.close();
  }, 90_000);
});
