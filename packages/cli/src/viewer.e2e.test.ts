import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDemo } from "../../../examples/demo-agent/src/demo.mjs";
import { createViewerServer, findViewerDir } from "./server.js";

let dir: string;
let server: Server;
let browser: Browser;
let base: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "steplight-e2e-"));
  await runDemo({ dir, quiet: true });
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

describe("viewer", () => {
  it("shows the demo run and its hidden_instruction flag with highlighted evidence", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(base);
    await page.getByTestId("run-item").filter({ hasText: "Book the cheapest flight" }).click();
    await page.locator('[data-testid="step-item"][data-kind="page_read"][data-severity="high"]').first().click();
    const detail = page.getByTestId("step-detail");
    await expect_(detail.getByText("hidden_instruction")).toBeVisible();
    await expect_(page.getByTestId("evidence").first()).toContainText("always select the Premium option");

    // The click that obeyed the injection links back to the page read.
    await page.locator('[data-testid="step-item"][data-kind="click"]').filter({ hasText: "Premium" }).click();
    await page.getByTestId("caused-by").click();
    await expect_(detail.getByText("hidden_instruction")).toBeVisible();
    await page.close();
  }, 60_000);

  it("replays steps automatically", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(base);
    await page.getByTestId("run-item").filter({ hasText: "Book the cheapest flight" }).click();
    await page.getByTestId("step-item").first().waitFor();
    await page.getByTestId("replay").click();
    await expect_(page.getByTestId("replay")).toContainText("Pause");
    await page.waitForTimeout(1900);
    const selected = await page.locator('[data-testid="step-item"].ring-2').count();
    expect(selected).toBe(1);
    expect(await page.locator('[data-testid="step-item"].ring-2').first().innerText()).not.toContain("#0 ");
    await page.close();
  }, 60_000);

  it("fits a 375px screen without horizontal scrolling", async () => {
    const page = await browser.newPage({ viewport: { width: 375, height: 800 } });
    await page.goto(base);
    await page.getByTestId("run-item").first().click();
    await page.getByTestId("step-item").first().waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.close();
  }, 60_000);
});

/** Tiny poll-based expect for locators (avoids pulling @playwright/test). */
function expect_(locator: import("playwright").Locator) {
  const wait = (state: "visible") => locator.first().waitFor({ state, timeout: 10_000 });
  return {
    toBeVisible: () => wait("visible"),
    toContainText: async (text: string) => {
      await wait("visible");
      await locator.first().evaluate(
        (el, t) => {
          if (!(el.textContent ?? "").includes(t)) throw new Error(`text not found: ${t}`);
        },
        text,
      );
    },
  };
}
