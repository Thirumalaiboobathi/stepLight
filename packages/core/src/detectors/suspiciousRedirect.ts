import { isCrossSite, registrableDomain } from "../domain.js";
import type { Flag, Step } from "../types.js";

/** Window after a flagged page read in which a cross-site navigation is suspicious. */
export const REDIRECT_WINDOW_MS = 1000;

/**
 * Flag a `navigate` step to a different registrable domain within 1s of a `page_read`
 * that carried a `hidden_instruction` flag (medium severity).
 * @example suspiciousRedirect(navStep, previousSteps)
 */
export function suspiciousRedirect(step: Step, history: readonly Step[]): Flag[] {
  if (step.kind !== "navigate" || !step.url) return [];
  for (let i = history.length - 1; i >= 0; i--) {
    const prev = history[i]!;
    if (prev.kind !== "page_read") continue;
    const age = step.timestamp - prev.timestamp;
    if (age < 0 || age > REDIRECT_WINDOW_MS) return [];
    if (!prev.flags.some((f) => f.type === "hidden_instruction")) return [];
    if (!isCrossSite(prev.url, step.url)) return [];
    return [
      {
        type: "suspicious_redirect",
        severity: "medium",
        message: `Navigated to ${registrableDomain(step.url)} ${age}ms after reading a page with hidden instructions`,
        evidence: `${prev.url ?? "?"} → ${step.url}`,
      },
    ];
  }
  return [];
}
