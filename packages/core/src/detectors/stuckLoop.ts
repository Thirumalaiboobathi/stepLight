import type { Flag, Step } from "../types.js";

/** How many identical actions inside the window count as "stuck". */
export const LOOP_REPEATS = 3;
/** Number of most recent steps (including the current one) examined. */
export const LOOP_WINDOW = 6;
/** Visits to the same URL that count as "stuck". */
export const REVISIT_LIMIT = 4;

const ACTIONS = new Set(["click", "type", "form_submit"]);

/** URL without hash, query string and trailing slash, for revisit counting. */
function pageKey(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url;
  }
}

function actionKey(s: Pick<Step, "kind" | "url" | "targetSelector">): string | undefined {
  if (!ACTIONS.has(s.kind) || !s.targetSelector) return undefined;
  return `${s.kind}|${pageKey(s.url) ?? ""}|${s.targetSelector}`;
}

/**
 * Flag an agent that appears stuck: the same action (kind + page + selector) at least 3 times
 * within the last 6 steps, or the same page navigated to at least 4 times. Reported once per
 * streak (not again while the previous step of the streak already carries the flag).
 * Different pages, different selectors or widely spaced repeats are not flagged.
 * @example stuckLoop(thirdClick, [firstClick, secondClick]) // → [{ type: "stuck_loop", ... }]
 */
export function stuckLoop(step: Step, history: readonly Step[]): Flag[] {
  const recent = [...history.slice(-(LOOP_WINDOW - 1)), step];
  const key = actionKey(step);
  if (key) {
    const same = recent.filter((s) => actionKey(s) === key);
    if (same.length >= LOOP_REPEATS) {
      const alreadyFlagged = same.slice(0, -1).some((s) => s.flags.some((f) => f.type === "stuck_loop"));
      if (alreadyFlagged) return [];
      return [
        {
          type: "stuck_loop",
          severity: "medium",
          message: `Agent appears stuck: ${step.kind} on ${step.targetSelector} repeated ${same.length}× in the last ${recent.length} steps`,
          evidence: `${step.kind} ${step.targetSelector} @ ${pageKey(step.url) ?? "?"}${step.error ? ` (failing: ${step.error.split("\n")[0]!.slice(0, 120)})` : ""}`,
        },
      ];
    }
  }
  if (step.kind === "navigate") {
    const target = pageKey(step.url);
    if (!target) return [];
    const visits = [...history, step].filter((s) => s.kind === "navigate" && pageKey(s.url) === target);
    if (visits.length >= REVISIT_LIMIT) {
      const already = visits.slice(0, -1).some((s) => s.flags.some((f) => f.type === "stuck_loop"));
      if (already) return [];
      return [
        {
          type: "stuck_loop",
          severity: "medium",
          message: `Agent appears stuck: visited ${target} ${visits.length} times`,
          evidence: `navigate ${target} ×${visits.length}`,
        },
      ];
    }
  }
  return [];
}
