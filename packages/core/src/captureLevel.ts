import { sanitizeBody, sanitizeSnapshot } from "./redact.js";
import type { CaptureLevel } from "./settings.js";
import { stripQuery } from "./network.js";
import type { Step } from "./types.js";

/**
 * Data minimisation: shape a step (and its page text) for storage according to the capture level.
 * Detectors run on the full data in memory first; only what this returns is written down.
 * - `minimal`: URLs lose their query strings; step kind, selector, token numbers and flags are kept;
 *   no page text, target text, error text, diagnosis or request details beyond method + URL.
 * - `standard`: redacted page text and request metadata (type, status, sizes); no request bodies.
 * - `full`: also a redacted request body preview.
 * The result is a copy; the input is not modified.
 * @example const { step: safe, snapshot } = applyCaptureLevel(step, pageText, "standard")
 */
export function applyCaptureLevel(step: Step, snapshot: string | undefined, level: CaptureLevel): { step: Step; snapshot?: string } {
  const out: Step = { ...step };
  if (level === "minimal") {
    if (out.url) out.url = stripQuery(out.url);
    delete out.targetText;
    delete out.diagnosis;
    delete out.error;
    delete out.snapshotRef;
    if (out.request) out.request = { method: out.request.method, url: stripQuery(out.request.url) };
    return { step: out };
  }
  if (out.request) {
    const req = { ...out.request };
    if (level === "full" && req.bodyPreview !== undefined) req.bodyPreview = sanitizeBody(req.bodyPreview);
    else delete req.bodyPreview; // "standard": the body was analysed in memory and is not kept
    out.request = req;
  }
  return { step: out, ...(snapshot !== undefined ? { snapshot: sanitizeSnapshot(snapshot) } : {}) };
}
