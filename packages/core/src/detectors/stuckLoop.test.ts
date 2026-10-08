import { describe, expect, it } from "vitest";
import { analyzeStep } from "../analyze.js";
import type { Step } from "../types.js";
import { stuckLoop } from "./stuckLoop.js";

let n = 0;
const step = (over: Partial<Step>): Step => ({
  id: `s${n++}`,
  runId: "r",
  index: n,
  kind: "click",
  timestamp: n * 100,
  url: "https://shop.test/cart",
  targetSelector: "button#pay",
  flags: [],
  ...over,
});

/** Feed steps through the detector as the recorder does, attaching flags. */
function feed(steps: Step[]): Step[] {
  const history: Step[] = [];
  for (const s of steps) {
    s.flags.push(...stuckLoop(s, history));
    history.push(s);
  }
  return history;
}

const note = () => step({ kind: "agent_note", targetSelector: undefined });
const read = () => step({ kind: "page_read", targetSelector: undefined });

describe("stuckLoop — positives", () => {
  it("flags the same click on the same page 3 times in a row", () => {
    const h = feed([step({}), step({}), step({})]);
    expect(h[2]!.flags[0]).toMatchObject({ type: "stuck_loop", severity: "medium" });
    expect(h[2]!.flags[0]!.message).toContain("button#pay");
  });
  it("flags 3 repeats within 6 steps even with other steps in between", () => {
    const h = feed([step({}), read(), step({}), note(), step({})]);
    expect(h[4]!.flags.map((f) => f.type)).toContain("stuck_loop");
  });
  it("flags repeated typing into the same field", () => {
    const typing = () => step({ kind: "type", targetSelector: "input#q" });
    const h = feed([typing(), typing(), typing()]);
    expect(h[2]!.flags).toHaveLength(1);
  });
  it("flags a page navigated to 4 times (ignoring query and hash)", () => {
    const nav = (q: string) =>
      step({ kind: "navigate", targetSelector: undefined, url: `https://shop.test/list${q}` });
    const h = feed([nav(""), read(), nav("?a=1"), nav("#top"), nav("/")]);
    expect(h.at(-1)!.flags[0]!.message).toContain("visited");
  });
  it("includes the failing error in the evidence", () => {
    const failing = () => step({ error: "Timeout 800ms exceeded.\nCall log: ..." });
    const h = feed([failing(), failing(), failing()]);
    expect(h[2]!.flags[0]!.evidence).toContain("Timeout 800ms exceeded.");
  });
  it("is wired into analyzeStep", () => {
    const h = [step({}), step({})];
    expect(analyzeStep(step({}), h, []).map((f) => f.type)).toContain("stuck_loop");
  });
});

describe("stuckLoop — negatives", () => {
  it("does not flag two repeats", () => {
    expect(feed([step({}), step({})]).flatMap((s) => s.flags)).toEqual([]);
  });
  it("does not flag the same selector on different pages (pagination)", () => {
    const h = feed([
      step({ url: "https://shop.test/p1" }),
      step({ url: "https://shop.test/p2" }),
      step({ url: "https://shop.test/p3" }),
    ]);
    expect(h.flatMap((s) => s.flags)).toEqual([]);
  });
  it("does not flag different selectors", () => {
    const h = feed([
      step({ targetSelector: "a#a" }),
      step({ targetSelector: "a#b" }),
      step({ targetSelector: "a#c" }),
    ]);
    expect(h.flatMap((s) => s.flags)).toEqual([]);
  });
  it("does not flag repeats spread over more than 6 steps", () => {
    const h = feed([
      step({}),
      note(), note(), note(), note(), note(),
      step({}),
      note(), note(), note(), note(), note(),
      step({}),
    ]);
    expect(h.flatMap((s) => s.flags)).toEqual([]);
  });
  it("does not flag repeated page reads or only 3 visits to a page", () => {
    expect(feed([read(), read(), read(), read()]).flatMap((s) => s.flags)).toEqual([]);
    const nav = () => step({ kind: "navigate", targetSelector: undefined, url: "https://shop.test/a" });
    expect(feed([nav(), nav(), nav()]).flatMap((s) => s.flags)).toEqual([]);
  });
  it("does not flag actions without a selector", () => {
    const h = feed([
      step({ targetSelector: undefined }),
      step({ targetSelector: undefined }),
      step({ targetSelector: undefined }),
    ]);
    expect(h.flatMap((s) => s.flags)).toEqual([]);
  });
  it("reports a streak once, not on every further repeat", () => {
    const h = feed([step({}), step({}), step({}), step({}), step({})]);
    expect(h.map((s) => s.flags.length)).toEqual([0, 0, 1, 0, 0]);
  });
});
