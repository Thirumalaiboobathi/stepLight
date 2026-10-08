import { describe, expect, it } from "vitest";
import type { Step } from "@steplight/core";
import { describeStep, firstFlaggedIndex, notableSeverity, offset, shortUrl } from "./format";
import { highlight } from "./components/StepDetail";

const step = (over: Partial<Step>): Step => ({
  id: "s",
  runId: "r",
  index: 0,
  kind: "click",
  timestamp: 0,
  flags: [],
  ...over,
});

describe("format", () => {
  it("shortens urls and drops queries", () => {
    expect(shortUrl("http://a.test/x/y?q=1")).toBe("a.test/x/y");
    expect(shortUrl("http://a.test/")).toBe("a.test");
    expect(shortUrl(undefined)).toBe("");
    expect(shortUrl("garbage")).toBe("garbage");
  });
  it("formats offsets", () => {
    expect(offset(2500, 1000)).toBe("+1.5s");
  });
  it("describes steps", () => {
    expect(describeStep(step({ targetText: "Pay" }))).toBe('Clicked "Pay"');
    expect(
      describeStep(step({ kind: "form_submit", request: { method: "POST", url: "http://x.test/c" } })),
    ).toContain("x.test/c");
  });
});

describe("highlight", () => {
  it("wraps every occurrence of the evidence", () => {
    const out = highlight("a SECRET text and SECRET again", ["SECRET"]);
    expect(out.filter((n) => typeof n === "object")).toHaveLength(2);
  });
  it("returns plain text when there is no evidence", () => {
    expect(highlight("hello", [])).toEqual(["hello"]);
    expect(highlight("hello", ["zzzz"]).filter((n) => typeof n === "object")).toHaveLength(0);
  });
});

describe("notable severity", () => {
  const f = (severity: "low" | "medium" | "high") => ({ severity });
  it("hides low flags from lists", () => {
    expect(notableSeverity([f("low")])).toBeUndefined();
    expect(notableSeverity([])).toBeUndefined();
    expect(notableSeverity([f("low"), f("medium")])).toBe("medium");
    expect(notableSeverity([f("high"), f("low")])).toBe("high");
  });
  it("finds the first step worth looking at", () => {
    expect(firstFlaggedIndex([{ flags: [] }, { flags: [f("low")] }, { flags: [f("high")] }])).toBe(2);
    expect(firstFlaggedIndex([{ flags: [f("low")] }, { flags: [] }])).toBe(0);
    expect(firstFlaggedIndex([])).toBe(0);
  });
});
