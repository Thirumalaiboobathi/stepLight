import type { Run, Step } from "./types.js";

/** Options for {@link generatePlaywrightTest}. */
export interface ReproOptions {
  /** Origin the recorded site was served from. Default: origin of the first navigation. */
  baseUrl?: string;
}

/** Navigations within this window after a click/submit are treated as its consequence. */
const CONSEQUENCE_MS = 5000;

const q = (s: string): string => JSON.stringify(s);

function oneLine(s: string, max = 160): string {
  return s.replace(/\s+/g, " ").trim().slice(0, max);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

function parse(url: string | undefined): URL | undefined {
  try {
    return url ? new URL(url) : undefined;
  } catch {
    return undefined;
  }
}

/** `/flights.html` → regex source that matches the URL path (ignoring query/hash). */
function urlRegex(url: string): string {
  const u = parse(url);
  const path = (u?.pathname ?? "/").replace(/\/+$/, "") || "/";
  return `/${escapeRegex(path)}(?:[?#]|$)/`;
}

/** Placeholder for a value that was deliberately not recorded. */
function placeholder(step: Step): string {
  const hint = `${step.targetSelector ?? ""} ${step.targetText ?? ""}`.toLowerCase();
  if (/pass(word)?\b/.test(hint)) return "TODO_PASSWORD";
  if (/e-?mail/.test(hint)) return "todo@example.com";
  if (/phone|tel\b|mobile/.test(hint)) return "0000000000";
  return "TODO_VALUE";
}

/** Playwright expression that finds the element a step acted on. */
function locator(step: Step, useText: boolean): string {
  const sel = step.targetSelector;
  const text = useText ? step.targetText : undefined;
  if (!sel) return text ? `page.getByText(${q(text)}).first()` : `page.locator("body")`;
  if (sel.includes("#") || sel.includes("[name=")) return `page.locator(${q(sel)})`;
  return text
    ? `page.locator(${q(sel)}).filter({ hasText: ${q(text)} }).first()`
    : `page.locator(${q(sel)}).first()`;
}

/**
 * Generate a Playwright test (`@playwright/test`) that replays a recorded run: navigations,
 * clicks and field edits, with a URL assertion for each page. Typed values were never recorded,
 * so they become `TODO_` placeholders. Failed actions are replayed as expected failures so the
 * bug reproduces. The recorded site's origin is read from `BASE_URL` (default: where it was
 * recorded).
 * @example
 * await fs.writeFile("repro.spec.ts", generatePlaywrightTest(run));
 * // BASE_URL=http://localhost:3000 npx playwright test repro.spec.ts
 */
export function generatePlaywrightTest(run: Run, options: ReproOptions = {}): string {
  const firstNav = run.steps.map((s) => parse(s.kind === "navigate" ? s.url : undefined)).find(Boolean);
  const origin = options.baseUrl ?? firstNav?.origin ?? "http://localhost:3000";

  const body: string[] = [];
  const emit = (line: string) => body.push(`  ${line}`);
  let lastAction: Step | undefined;
  let lastAssertedPath: string | undefined;
  const pathOf = (url: string | undefined) => parse(url)?.pathname;

  const assertUrl = (url: string | undefined) => {
    const p = pathOf(url);
    if (!url || p === undefined || p === lastAssertedPath) return;
    lastAssertedPath = p;
    emit(`await expect(page).toHaveURL(${urlRegex(url)});`);
  };

  for (const step of run.steps) {
    switch (step.kind) {
      case "navigate": {
        const consequence =
          lastAction !== undefined && step.timestamp - lastAction.timestamp <= CONSEQUENCE_MS && step.timestamp >= lastAction.timestamp;
        const u = parse(step.url);
        if (!u) break;
        if (!consequence) {
          const target = u.origin === origin ? `\${BASE_URL}${u.pathname}${u.search}${u.hash}` : u.href;
          emit(`await page.goto(\`${target}\`);`);
        }
        lastAssertedPath = undefined; // always assert after a navigation
        assertUrl(step.url);
        break;
      }
      case "page_read":
        assertUrl(step.url);
        break;
      case "click": {
        const loc = locator(step, true);
        if (step.error) {
          emit(`// Recorded failure: ${oneLine(step.error)}`);
          if (step.diagnosis?.reasons[0]) emit(`// Likely cause: ${oneLine(step.diagnosis.reasons[0])}`);
          emit(`await expect(${loc}.click({ timeout: 2000 })).rejects.toThrow();`);
        } else {
          emit(`await ${loc}.click();`);
        }
        lastAction = step;
        break;
      }
      case "type": {
        const loc = locator(step, false);
        const label = oneLine((step.targetText ?? "").replace(/ \(value not recorded\)$/, ""), 80);
        if (step.error) {
          emit(`// Recorded failure: ${oneLine(step.error)}`);
          emit(`await expect(${loc}.fill(${q(placeholder(step))}, { timeout: 2000 })).rejects.toThrow();`);
        } else if (step.targetSelector?.startsWith("select")) {
          emit(`await ${loc}.selectOption({ index: 0 }); // TODO: choose the option the agent picked (${label})`);
        } else {
          emit(`await ${loc}.fill(${q(placeholder(step))}); // TODO: the typed value was not recorded (${label})`);
        }
        break;
      }
      case "form_submit": {
        const submittedByClick = lastAction?.kind === "click" && step.timestamp - lastAction.timestamp <= 2000;
        if (submittedByClick) {
          emit(`// The click above submitted the form (${step.request?.method ?? "POST"} ${oneLine(step.request?.url ?? "", 100)})`);
        } else if (step.targetSelector) {
          emit(`await page.locator(${q(step.targetSelector)}).evaluate((form) => (form as HTMLFormElement).requestSubmit());`);
        }
        lastAction = step;
        break;
      }
      case "agent_note":
        emit(`// Agent note: ${oneLine(step.targetText ?? "")}`);
        break;
      case "download":
        emit(`// Download in the recording: ${oneLine(step.targetText ?? step.url ?? "")}`);
        break;
      case "error":
        emit(`// Error in the recording: ${oneLine(step.error ?? step.targetText ?? "")}`);
        break;
      default:
        break; // network_request: not replayed (it is a consequence of the page's own scripts)
    }
  }

  const title = oneLine(`${run.task} (run ${run.id})`, 120);
  return [
    `// Generated by Steplight from run ${run.id}.`,
    `// Replays the recorded navigations, clicks and field edits and asserts the URL of each page.`,
    `// Typed values were not recorded: replace the TODO_ placeholders with real test data.`,
    `// Run it with:  BASE_URL=${origin} npx playwright test`,
    `import { test, expect } from "@playwright/test";`,
    ``,
    `const BASE_URL = process.env.BASE_URL ?? ${q(origin)};`,
    ``,
    `test(${q(title)}, async ({ page }) => {`,
    ...body,
    `});`,
    ``,
  ].join("\n");
}
