import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createViewerServer, type ViewerServer } from "@steplight/cli";
import type { Run, Settings, Step } from "@steplight/core";
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
  const task = `net: ${url}`;
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
