import { isCrossSite } from "../domain.js";
import { findSensitive, maskSensitive } from "../redact.js";
import type { Flag, StepRequest } from "../types.js";

const OUTBOUND_METHODS = new Set(["POST", "PUT", "PATCH"]);

const LABELS = {
  email: "an email address",
  card: "a card-like number",
  api_key: "an API key",
  jwt: "a JWT",
} as const;

/**
 * Flag outbound request bodies that carry emails, Luhn-valid card numbers, API keys or JWTs.
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
  const matches = findSensitive(body);
  if (matches.length === 0) return [];

  const sameSite = pageUrl !== undefined && !isCrossSite(pageUrl, request.url);
  const flags: Flag[] = [];
  const seen = new Set<string>();
  for (const m of matches) {
    const key = `${m.kind}:${m.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const severity = m.kind === "email" && sameSite ? "low" : "critical";
    flags.push({
      type: "sensitive_data_outbound",
      severity,
      message: `Request to ${request.url} carries ${LABELS[m.kind]}`,
      evidence: `${m.kind}: ${maskSensitive(m)}`,
    });
  }
  return flags;
}
