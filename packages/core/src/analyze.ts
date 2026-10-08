import { crossDomainData, type HistoryPage } from "./detectors/crossDomainData.js";
import { sensitiveOutbound } from "./detectors/sensitiveOutbound.js";
import { stuckLoop } from "./detectors/stuckLoop.js";
import { suspiciousRedirect } from "./detectors/suspiciousRedirect.js";
import type { Flag, Step } from "./types.js";

/**
 * Run the request/navigation detectors for a step against the run history.
 * (Page-content detection is done separately with `hiddenInstruction`.)
 * @example step.flags.push(...analyzeStep(step, previousSteps, pages))
 */
export function analyzeStep(
  step: Step,
  history: readonly Step[],
  pages: readonly HistoryPage[],
): Flag[] {
  const flags: Flag[] = [];
  if (step.request) flags.push(...sensitiveOutbound(step.request, step.url));
  flags.push(...crossDomainData(step, pages));
  flags.push(...suspiciousRedirect(step, history));
  flags.push(...stuckLoop(step, history));
  return flags;
}

const ACTION_KINDS = new Set(["click", "type", "form_submit"]);
const STOP_WORDS = new Set(["the", "this", "that", "with", "option", "button", "select", "click"]);

function words(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []) {
    if (!STOP_WORDS.has(w)) out.add(w);
  }
  return out;
}

/**
 * Guess which earlier step caused this one: an action (click/type/submit) whose target
 * text overlaps the evidence of the most recent page read that had a hidden instruction.
 * Returns that page_read's step id, or undefined.
 * @example step.causedBy = inferCausedBy(step, history)
 */
export function inferCausedBy(step: Step, history: readonly Step[]): string | undefined {
  if (!ACTION_KINDS.has(step.kind)) return undefined;
  const target = words(`${step.targetText ?? ""} ${step.targetSelector ?? ""}`);
  if (target.size === 0) return undefined;
  for (let i = history.length - 1; i >= 0; i--) {
    const prev = history[i]!;
    if (prev.kind !== "page_read") continue;
    for (const flag of prev.flags) {
      if (flag.type !== "hidden_instruction" || flag.severity === "low") continue;
      const evidence = words(flag.evidence);
      for (const w of target) if (evidence.has(w)) return prev.id;
    }
    return undefined;
  }
  return undefined;
}
