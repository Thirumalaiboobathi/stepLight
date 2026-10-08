/**
 * How much Steplight keeps.
 * - `minimal`: URLs (query strings stripped), step kinds and flags only. No page text, no request metadata beyond the URL, no bodies.
 * - `standard` (default): also redacted page text and request metadata (method, type, status, sizes). No request bodies.
 * - `full`: also redacted request body previews. Opt-in.
 */
export type CaptureLevel = "minimal" | "standard" | "full";

/** All capture levels, least to most data. */
export const CAPTURE_LEVELS: readonly CaptureLevel[] = ["minimal", "standard", "full"];

/** User-editable settings. Every field has a safe default; see {@link normalizeSettings}. */
export interface Settings {
  captureLevel: CaptureLevel;
  /** Hook fetch/XHR/sendBeacon/WebSocket inside pages ("Deep capture"). Off by default. */
  deepCapture: boolean;
  /** Third-party domains the user trusts for network-exfiltration checks (downgraded to low). */
  networkAllowlist: string[];
  /** When non-empty, only these domains are ever recorded. */
  siteAllowlist: string[];
  /** These domains are never recorded ("Recording paused on this site"). */
  siteDenylist: string[];
  /** Extra redaction patterns (regular expressions, validated against ReDoS). */
  customPatterns: string[];
  /** Runs older than this many days are deleted automatically. 0 disables age-based deletion. */
  retentionDays: number;
  /** Upper bound for stored data in the extension, in megabytes. */
  maxStorageMB: number;
  /** Show a small "Steplight is recording" badge in the corner of recorded pages. */
  pageIndicator: boolean;
  /** Set once the user has seen the first-run privacy suggestions. */
  firstRunDone: boolean;
}

/** Safe defaults: standard capture, no deep hooks, 7 days of retention. */
export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  captureLevel: "standard",
  deepCapture: false,
  networkAllowlist: [],
  siteAllowlist: [],
  siteDenylist: [],
  customPatterns: [],
  retentionDays: 7,
  maxStorageMB: 8,
  pageIndicator: true,
  firstRunDone: false,
});

/**
 * Domains offered on first run for the deny list: sites where a recording is rarely a good
 * idea (banking, health portals, password managers). Suggestions only; the user decides.
 */
export const SUGGESTED_DENYLIST: readonly string[] = [
  "*.bank", "chase.com", "bankofamerica.com", "wellsfargo.com", "citi.com", "capitalone.com",
  "hsbc.com", "barclays.co.uk", "paypal.com", "hdfcbank.com", "icicibank.com", "onlinesbi.sbi",
  "mychart.com", "myhealth.va.gov", "patient.info", "1password.com", "lastpass.com", "bitwarden.com",
  "dashlane.com", "my.1password.com",
];

const DOMAIN = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const MAX_LIST = 200;

/** Clean a list of domain entries: lowercase, trim, drop invalid and duplicate entries. */
export function normalizeDomainList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const d = item.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[/:?#].*$/, "");
    if (d.length === 0 || d.length > 253 || !DOMAIN.test(d) || out.includes(d)) continue;
    out.push(d);
    if (out.length >= MAX_LIST) break;
  }
  return out;
}

const intInRange = (v: unknown, min: number, max: number, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback;

/**
 * Turn untrusted stored/user input into valid settings. Unknown or malformed fields fall back to
 * the safe defaults; this never throws. Custom patterns are returned unchecked here — callers
 * validate them with `validatePattern` (in redact) before use.
 * @example normalizeSettings({ captureLevel: "full" }).captureLevel // "full"
 */
export function normalizeSettings(raw: unknown): Settings {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_SETTINGS;
  return {
    captureLevel: CAPTURE_LEVELS.includes(r["captureLevel"] as CaptureLevel) ? (r["captureLevel"] as CaptureLevel) : d.captureLevel,
    deepCapture: r["deepCapture"] === true,
    networkAllowlist: normalizeDomainList(r["networkAllowlist"]),
    siteAllowlist: normalizeDomainList(r["siteAllowlist"]),
    siteDenylist: normalizeDomainList(r["siteDenylist"]),
    customPatterns: Array.isArray(r["customPatterns"])
      ? (r["customPatterns"] as unknown[]).filter((p): p is string => typeof p === "string" && p.length > 0 && p.length <= 200).slice(0, 50)
      : [],
    retentionDays: intInRange(r["retentionDays"], 0, 3650, d.retentionDays),
    maxStorageMB: intInRange(r["maxStorageMB"], 1, 1024, d.maxStorageMB),
    pageIndicator: r["pageIndicator"] !== false,
    firstRunDone: r["firstRunDone"] === true,
  };
}

/** Does a domain entry (`example.com` or `*.example.com`) cover this host? */
export function domainMatches(entry: string, host: string): boolean {
  const h = host.toLowerCase();
  if (entry.startsWith("*.")) {
    const base = entry.slice(2);
    return h === base || h.endsWith(`.${base}`);
  }
  return h === entry || h.endsWith(`.${entry}`);
}

/** Why a URL may not be recorded, or undefined when recording is allowed. */
export function recordingBlockedReason(url: string | undefined, settings: Pick<Settings, "siteAllowlist" | "siteDenylist">): string | undefined {
  let host: string;
  try {
    const u = new URL(url ?? "");
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    host = u.hostname;
  } catch {
    return undefined;
  }
  if (settings.siteDenylist.some((e) => domainMatches(e, host))) return "Recording paused on this site (deny list)";
  if (settings.siteAllowlist.length > 0 && !settings.siteAllowlist.some((e) => domainMatches(e, host))) {
    return "Recording paused on this site (not on your allow list)";
  }
  return undefined;
}
