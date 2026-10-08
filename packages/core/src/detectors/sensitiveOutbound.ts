import { isCrossSite } from "../domain.js";
import { describeKind, findSensitive, maskSensitive } from "../redact.js";
import type { Flag, StepRequest } from "../types.js";

const OUTBOUND_METHODS = new Set(["POST", "PUT", "PATCH"]);


/**
 * Flag outbound request bodies that carry emails, Luhn-valid card numbers, API keys, JWTs, private keys,
 * IBANs, SSNs, Aadhaar/PAN numbers (and, when sent to another site, passwords and secret URL parameters).
 * Cards, keys and JWTs are always `critical`. An email is `critical` when sent to a
 * different site than `pageUrl` (or when `pageUrl` is unknown), and only `low` when it
 * goes back to the same site (e.g. a normal login form). Evidence is masked.
 * @example
 * sensitiveOutbound({ method: "POST", url: "https://evil.test/c", bodyPreview: "a@b.co" }, "https://shop.test/")
 */
export function sensitiveOutbound(request: StepRequest, pageUrl?: string): Flag[] {
  if (!OUTBOUND_METHODS.has(request.method.toUpperCase())) return [];
  const body = request.bodyPreview;
  if (!body) return [];
  const sameSite = pageUrl !== undefined && !isCrossSite(pageUrl, request.url);
  // A password in a form that posts back to its own site is just a login; sent elsewhere it is a leak.
  const matches = findSensitive(body, { credentials: !sameSite });
  if (matches.length === 0) return [];
  const flags: Flag[] = [];
  const seen = new Set<string>();
  for (const m of matches) {
    const key = `${m.kind}:${m.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const severity = (m.kind === "email" || m.kind === "phone") && sameSite ? "low" : "critical";
    flags.push({
      type: "sensitive_data_outbound",
      severity,
      message: `Request to ${request.url} carries ${describeKind(m.kind)}`,
      evidence: `${m.kind}: ${maskSensitive(m)}`,
    });
  }
  return flags;
}
