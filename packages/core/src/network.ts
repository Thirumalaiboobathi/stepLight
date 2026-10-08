import { registrableDomain } from "./domain.js";
import { bodyValues, type HistoryPage } from "./detectors/crossDomainData.js";
import { findSensitive, maskSensitive } from "./redact.js";
import type { Flag, Step } from "./types.js";

/* ---------- headers ---------- */

/** The only response headers Steplight ever keeps. Everything else is dropped unseen. */
export const ALLOWED_HEADERS: readonly string[] = ["content-type", "content-length"];

/** Header names that are never kept, even if someone adds them to the allowlist by mistake. */
const NEVER_KEEP = /authori[sz]ation|cookie|token|auth|key|secret|session|password|credential|signature|bearer/i;

/** A header as reported by `chrome.webRequest` (value may be missing for binary headers). */
export interface RawHeader {
  name: string;
  value?: string;
}

/**
 * Keep only `content-type` and `content-length` from a header list. Authorization, Cookie,
 * Set-Cookie, X-API-Key and anything whose name contains token/auth/key/secret/session is
 * never returned, whatever the input.
 * @example pickHeaders([{ name: "Set-Cookie", value: "a=b" }, { name: "Content-Type", value: "text/html" }])
 * // { contentType: "text/html" }
 */
export function pickHeaders(headers: readonly RawHeader[] | undefined): { contentType?: string; contentLength?: number } {
  const out: { contentType?: string; contentLength?: number } = {};
  for (const h of headers ?? []) {
    const name = h.name.toLowerCase();
    if (NEVER_KEEP.test(name) || !ALLOWED_HEADERS.includes(name) || h.value === undefined) continue;
    if (name === "content-type") out.contentType = h.value.split(";")[0]!.trim().slice(0, 100).toLowerCase();
    else {
      const n = Number(h.value);
      if (Number.isFinite(n) && n >= 0) out.contentLength = n;
    }
  }
  return out;
}

/* ---------- request bodies ---------- */

/** The `requestBody` object of `chrome.webRequest.onBeforeRequest` details. */
export interface RawRequestBody {
  raw?: { bytes?: ArrayBuffer; file?: string }[];
  formData?: Record<string, string[]>;
  error?: string;
}

/**
 * Turn a webRequest body into text for analysis. Form data becomes `k=v&k=v` (URL-encoded),
 * raw bytes are decoded as UTF-8 (first `maxChars` characters only). `bytes` is the real size.
 * @example requestBodyText({ formData: { email: ["a@b.co"] } }) // { text: "email=a%40b.co", bytes: 14 }
 */
export function requestBodyText(body: RawRequestBody | undefined, maxChars = 20_000): { text?: string; bytes: number } {
  if (!body || body.error) return { bytes: 0 };
  if (body.formData) {
    const text = Object.entries(body.formData)
      .flatMap(([k, vs]) => vs.map((v) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`))
      .join("&");
    return { text: text.slice(0, maxChars), bytes: text.length };
  }
  let bytes = 0;
  let text = "";
  const decoder = new TextDecoder("utf-8", { fatal: false });
  for (const part of body.raw ?? []) {
    if (!part.bytes) continue;
    bytes += part.bytes.byteLength;
    if (text.length < maxChars) text += decoder.decode(part.bytes.slice(0, maxChars * 4));
  }
  return { ...(bytes > 0 ? { text: text.slice(0, maxChars) } : {}), bytes };
}

/* ---------- URLs ---------- */

/** URL without its query string and fragment (used by the "minimal" capture level). */
export function stripQuery(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return url.split(/[?#]/)[0] ?? "";
  }
}

/** Registrable domain of a URL, treating ws:// and wss:// like http:// and https://. */
export function siteOf(url: string | undefined): string | undefined {
  return registrableDomain(url?.replace(/^ws(s?):/i, "http$1:"));
}

function queryValues(url: string): string[] {
  try {
    return Array.from(new URL(url.replace(/^ws(s?):/i, "http$1:")).searchParams.values());
  } catch {
    return [];
  }
}

function decodedUrlText(url: string): string {
  try {
    const u = new URL(url.replace(/^ws(s?):/i, "http$1:"));
    return decodeURIComponent(`${u.pathname}${u.search}`);
  } catch {
    return url;
  }
}

/* ---------- benign (analytics / CDN) domains ---------- */

/** Registrable domains of common analytics, tag-manager, error-monitoring and CDN services. */
export const BENIGN_DOMAINS: readonly string[] = [
  "google-analytics.com", "googletagmanager.com", "doubleclick.net", "googlesyndication.com",
  "googleadservices.com", "gstatic.com", "googleapis.com", "googleusercontent.com",
  "cloudflare.com", "cloudflareinsights.com", "jsdelivr.net", "unpkg.com", "cdnjs.com",
  "cloudfront.net", "akamaihd.net", "akamaized.net", "fastly.net", "azureedge.net", "bootstrapcdn.com",
  "jquery.com", "fontawesome.com", "typekit.net", "fonts.net",
  "facebook.net", "hotjar.com", "hotjar.io", "segment.io", "segment.com", "mixpanel.com",
  "amplitude.com", "sentry.io", "datadoghq.com", "newrelic.com", "nr-data.net", "clarity.ms",
  "plausible.io", "matomo.cloud", "fullstory.com", "intercom.io", "heapanalytics.com", "posthog.com",
];

/** True when the request's site is in the built-in list or in the user's allowlist. */
export function isBenignDomain(url: string | undefined, allowlist: readonly string[] = []): boolean {
  const site = siteOf(url);
  if (!site) return false;
  let host = "";
  try {
    host = new URL(url!.replace(/^ws(s?):/i, "http$1:")).hostname.toLowerCase();
  } catch {
    /* host stays empty */
  }
  const matches = (d: string): boolean => {
    const entry = d.trim().toLowerCase();
    return entry.length > 0 && (site === entry || host === entry || host.endsWith(`.${entry}`));
  };
  return BENIGN_DOMAINS.some(matches) || allowlist.some(matches);
}

/* ---------- the detector ---------- */

/** Options for {@link networkExfil}. */
export interface NetworkDetectorOptions {
  /** Extra domains the user trusts (they are treated like built-in analytics/CDN domains). */
  allowlist?: readonly string[];
  /** Beacons within this many ms of a hidden-instruction page read are suspicious (default 2000). */
  windowMs?: number;
}

const BEACON_TYPES = new Set(["ping", "image", "websocket", "beacon"]);
const MIN_COPIED_LENGTH = 8;

const LABELS = { email: "an email address", card: "a card-like number", api_key: "an API key", jwt: "a JWT" } as const;

/**
 * Detect data leaving through background requests (fetch, XHR, beacons, pixels, WebSockets).
 * - Sensitive patterns (email, card, key, JWT) anywhere in the URL (path or query) or body: `critical`
 *   (an email is only `low` when it goes back to the page's own site or to a known analytics/CDN domain).
 * - Page text seen earlier (or a form value) sent to a different site: `high`.
 * - A beacon / ping / image / WebSocket to a new third-party domain within 2 s (before or after) of a
 *   page read that carried a hidden instruction: `high`.
 * Requests to the page's own site are ignored unless sensitive data is present. Requests to known
 * analytics/CDN domains (or the user's allowlist) are downgraded to `low`.
 * @example networkExfil(step, history, pages, { allowlist: ["metrics.mycorp.com"] })
 */
export function networkExfil(
  step: Step,
  history: readonly Step[],
  pages: readonly HistoryPage[],
  options: NetworkDetectorOptions = {},
): Flag[] {
  const req = step.request;
  if (!req) return [];
  const target = siteOf(req.url);
  if (!target) return []; // data:, blob:, chrome-extension: …
  const pageSite = siteOf(step.url);
  const third = pageSite !== undefined && pageSite !== target;
  const benign = third && isBenignDomain(req.url, options.allowlist);
  const flags: Flag[] = [];
  const where = req.resourceType === "websocket" ? "WebSocket" : "Request";

  // 1. Sensitive patterns in the URL (pixel / GET exfiltration) or the body.
  const inUrl = findSensitive(decodedUrlText(req.url));
  const inBody = req.bodyPreview ? findSensitive(req.bodyPreview) : [];
  const seen = new Set<string>();
  for (const [place, matches] of [["URL", inUrl], ["body", inBody]] as const) {
    for (const m of matches) {
      const key = `${m.kind}:${m.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const lowEmail = m.kind === "email" && (!third || benign);
      flags.push({
        type: "sensitive_data_outbound",
        severity: lowEmail ? "low" : "critical",
        message: `${where} to ${target} carries ${LABELS[m.kind]} in its ${place}`,
        evidence: `${m.kind}: ${maskSensitive(m)} (${place})`,
      });
    }
  }

  if (!third) return flags;

  // 2. Text copied from an earlier page, sent to another site.
  const sources = pages.filter((p) => p.text && siteOf(p.url) !== target);
  if (sources.length > 0) {
    const candidates = [...(req.bodyPreview ? bodyValues(req.bodyPreview) : []), ...queryValues(req.url)]
      .map((v) => v.trim())
      .filter((v) => v.length >= MIN_COPIED_LENGTH && !/^https?:\/\//i.test(v) && v !== step.url);
    const leaked = [...new Set(candidates)].filter((v) => {
      const needle = v.toLowerCase();
      return sources.some((p) => p.text.toLowerCase().includes(needle));
    });
    if (leaked.length > 0) {
      const shown = leaked.slice(0, 3).map((v) => (v.length > 40 ? `${v.slice(0, 40)}…` : v));
      flags.push({
        type: "cross_domain_data",
        severity: benign ? "low" : "high",
        message: `Data from an earlier page was sent to a different domain (${target})`,
        evidence: shown.join(" | "),
      });
    }
  }

  // 3. A beacon-style request to a brand-new domain right after a hidden instruction was read.
  if (req.resourceType && BEACON_TYPES.has(req.resourceType)) {
    const windowMs = options.windowMs ?? 2000;
    const known = new Set<string | undefined>();
    for (const s of history) {
      known.add(siteOf(s.url));
      if (s.request) known.add(siteOf(s.request.url));
    }
    if (!known.has(target)) {
      // The request may come just before the page is read (page-load beacons fire before the
      // content script reports the page) or just after it, so the window works both ways.
      const trigger = [...history]
        .reverse()
        .find(
          (s) =>
            s.kind === "page_read" &&
            Math.abs(step.timestamp - s.timestamp) <= windowMs &&
            s.flags.some((f) => f.type === "hidden_instruction" && f.severity !== "low"),
        );
      if (trigger) {
        flags.push({
          type: "cross_domain_data",
          severity: benign ? "low" : "high",
          message: `${where} (${req.resourceType}) to a new third-party domain (${target}) within ${windowMs / 1000} s of a page with a hidden instruction`,
          evidence: `${req.resourceType} → ${target}, ${Math.abs(step.timestamp - trigger.timestamp)} ms ${step.timestamp >= trigger.timestamp ? "after" : "before"} the hidden instruction on step #${trigger.index}`,
        });
      }
    }
  }
  return flags;
}
