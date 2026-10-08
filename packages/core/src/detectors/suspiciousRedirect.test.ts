import { describe, expect, it } from "vitest";
import type { Flag, Step } from "../types.js";
import { suspiciousRedirect } from "./suspiciousRedirect.js";

const hidden: Flag = { type: "hidden_instruction", severity: "high", message: "m", evidence: "e" };

const step = (over: Partial<Step>): Step => ({
  id: "s",
  runId: "r",
  index: 0,
  kind: "page_read",
  timestamp: 1000,
  url: "https://a.test/page",
  flags: [],
  ...over,
});

const flaggedRead = step({ id: "read", flags: [hidden] });

describe("suspiciousRedirect — positives", () => {
  it("flags a cross-domain navigation within 1s", () => {
    const nav = step({ kind: "navigate", timestamp: 1500, url: "https://evil.test/" });
    expect(suspiciousRedirect(nav, [flaggedRead])[0]).toMatchObject({ type: "suspicious_redirect", severity: "medium" });
  });
  it("flags at exactly 1000ms", () => {
    const nav = step({ kind: "navigate", timestamp: 2000, url: "https://evil.test/" });
    expect(suspiciousRedirect(nav, [flaggedRead])).toHaveLength(1);
  });
  it("flags across subdomain-to-other-site hops", () => {
    const nav = step({ kind: "navigate", timestamp: 1100, url: "https://x.other.org/" });
    expect(suspiciousRedirect(nav, [flaggedRead])).toHaveLength(1);
  });
  it("uses the latest page_read, skipping intermediate non-reads", () => {
    const click = step({ kind: "click", timestamp: 1200 });
    const nav = step({ kind: "navigate", timestamp: 1300, url: "https://evil.test/" });
    expect(suspiciousRedirect(nav, [flaggedRead, click])).toHaveLength(1);
  });
});

describe("suspiciousRedirect — negatives", () => {
  it("ignores navigation after more than 1s", () => {
    const nav = step({ kind: "navigate", timestamp: 2001, url: "https://evil.test/" });
    expect(suspiciousRedirect(nav, [flaggedRead])).toEqual([]);
  });
  it("ignores same-domain navigation", () => {
    const nav = step({ kind: "navigate", timestamp: 1100, url: "https://shop.a.test/next" });
    expect(suspiciousRedirect(nav, [flaggedRead])).toEqual([]);
  });
  it("ignores when the page read had no hidden instruction", () => {
    const nav = step({ kind: "navigate", timestamp: 1100, url: "https://evil.test/" });
    expect(suspiciousRedirect(nav, [step({ id: "clean" })])).toEqual([]);
  });
  it("ignores non-navigate steps", () => {
    expect(suspiciousRedirect(step({ kind: "click", timestamp: 1100, url: "https://evil.test/" }), [flaggedRead])).toEqual([]);
  });
  it("ignores when there is no history", () => {
    expect(suspiciousRedirect(step({ kind: "navigate", url: "https://evil.test/" }), [])).toEqual([]);
  });
  it("ignores a low-severity-only read (no hidden_instruction flag type match is still required)", () => {
    const read = step({ id: "r2", flags: [{ ...hidden, type: "cross_domain_data" }] });
    const nav = step({ kind: "navigate", timestamp: 1100, url: "https://evil.test/" });
    expect(suspiciousRedirect(nav, [read])).toEqual([]);
  });
});
