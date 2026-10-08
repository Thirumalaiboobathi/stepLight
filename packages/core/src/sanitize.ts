import { redactText, sanitizeBody } from "./redact.js";
import type { Step } from "./types.js";

/**
 * Return a copy of the step that is safe to write to disk: bodies redacted and
 * truncated, free-text fields redacted.
 * @example const safe = sanitizeStep(step)
 */
export function sanitizeStep(step: Step): Step {
  const copy: Step = { ...step, flags: step.flags.map((f) => ({ ...f })) };
  if (copy.request) {
    copy.request = { ...copy.request, url: redactText(copy.request.url) };
    if (copy.request.bodyPreview !== undefined) {
      copy.request.bodyPreview = sanitizeBody(copy.request.bodyPreview);
    }
  }
  if (copy.targetText !== undefined) copy.targetText = redactText(copy.targetText).slice(0, 300);
  if (copy.url !== undefined) copy.url = redactText(copy.url);
  if (copy.error !== undefined) copy.error = redactText(copy.error).slice(0, 1000);
  if (copy.diagnosis) {
    const d = copy.diagnosis;
    copy.diagnosis = {
      ...d,
      selector: redactText(d.selector).slice(0, 300),
      reasons: d.reasons.map((r) => redactText(r).slice(0, 400)),
      similar: d.similar.map((r) => redactText(r).slice(0, 200)),
      elements: d.elements.map((e) => ({
        ...e,
        text: redactText(e.text).slice(0, 80),
        coveredBy: e.coveredBy === undefined ? undefined : redactText(e.coveredBy).slice(0, 120),
      })),
    };
  }
  for (const f of copy.flags) {
    f.evidence = redactText(f.evidence);
    f.message = redactText(f.message);
  }
  return copy;
}
