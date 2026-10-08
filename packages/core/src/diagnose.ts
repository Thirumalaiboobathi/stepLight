/* eslint-disable @typescript-eslint/no-explicit-any */
import type { DiagnosedElement, FailureDiagnosis } from "./types.js";

/** An interactive element on the page that could have been the intended target. */
export interface Candidate {
  selector: string;
  text: string;
  tag: string;
}

/** Raw facts gathered inside the page when an action on `selector` failed. */
export interface FailureContext {
  selector: string;
  /** False when the selector is not plain CSS (e.g. a Playwright-only engine). */
  valid: boolean;
  matchCount: number;
  /** Up to 5 matched elements. */
  matches: DiagnosedElement[];
  candidates: Candidate[];
}

/**
 * Gather failure facts from the live page for a selector: how many elements match, and for each
 * of the first few whether it is hidden, disabled, covered by another element or off-screen.
 * MUST stay self-contained (serialised by Playwright with `toString()`). Understands CSS and
 * the `text=...` engine; other engines are reported as not evaluable.
 * @example const ctx = await page.evaluate(collectFailureContext, "button#pay")
 */
export function collectFailureContext(selector: string): FailureContext {
  const doc: any = (globalThis as any).document;
  const win: any = globalThis;
  const selectorOf = (el: any): string => {
    const tag = String(el.tagName).toLowerCase();
    if (el.id) return `${tag}#${el.id}`;
    const name = el.getAttribute && el.getAttribute("name");
    if (name) return `${tag}[name="${name}"]`;
    const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/)[0] : "";
    return cls ? `${tag}.${cls}` : tag;
  };
  const textOf = (el: any): string =>
    String(el.getAttribute("aria-label") || el.innerText || el.value || el.textContent || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);

  let valid = true;
  let nodes: any[] = [];
  try {
    nodes = Array.from(doc.querySelectorAll(selector));
  } catch {
    valid = false;
    const m = /^text=(?:"([^"]*)"|'([^']*)'|(.*))$/i.exec(selector.trim());
    if (m) {
      valid = true;
      const wanted = String(m[1] ?? m[2] ?? m[3] ?? "").trim().toLowerCase();
      nodes = Array.from(doc.querySelectorAll("a,button,input,select,textarea,label,[role=button],h1,h2,h3,p,span,li")).filter(
        (e: any) => wanted.length > 0 && textOf(e).toLowerCase().includes(wanted),
      );
    }
  }

  const matches = nodes.slice(0, 5).map((el: any): DiagnosedElement => {
    const cs = win.getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const visible =
      r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && parseFloat(cs.opacity) > 0;
    const disabled =
      Boolean(el.disabled) || el.getAttribute("aria-disabled") === "true" || Boolean(el.closest && el.closest("fieldset[disabled]"));
    const inViewport = r.bottom > 0 && r.right > 0 && r.top < win.innerHeight && r.left < win.innerWidth;
    let coveredBy: string | undefined;
    if (visible && inViewport) {
      const cx = Math.min(Math.max(r.left + r.width / 2, 0), win.innerWidth - 1);
      const cy = Math.min(Math.max(r.top + r.height / 2, 0), win.innerHeight - 1);
      const top: any = doc.elementFromPoint(cx, cy);
      if (top && top !== el && !el.contains(top) && !top.contains(el)) {
        const t = textOf(top);
        coveredBy = t ? `${selectorOf(top)} ("${t.slice(0, 40)}")` : selectorOf(top);
      }
    }
    return {
      selector: selectorOf(el),
      tag: String(el.tagName).toLowerCase(),
      text: textOf(el),
      visible,
      disabled,
      inViewport,
      pointerEvents: cs.pointerEvents,
      coveredBy,
    };
  });

  const candidates: Candidate[] = Array.from(
    doc.querySelectorAll("a,button,input,select,textarea,[role=button],[onclick],summary"),
  )
    .slice(0, 300)
    .map((el: any) => ({ selector: selectorOf(el), text: textOf(el), tag: String(el.tagName).toLowerCase() }));

  return { selector, valid, matchCount: valid ? nodes.length : -1, matches, candidates };
}

function bigrams(s: string): Map<string, number> {
  const t = s.toLowerCase().replace(/\s+/g, " ").trim();
  const out = new Map<string, number>();
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/**
 * Sørensen–Dice similarity of two strings on character bigrams (0–1).
 * @example similarity("pay-btn", "button#pay") // ≈ 0.4
 */
export function similarity(a: string, b: string): number {
  const x = bigrams(a);
  const y = bigrams(b);
  let overlap = 0;
  let total = 0;
  for (const n of x.values()) total += n;
  for (const n of y.values()) total += n;
  if (total === 0) return 0;
  for (const [g, n] of x) overlap += Math.min(n, y.get(g) ?? 0);
  return (2 * overlap) / total;
}

/** Strip selector syntax so only the meaningful words remain. */
function needleOf(selector: string): string {
  return selector
    .replace(/^(text|css|xpath|id|role)=/i, "")
    .replace(/[#.[\]="'>:()*~+]/g, " ")
    .replace(/\b(nth-child|nth|first|last)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Rank page elements by how similar they are to the failing selector, comparing against both
 * their selector and visible text. Returns up to `limit` entries like `button#pay — "Pay now"`.
 * @example rankSimilar("button#pay-now", candidates) // ['button#pay — "Pay"']
 */
export function rankSimilar(selector: string, candidates: readonly Candidate[], limit = 5): string[] {
  const needle = needleOf(selector);
  if (!needle) return [];
  return candidates
    .map((c) => ({
      c,
      score: Math.max(similarity(needle, needleOf(c.selector)), c.text ? similarity(needle, c.text) : 0),
    }))
    .filter((r) => r.score >= 0.35 && r.c.selector !== selector)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ c }) => (c.text ? `${c.selector} — "${c.text}"` : c.selector));
}

/**
 * Turn raw page facts into a readable diagnosis.
 * @param previouslySeen true if this selector worked earlier in the run (so "gone" means detached).
 * @example const d = buildDiagnosis(ctx)
 */
export function buildDiagnosis(ctx: FailureContext, previouslySeen = false): FailureDiagnosis {
  const reasons: string[] = [];
  if (!ctx.valid) {
    reasons.push("Selector uses a Playwright-specific engine that could not be evaluated here; showing similar elements instead");
  } else if (ctx.matchCount === 0) {
    reasons.push("Selector matched 0 elements");
    if (previouslySeen) reasons.push("An element with this selector existed earlier in the run but is no longer in the DOM (detached or re-rendered)");
  } else if (ctx.matchCount > 1) {
    reasons.push(`Selector matched ${ctx.matchCount} elements (ambiguous: strict mode would refuse to pick one)`);
  }
  const actionable: string[] = [];
  for (const el of ctx.matches) {
    const label = ctx.matchCount > 1 ? ` (${el.selector})` : "";
    if (!el.visible) reasons.push(`Element is hidden or has no size${label}`);
    if (el.disabled) reasons.push(`Element is disabled${label}`);
    if (el.coveredBy) reasons.push(`Element is covered by ${el.coveredBy}${label}`);
    if (el.visible && !el.inViewport) reasons.push(`Element is outside the viewport and needs scrolling${label}`);
    if (el.pointerEvents === "none") reasons.push(`Element has pointer-events: none${label}`);
    if (el.visible && !el.disabled && !el.coveredBy && el.inViewport && el.pointerEvents !== "none") actionable.push(el.selector);
  }
  if (reasons.length === 0 && ctx.matchCount === 1 && actionable.length === 1) {
    reasons.push("Element looks actionable now; the failure may be timing (animation, late render) or the page changed after the error");
  }
  const similar = ctx.matchCount === 0 || !ctx.valid ? rankSimilar(ctx.selector, ctx.candidates) : [];
  return {
    selector: ctx.selector,
    matchCount: ctx.matchCount,
    elements: ctx.matches,
    reasons,
    similar,
  };
}
