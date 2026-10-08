import { describe, expect, it } from "vitest";
import { generatePlaywrightTest } from "./repro.js";
import type { Run, Step } from "./types.js";

let t = 0;
const step = (over: Partial<Step>): Step => ({
  id: `s${t}`,
  runId: "run-1",
  index: t++,
  kind: "navigate",
  timestamp: 1000 + t * 100,
  flags: [],
  ...over,
});

const run = (steps: Step[]): Run => ({ id: "run-1", task: "Book a flight", startedAt: 0, status: "success", steps, meta: {} });

describe("generatePlaywrightTest", () => {
  const steps = [
    step({ kind: "navigate", url: "http://127.0.0.1:4001/flights.html" }),
    step({ kind: "page_read", url: "http://127.0.0.1:4001/flights.html" }),
    step({ kind: "agent_note", targetText: "Picking\nthe cheapest" }),
    step({ kind: "click", url: "http://127.0.0.1:4001/flights.html", targetSelector: "a#select-premium", targetText: "Select Premium" }),
    step({ kind: "navigate", url: "http://127.0.0.1:4001/checkout.html?flight=AI-101" }),
    step({ kind: "page_read", url: "http://127.0.0.1:4001/checkout.html?flight=AI-101" }),
    step({ kind: "type", url: "http://127.0.0.1:4001/checkout.html", targetSelector: "input#email", targetText: "Confirmation email (value not recorded)" }),
    step({ kind: "click", url: "http://127.0.0.1:4001/checkout.html", targetSelector: "button#pay", targetText: "Confirm booking" }),
    step({ kind: "form_submit", url: "http://127.0.0.1:4001/checkout.html", targetSelector: "form#checkout", request: { method: "POST", url: "http://127.0.0.1:4002/collect" } }),
    step({ kind: "navigate", url: "http://127.0.0.1:4002/collect" }),
  ];
  const code = generatePlaywrightTest(run(steps));

  it("starts with the recorded origin and a navigation with a URL assertion", () => {
    expect(code).toContain('import { test, expect } from "@playwright/test";');
    expect(code).toContain('const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:4001";');
    expect(code).toContain("await page.goto(`${BASE_URL}/flights.html`);");
    expect(code).toContain("await expect(page).toHaveURL(/\\/flights\\.html(?:[?#]|$)/);");
  });

  it("replays clicks via stable selectors", () => {
    expect(code).toContain('await page.locator("a#select-premium").click();');
    expect(code).toContain('await page.locator("button#pay").click();');
  });

  it("does not goto navigations that were a consequence of a click, but still asserts them", () => {
    expect(code).not.toContain("checkout.html?flight");
    expect(code).toContain("toHaveURL(/\\/checkout\\.html(?:[?#]|$)/)");
    expect(code).not.toContain("goto(`http://127.0.0.1:4002");
    expect(code).toContain("toHaveURL(/\\/collect(?:[?#]|$)/)");
  });

  it("turns unrecorded typed values into TODO placeholders", () => {
    expect(code).toContain('await page.locator("input#email").fill("todo@example.com"); // TODO: the typed value was not recorded (Confirmation email)');
    expect(code).not.toContain("(value not recorded)");
  });

  it("notes the agent's reasoning on a single comment line and the implicit form submit", () => {
    expect(code).toContain("// Agent note: Picking the cheapest");
    expect(code).toContain("// The click above submitted the form (POST http://127.0.0.1:4002/collect)");
    expect(code).not.toContain("requestSubmit");
  });

  it("is valid-looking TypeScript with balanced braces and a titled test", () => {
    expect(code).toContain('test("Book a flight (run run-1)", async ({ page }) => {');
    expect(code.trim().endsWith("});")).toBe(true);
    expect((code.match(/{/g) ?? []).length).toBe((code.match(/}/g) ?? []).length);
  });

  it("uses requestSubmit when a form was submitted without a click", () => {
    const out = generatePlaywrightTest(
      run([
        step({ kind: "navigate", url: "http://h/a" }),
        step({ kind: "form_submit", url: "http://h/a", targetSelector: "form#f", request: { method: "GET", url: "http://h/a" }, timestamp: 99_999 }),
      ]),
    );
    expect(out).toContain('await page.locator("form#f").evaluate((form) => (form as HTMLFormElement).requestSubmit());');
  });

  it("replays recorded failures as expected failures with the cause", () => {
    const out = generatePlaywrightTest(
      run([
        step({ kind: "navigate", url: "http://h/stuck.html" }),
        step({
          kind: "click",
          url: "http://h/stuck.html",
          targetSelector: "button#covered-btn",
          error: "Timeout 800ms exceeded.\nCall log: ...",
          diagnosis: { selector: "button#covered-btn", matchCount: 1, elements: [], similar: [], reasons: ["Element is covered by div#promo-overlay"] },
        }),
      ]),
    );
    expect(out).toContain("// Recorded failure: Timeout 800ms exceeded. Call log: ...");
    expect(out).toContain("// Likely cause: Element is covered by div#promo-overlay");
    expect(out).toContain('await expect(page.locator("button#covered-btn").click({ timeout: 2000 })).rejects.toThrow();');
  });

  it("handles selectors without ids, selects, passwords and a custom base URL", () => {
    const out = generatePlaywrightTest(
      run([
        step({ kind: "navigate", url: "http://h:1/start" }),
        step({ kind: "click", url: "http://h:1/start", targetSelector: "button.primary", targetText: "Next", timestamp: 60_000 }),
        step({ kind: "type", url: "http://h:1/start", targetSelector: "select[name=\"country\"]", targetText: "Country (value not recorded)" }),
        step({ kind: "type", url: "http://h:1/start", targetSelector: "input[name=\"password\"]", targetText: "Password (value not recorded)" }),
      ]),
      { baseUrl: "http://other:9" },
    );
    expect(out).toContain('page.locator("button.primary").filter({ hasText: "Next" }).first().click()');
    expect(out).toContain('selectOption({ index: 0 }); // TODO');
    expect(out).toContain('fill("TODO_PASSWORD")');
    expect(out).toContain('?? "http://other:9"');
    expect(out).toContain("goto(`http://h:1/start`)"); // different origin from the base: absolute URL
  });

  it("produces an empty-bodied test for an empty run", () => {
    expect(generatePlaywrightTest(run([]))).toContain("async ({ page }) => {\n});");
  });
});
