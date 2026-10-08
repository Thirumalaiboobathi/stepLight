import { hiddenReasons } from "./detectors/hiddenInstruction.js";
import type { PageScan } from "./collect.js";
import type { PageTokens, Run, Step } from "./types.js";

/** Rough characters-per-token ratio for English-like text. This is an estimate, not a tokenizer. */
export const CHARS_PER_TOKEN = 4;

/**
 * Estimated token count for a number of characters (chars / 4, rounded up).
 * @example estimateTokens(4000) // 1000
 */
export function estimateTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN);
}

/**
 * Estimate what reading a page costs an LLM agent: total tokens of all text on the page (hidden
 * text included, because scrapers feed it to the model), and how much of it is visible text,
 * hidden text and boilerplate (navigation, footers, sidebars, cookie banners, ads).
 * All figures are heuristic estimates.
 * @example const tokens = computeTokenStats(await page.evaluate(collectPageScan))
 */
export function computeTokenStats(scan: Pick<PageScan, "dom">): PageTokens {
  let visibleChars = 0;
  let hiddenChars = 0;
  let boilerplateChars = 0;
  for (const node of scan.dom.nodes) {
    const chars = node.text.length;
    if (hiddenReasons(node).length > 0) hiddenChars += chars;
    else visibleChars += chars;
    if (node.landmark) boilerplateChars += chars;
  }
  const all = visibleChars + hiddenChars;
  return {
    total: estimateTokens(all),
    visibleChars,
    hiddenChars,
    boilerplateChars,
    boilerplateShare: all === 0 ? 0 : Math.round((boilerplateChars / all) * 1000) / 1000,
    estimated: true,
  };
}

/** One page in the "most expensive pages" list. */
export interface ExpensivePage {
  stepId: string;
  index: number;
  url?: string;
  tokens: number;
  boilerplateShare: number;
}

/** Token cost summary of a whole run. */
export interface RunTokenSummary {
  /** Number of page reads that carry token estimates. */
  pages: number;
  /** Estimated tokens over all page reads. */
  total: number;
  visibleChars: number;
  hiddenChars: number;
  boilerplateChars: number;
  /** Boilerplate share of all page text in the run, 0–1. */
  boilerplateShare: number;
  /** The three most expensive page reads. */
  top: ExpensivePage[];
  estimated: true;
}

/**
 * Summarise the token cost of a run: total, breakdown and the top 3 most expensive pages.
 * @example const { total, top } = summarizeTokens(run)
 */
export function summarizeTokens(run: Pick<Run, "steps">): RunTokenSummary {
  const reads = run.steps.filter((s): s is Step & { tokens: PageTokens } => s.kind === "page_read" && !!s.tokens);
  let visible = 0;
  let hidden = 0;
  let boiler = 0;
  let total = 0;
  for (const s of reads) {
    total += s.tokens.total;
    visible += s.tokens.visibleChars;
    hidden += s.tokens.hiddenChars;
    boiler += s.tokens.boilerplateChars;
  }
  const all = visible + hidden;
  const top = [...reads]
    .sort((a, b) => b.tokens.total - a.tokens.total || a.index - b.index)
    .slice(0, 3)
    .map((s) => ({
      stepId: s.id,
      index: s.index,
      url: s.url,
      tokens: s.tokens.total,
      boilerplateShare: s.tokens.boilerplateShare,
    }));
  return {
    pages: reads.length,
    total,
    visibleChars: visible,
    hiddenChars: hidden,
    boilerplateChars: boiler,
    boilerplateShare: all === 0 ? 0 : Math.round((boiler / all) * 1000) / 1000,
    top,
    estimated: true,
  };
}

/**
 * Compact display of a token count: 950 → "950", 12 340 → "12.3k".
 * @example formatTokens(12340) // "12.3k"
 */
export function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n);
}
