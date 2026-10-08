import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBundle, renderHtmlReport, writeRun, type Run, type Step } from "@steplight/core/node";
import { fileURLToPath } from "node:url";
import { createViewerServer, findViewerDir, type ViewerServer } from "./server.js";

/** Payloads an attacker can put in page text, URLs, selectors, task titles, request bodies and evidence. */
const PAYLOADS = [
  '<img src=x onerror="window.__pwned=(window.__pwned||0)+1">',
  "<script>window.__pwned=(window.__pwned||0)+1</script>",
  '<svg onload="window.__pwned=(window.__pwned||0)+1"><circle r="1"/></svg>',
  "javascript:window.__pwned=(window.__pwned||0)+1",
  '"><iframe srcdoc="<script>parent.__pwned=1</script>"></iframe>',
  "</pre><details open ontoggle=window.__pwned=1><summary>x</summary></details>",
];
const ALL = PAYLOADS.join(" | ");

function attackRun(id: string, task: string): { run: Run; snapshots: Record<string, string> } {
  const mk = (i: number, extra: Partial<Step>): Step => ({
    id: `s${i}`,
    runId: id,
    index: i,
    kind: "page_read",
    timestamp: 1000 + i,
    url: `http://evil.test/p?x=${PAYLOADS[0]}`,
    targetText: ALL,
    targetSelector: ALL,
    snapshotRef: `snapshots/s${i}.txt`,
    flags: [{ type: "hidden_instruction", severity: "high", message: ALL, evidence: PAYLOADS[1]! }],
    ...extra,
  });
  const steps: Step[] = [
    mk(0, {}),
    mk(1, { kind: "click", causedBy: "s0", error: ALL, diagnosis: { selector: ALL, matchCount: 0, elements: [], similar: [ALL], reasons: [ALL] } }),
    mk(2, { kind: "form_submit", request: { method: "POST", url: `http://evil.test/?${ALL}`, bodyPreview: ALL } }),
  ];
  const run: Run = { id, task, startedAt: 1000, endedAt: 2000, status: "success", steps, meta: { note: ALL } };
  const snapshots = Object.fromEntries(steps.map((s) => [s.id, `visible text ${ALL} trailing`]));
  return { run, snapshots };
}

let dir: string;
let server: ViewerServer;
let base: string;
let browser: Browser;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "steplight-xss-"));
  for (const [id, task] of [["xss-1", `Task ${ALL}`], ["xss-2", `Other ${ALL}`]] as const) {
    const { run, snapshots } = attackRun(id, task);
    await writeRun(dir, run, snapshots);
  }
  const viewerDir = findViewerDir(fileURLToPath(new URL(".", import.meta.url)));
  expect(viewerDir, "viewer must be built (pnpm -r build)").toBeDefined();
  server = createViewerServer({ runsDir: dir, viewerDir });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ headless: true });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  server?.closeAllConnections();
  await new Promise((r) => server?.close(r));
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** Everything that must be true after hostile content has been rendered. */
async function assertInert(page: Page, dialogs: string[], scope = "body"): Promise<void> {
  expect(dialogs).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  const injected = await page.evaluate((sel) => {
    const root = document.querySelector(sel)!;
    return {
      img: root.querySelectorAll("img").length,
      iframe: root.querySelectorAll("iframe").length,
      svg: root.querySelectorAll("svg[onload], circle").length,
      handlers: Array.from(root.querySelectorAll("*")).filter((e) => e.getAttributeNames().some((n) => n.startsWith("on"))).length,
      jsLinks: Array.from(root.querySelectorAll("a[href]")).filter((a) => /^\s*javascript:/i.test(a.getAttribute("href")!)).length,
      scripts: Array.from(root.querySelectorAll("script")).filter((s) => !s.src && s.textContent!.includes("__pwned")).length,
    };
  }, scope);
  expect(injected).toEqual({ img: 0, iframe: 0, svg: 0, handlers: 0, jsLinks: 0, scripts: 0 });
}

describe("XSS payloads in snapshots, URLs, selectors, bodies, task titles and evidence", () => {
  it("render as inert text in the CLI viewer", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const dialogs: string[] = [];
    page.on("dialog", (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });
    const cspViolations: string[] = [];
    page.on("console", (m) => m.text().includes("Content Security Policy") && cspViolations.push(m.text()));
    await page.goto(`${base}/#token=${server.token}`);
    await page.getByTestId("run-item").first().click();
    await page.getByTestId("step-item").first().waitFor();
    const count = await page.getByTestId("step-item").count();
    expect(count).toBe(3);
    for (let i = 0; i < count; i++) {
      await page.getByTestId("step-item").nth(i).click();
      await page.getByTestId("snapshot").first().waitFor();
      await assertInert(page, dialogs, "#root");
    }
    // the hostile strings are visible as literal text
    const detailText = await page.getByTestId("step-detail").innerText();
    expect(detailText).toContain("<img src=x onerror=");
    expect(detailText).toContain("<script>window.__pwned");
    // evidence highlighting is a <mark> around a text node, not injected markup
    await page.getByTestId("evidence").first().waitFor();
    const marks = await page.getByTestId("evidence").evaluateAll((els) => els.map((e) => ({ children: e.children.length, text: e.textContent })));
    expect(marks.length).toBeGreaterThan(0);
    for (const m of marks) expect(m.children).toBe(0);
    expect(marks[0]!.text).toBe(PAYLOADS[1]);

    // the run list and Compare mode render task titles as text too
    await expect_(page.getByTestId("run-item").first()).toContainText("<img src=x");
    await page.getByTestId("compare").click();
    await page.getByTestId("diff-summary").waitFor();
    await assertInert(page, dialogs, "#root");
    expect(cspViolations).toEqual([]);
    await page.close();
  }, 90_000);

  it("the viewer page itself is served with a strict CSP that blocks inline script", async () => {
    const res = await fetch(`${base}/`);
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    const page = await browser.newPage();
    await page.goto(`${base}/#token=${server.token}`);
    // an inline script injected by "attacker" markup must not run under the CSP
    const ran = await page.evaluate(() => {
      const s = document.createElement("script");
      s.textContent = "window.__inline = 1";
      document.body.appendChild(s);
      return (window as unknown as { __inline?: number }).__inline;
    });
    expect(ran).toBeUndefined();
    // and fetching a foreign origin is blocked by connect-src
    const blocked = await page.evaluate(() => fetch("https://example.com/", { mode: "no-cors" }).then(() => false, () => true));
    expect(blocked).toBe(true);
    await page.close();
  }, 30_000);

  it("render as inert text in the exported HTML report, which also blocks inline script and network", async () => {
    const { run, snapshots } = attackRun("xss-r", `Report ${ALL}`);
    const other = attackRun("xss-r2", `Other ${ALL}`);
    const html = renderHtmlReport(createBundle(run, snapshots), { compare: createBundle(other.run, other.snapshots) });
    const file = path.join(dir, "report.html");
    await writeFile(file, html);
    const page = await browser.newPage();
    const dialogs: string[] = [];
    page.on("dialog", (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });
    await page.goto(pathToFileURL(file).href);
    await page.click("#expand");
    await assertInert(page, dialogs, "main");
    expect(await page.locator("main").innerText()).toContain("<img src=x onerror=");
    // CSP in the report: injected inline script is blocked, and no connections are allowed
    const ran = await page.evaluate(() => {
      const s = document.createElement("script");
      s.textContent = "window.__inline = 1";
      document.head.appendChild(s);
      return (window as unknown as { __inline?: number }).__inline;
    });
    expect(ran).toBeUndefined();
    const blocked = await page.evaluate(() => fetch("http://127.0.0.1:9/", { mode: "no-cors" }).then(() => false, () => true));
    expect(blocked).toBe(true);
    await page.close();
  }, 60_000);
});

/** Tiny poll-based expect for locators. */
function expect_(locator: ReturnType<Page["locator"]>) {
  return {
    async toContainText(text: string): Promise<void> {
      await locator.waitFor();
      expect(await locator.innerText()).toContain(text);
    },
  };
}
