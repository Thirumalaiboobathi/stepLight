import { describe, expect, it } from "vitest";
import type { DomTextNode } from "./detectors/hiddenInstruction.js";
import { computeTokenStats, estimateTokens, formatTokens, summarizeTokens } from "./tokens.js";
import type { PageTokens, Step } from "./types.js";

const scan = (nodes: DomTextNode[]) => ({ dom: { nodes } });
const text = (n: number) => "x".repeat(n);

describe("estimateTokens", () => {
  it("is chars / 4 rounded up, and never negative", () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(1)).toBe(1);
    expect(estimateTokens(4000)).toBe(1000);
    expect(estimateTokens(4001)).toBe(1001);
    expect(estimateTokens(-5)).toBe(0);
  });
  it("formats counts compactly", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(12_340)).toBe("12.3k");
    expect(formatTokens(250_000)).toBe("250k");
  });
});

describe("computeTokenStats", () => {
  it("splits visible, hidden and boilerplate text", () => {
    const stats = computeTokenStats(
      scan([
        { text: text(400) }, // visible article
        { text: text(200), landmark: "nav" }, // visible boilerplate
        { text: text(100), display: "none" }, // hidden
        { text: text(300), landmark: "cookie", display: "none" }, // hidden boilerplate
      ]),
    );
    expect(stats.visibleChars).toBe(600);
    expect(stats.hiddenChars).toBe(400);
    expect(stats.boilerplateChars).toBe(500);
    expect(stats.total).toBe(250); // 1000 chars / 4
    expect(stats.boilerplateShare).toBe(0.5);
    expect(stats.estimated).toBe(true);
  });
  it("counts comments and attribute text as hidden", () => {
    const stats = computeTokenStats(scan([{ text: text(80), source: "comment" }, { text: text(80), source: "attribute" }, { text: text(40) }]));
    expect(stats.hiddenChars).toBe(160);
    expect(stats.visibleChars).toBe(40);
  });
  it("handles an empty page", () => {
    expect(computeTokenStats(scan([]))).toMatchObject({ total: 0, boilerplateShare: 0 });
  });
});

describe("summarizeTokens", () => {
  const tokens = (total: number, boilerplateChars = 0): PageTokens => ({
    total,
    visibleChars: total * 4,
    hiddenChars: 0,
    boilerplateChars,
    boilerplateShare: (boilerplateChars / (total * 4)) || 0,
    estimated: true,
  });
  const read = (index: number, total: number, boiler = 0, kind: Step["kind"] = "page_read"): Step => ({
    id: `s${index}`,
    runId: "r",
    index,
    kind,
    timestamp: index,
    url: `http://h/p${index}`,
    flags: [],
    tokens: tokens(total, boiler),
  });

  it("totals the run and lists the three most expensive pages", () => {
    const s = summarizeTokens({ steps: [read(0, 100), read(1, 900, 1800), read(2, 400), read(3, 50), read(4, 700)] });
    expect(s.pages).toBe(5);
    expect(s.total).toBe(2150);
    expect(s.top.map((t) => [t.index, t.tokens])).toEqual([[1, 900], [4, 700], [2, 400]]);
    expect(s.top[0]!.boilerplateShare).toBe(0.5);
    expect(s.boilerplateShare).toBeCloseTo(1800 / (2150 * 4), 3);
  });
  it("ignores steps without estimates and non page reads", () => {
    const noTokens: Step = { ...read(0, 10), tokens: undefined };
    const s = summarizeTokens({ steps: [noTokens, read(1, 20, 0, "click"), read(2, 30)] });
    expect(s).toMatchObject({ pages: 1, total: 30 });
    expect(summarizeTokens({ steps: [] })).toMatchObject({ pages: 0, total: 0, top: [], boilerplateShare: 0 });
  });
  it("breaks ties by step order", () => {
    const s = summarizeTokens({ steps: [read(0, 10), read(1, 10)] });
    expect(s.top.map((t) => t.index)).toEqual([0, 1]);
  });
});
