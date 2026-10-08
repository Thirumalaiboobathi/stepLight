/** Maximum stored size of a request body preview, in characters. */
export const MAX_BODY_PREVIEW = 2 * 1024;
/** Maximum stored size of a snapshot, in characters. */
export const MAX_SNAPSHOT_TEXT = 200 * 1024;

/** A sensitive value found in text. */
export interface SensitiveMatch {
  kind: "email" | "card" | "api_key" | "jwt";
  /** The matched text (do not persist unredacted). */
  value: string;
  index: number;
}

const EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,5}\.[A-Za-z]{2,24}/g;
const CARD = /\b(?:\d[ -]?){13,19}\b/g;
const API_KEY =
  /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,200}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,100}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

/**
 * Decode percent-escapes so form-encoded values (`a%40b.co`) are visible to the matchers.
 * Invalid sequences are left as-is.
 * @example decodePercent("a%40b.co") // "a@b.co"
 */
export function decodePercent(text: string): string {
  if (!text.includes("%")) return text;
  return text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (m) => {
    try {
      return decodeURIComponent(m);
    } catch {
      return m;
    }
  });
}

/**
 * Luhn checksum test for card-like digit strings (separators ignored).
 * @example luhnValid("4242 4242 4242 4242") // true
 */
export function luhnValid(input: string): boolean {
  const digits = input.replace(/[ -]/g, "");
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Find emails, Luhn-valid card numbers, API keys and JWTs in text.
 * @example findSensitive("mail me at a@b.co") // [{ kind: "email", ... }]
 */
export function findSensitive(input: string): SensitiveMatch[] {
  const text = decodePercent(input);
  const out: SensitiveMatch[] = [];
  const collect = (re: RegExp, kind: SensitiveMatch["kind"], accept?: (v: string) => boolean) => {
    for (const m of text.matchAll(re)) {
      if (accept && !accept(m[0])) continue;
      out.push({ kind, value: m[0], index: m.index ?? 0 });
    }
  };
  collect(JWT, "jwt");
  collect(API_KEY, "api_key");
  collect(EMAIL, "email");
  collect(CARD, "card", luhnValid);
  return out;
}

/**
 * Replace every sensitive value with `[REDACTED:<kind>]`.
 * @example redactText("key sk-abcdefghijklmnopqrstuv") // "key [REDACTED:api_key]"
 */
export function redactText(text: string): string {
  let out = decodePercent(text);
  out = out.replace(JWT, "[REDACTED:jwt]");
  out = out.replace(API_KEY, "[REDACTED:api_key]");
  out = out.replace(EMAIL, "[REDACTED:email]");
  out = out.replace(CARD, (m) => (luhnValid(m) ? "[REDACTED:card]" : m));
  return out;
}

/**
 * Short masked form of a secret for use as flag evidence, e.g. `sk-a…vwxy`.
 * @example maskValue("sk-abcdefghijklmnop") // "sk-a…mnop"
 */
export function maskValue(value: string): string {
  return value.length <= 8 ? "••••" : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/**
 * Evidence-safe description of a sensitive match: never reveals more than needed to
 * recognise it (email → domain only, card → last 4, key/JWT → short prefix).
 * @example maskSensitive({ kind: "email", value: "jane@example.com", index: 0 }) // "••••@example.com"
 */
export function maskSensitive(match: SensitiveMatch): string {
  const { kind, value } = match;
  if (kind === "email") return `••••${value.slice(value.indexOf("@"))}`;
  if (kind === "card") return `•••• ${value.replace(/\D/g, "").slice(-4)}`;
  return `${value.slice(0, kind === "jwt" ? 3 : 4)}…`;
}

/**
 * Truncate text to a maximum length, appending a marker when cut.
 * @example truncate("abcdef", 3) // "abc…[truncated]"
 */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…[truncated]`;
}

/**
 * Redact then truncate a request body preview to {@link MAX_BODY_PREVIEW}.
 * @example sanitizeBody("email=a@b.co") // "email=[REDACTED:email]"
 */
export function sanitizeBody(body: string): string {
  return redactText(truncate(body, MAX_BODY_PREVIEW));
}

/**
 * Redact then truncate snapshot text to {@link MAX_SNAPSHOT_TEXT}.
 * @example sanitizeSnapshot(pageText)
 */
export function sanitizeSnapshot(text: string): string {
  // Truncate first to bound regex work, then redact. A secret split at the cut point could
  // leave a short fragment; that is an accepted trade-off (see DECISIONS.md).
  return redactText(truncate(text, MAX_SNAPSHOT_TEXT));
}
