import { describe, expect, it } from "vitest";
import { buildDiagnosis, rankSimilar, similarity, type FailureContext } from "./diagnose.js";
import { sanitizeStep } from "./sanitize.js";
import type { DiagnosedElement, Step } from "./types.js";

const el = (over: Partial<DiagnosedElement> = {}): DiagnosedElement => ({
  selector: "button#pay",
  tag: "button",
  text: "Pay",
  visible: true,
  disabled: false,
  inViewport: true,
  pointerEvents: "auto",
  ...over,
});
const ctx = (over: Partial<FailureContext> = {}): FailureContext => ({
  selector: "button#pay",
  valid: true,
  matchCount: 1,
  matches: [el()],
  candidates: [],
  ...over,
});

describe("buildDiagnosis", () => {
  it("explains a selector that matches nothing and suggests similar elements", () => {
    const d = buildDiagnosis(
      ctx({
        selector: "button#pay-now",
        matchCount: 0,
        matches: [],
        candidates: [
          { selector: "button#pay", text: "Pay now", tag: "button" },
          { selector: "a.footer-link", text: "Privacy", tag: "a" },
        ],
      }),
    );
    expect(d.reasons).toEqual(["Selector matched 0 elements"]);
    expect(d.similar[0]).toBe('button#pay — "Pay now"');
    expect(d.similar.join()).not.toContain("footer");
  });
  it("detects a covered element", () => {
    const d = buildDiagnosis(ctx({ matches: [el({ coveredBy: 'div#cookie-banner ("Accept")' })] }));
    expect(d.reasons[0]).toContain("covered by div#cookie-banner");
  });
  it("detects disabled, hidden, off-screen and pointer-events", () => {
    expect(buildDiagnosis(ctx({ matches: [el({ disabled: true })] })).reasons).toEqual(["Element is disabled"]);
    expect(buildDiagnosis(ctx({ matches: [el({ visible: false })] })).reasons[0]).toContain("hidden");
    expect(buildDiagnosis(ctx({ matches: [el({ inViewport: false })] })).reasons[0]).toContain("outside the viewport");
    expect(buildDiagnosis(ctx({ matches: [el({ pointerEvents: "none" })] })).reasons[0]).toContain("pointer-events");
  });
  it("reports ambiguity with several matches", () => {
    const d = buildDiagnosis(
      ctx({ matchCount: 3, matches: [el(), el({ selector: "button.b" }), el({ selector: "button.c" })] }),
    );
    expect(d.reasons[0]).toContain("matched 3 elements");
  });
  it("reports a detached element when the selector worked earlier", () => {
    const d = buildDiagnosis(ctx({ matchCount: 0, matches: [] }), true);
    expect(d.reasons[1]).toContain("no longer in the DOM");
  });
  it("handles engine selectors it cannot evaluate", () => {
    const d = buildDiagnosis(
      ctx({
        selector: "text=Confirm bookng",
        valid: false,
        matchCount: -1,
        matches: [],
        candidates: [{ selector: "button#pay", text: "Confirm booking", tag: "button" }],
      }),
    );
    expect(d.reasons[0]).toContain("Playwright-specific");
    expect(d.similar[0]).toContain("Confirm booking");
  });
  it("says so when the element looks fine", () => {
    expect(buildDiagnosis(ctx()).reasons[0]).toContain("actionable");
  });
});

describe("similarity", () => {
  it("scores identical strings 1 and unrelated strings 0", () => {
    expect(similarity("checkout", "checkout")).toBe(1);
    expect(similarity("checkout", "zzzzzz")).toBe(0);
    expect(similarity("a", "b")).toBe(0);
  });
  it("ranks the closest candidates first and drops weak ones", () => {
    const out = rankSimilar("#submit-order", [
      { selector: "button#submit", text: "Submit order", tag: "button" },
      { selector: "a#help", text: "Help", tag: "a" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("button#submit");
  });
});

describe("sanitizeStep with diagnosis", () => {
  it("redacts secrets in errors and diagnosis text", () => {
    const step: Step = {
      id: "s",
      runId: "r",
      index: 0,
      kind: "click",
      timestamp: 1,
      flags: [],
      error: "failed for jane@example.com",
      diagnosis: {
        selector: "a",
        matchCount: 1,
        reasons: ["covered by x (jane@example.com)"],
        similar: [],
        elements: [el({ text: "mail jane@example.com" })],
      },
    };
    expect(JSON.stringify(sanitizeStep(step))).not.toContain("jane@");
  });
});
