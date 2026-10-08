import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ibanCheckDigits, verhoeffAppend } from "./checksums.js";
import { findSensitive, redactText, sanitizeSnapshot } from "./redact.js";

/* Property-based tests: random surroundings, generated secrets, many encodings. */

const NUM_RUNS = 250;

const digit = fc.integer({ min: 0, max: 9 }).map(String);
const digits = (n: number) => fc.array(digit, { minLength: n, maxLength: n }).map((a) => a.join(""));
const alnum = (n: number, chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789") =>
  fc.array(fc.constantFrom(...chars), { minLength: n, maxLength: n }).map((a) => a.join(""));

/** Luhn-valid 16-digit card number (first digit 3–6). */
const card = fc
  .tuple(fc.integer({ min: 3, max: 6 }).map(String), digits(14))
  .map(([lead, body]) => {
    const partial = lead + body;
    for (let c = 0; c < 10; c++) {
      const candidate = partial + c;
      let sum = 0;
      for (let i = candidate.length - 1, dbl = false; i >= 0; i--, dbl = !dbl) {
        let d = Number(candidate[i]);
        if (dbl) {
          d *= 2;
          if (d > 9) d -= 9;
        }
        sum += d;
      }
      if (sum % 10 === 0) return candidate;
    }
    return partial + "0";
  });

const email = fc
  .tuple(alnum(6, "abcdefghijklmnopqrstuvwxyz0123456789"), fc.constantFrom("example.com", "mail.test.org", "corp.co.uk"))
  .map(([user, host]) => `${user}@${host}`);

const secrets = {
  email,
  card,
  openai: alnum(30).map((s) => `sk-${s}`),
  aws: alnum(16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789").map((s) => `AKIA${s}`),
  github: alnum(36).map((s) => `ghp_${s}`),
  jwt: fc.tuple(alnum(14), alnum(14), alnum(14)).map(([a, b, c]) => `eyJ${a}.eyJ${b}.${c}`),
  ssn: fc.tuple(fc.integer({ min: 100, max: 665 }), fc.integer({ min: 10, max: 99 }), fc.integer({ min: 1000, max: 9999 })).map(([a, b, c]) => `${a}-${b}-${c}`),
  aadhaar: fc
    .tuple(fc.integer({ min: 2, max: 9 }).map(String), digits(10))
    .map(([lead, rest]) => verhoeffAppend(lead + rest))
    .map((n) => `Aadhaar ${n}`),
  pan: fc
    .tuple(alnum(3, "ABCDEFGHIJKLMNOPQRSTUVWXYZ"), fc.constantFrom(..."ABCFGHLJPT"), alnum(1, "ABCDEFGHIJKLMNOPQRSTUVWXYZ"), digits(4), alnum(1, "ABCDEFGHIJKLMNOPQRSTUVWXYZ"))
    .map((p) => p.join("")),
  iban: digits(18).map((bban) => `GB${ibanCheckDigits("GB", bban)}${bban}`),
  indianMobile: fc.tuple(fc.integer({ min: 6, max: 9 }).map(String), digits(9)).map(([a, b]) => a + b),
  password: alnum(10).map((v) => `password=${v}`),
};

/** What must disappear for each generated secret (the part that is actually sensitive). */
const core = (kind: string, value: string): string => (kind === "password" ? value.slice("password=".length) : kind === "aadhaar" ? value.slice("Aadhaar ".length) : value);

/** Benign text around a secret: letters, spaces, punctuation and a few words that look risky but are not. */
const filler = fc.array(fc.constantFrom("the ", "price ", "is ", "₹1,499 ", "order ", "of ", "lamp, ", "see ", "page ", "– ", "(", ") ", "\n", "x=1&", "a.b "), { maxLength: 12 }).map((a) => a.join(""));

const encoders: Record<string, (s: string) => string> = {
  plain: (s) => s,
  percent: (s) => encodeURIComponent(s),
  "double percent": (s) => encodeURIComponent(encodeURIComponent(s)),
  base64: (s) => `blob=${Buffer.from(`data ${s} end`).toString("base64")} `,
  "json escape": (s) => s.replace(/[@\-.]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`),
};

describe("planted secrets never survive redaction", () => {
  for (const [kind, gen] of Object.entries(secrets)) {
    for (const [encName, encode] of Object.entries(encoders)) {
      if (encName === "json escape" && !["email", "openai", "github", "ssn", "iban"].includes(kind)) continue;
      if (encName === "base64" && kind === "indianMobile") continue; // phones are not detected inside base64
      it(`${kind} (${encName})`, () => {
        fc.assert(
          fc.property(filler, gen, filler, (before, secret, after) => {
            const text = before + encode(secret) + after;
            const out = redactText(text);
            const needle = core(kind, secret);
            expect(out).not.toContain(needle);
            expect(out).not.toContain(encodeURIComponent(needle));
            expect(out).toContain("[REDACTED:");
          }),
          { numRuns: NUM_RUNS },
        );
      });
    }
  }
});

describe("redaction invariants on arbitrary text", () => {
  it("never throws and is idempotent", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), (text) => {
        const once = redactText(text);
        expect(redactText(once)).toBe(once);
      }),
      { numRuns: 1000 },
    );
  });

  it("is idempotent on text with planted secrets in any encoding", () => {
    fc.assert(
      fc.property(filler, fc.oneof(...Object.values(secrets)), fc.constantFrom(...Object.keys(encoders)), filler, (a, secret, enc, b) => {
        const once = redactText(a + encoders[enc]!(secret) + b);
        expect(redactText(once)).toBe(once);
      }),
      { numRuns: 500 },
    );
  });

  it("leaves text without any findings untouched (no decoding side effects)", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z ,.]{0,80}$/), (text) => {
        expect(redactText(text)).toBe(text);
      }),
      { numRuns: 500 },
    );
  });

  it("output length stays bounded: each finding adds at most a short marker", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 600 }), (text) => {
        const out = redactText(text);
        const markers = (out.match(/\[REDACTED:/g) ?? []).length;
        expect(out.length).toBeLessThanOrEqual(text.length + 30 * markers + 5);
      }),
      { numRuns: 500 },
    );
  });

  it("findSensitive agrees: whatever redactText removes as a detector kind is reported", () => {
    fc.assert(
      fc.property(filler, fc.oneof(secrets.email, secrets.card, secrets.openai, secrets.ssn), filler, (a, secret, b) => {
        expect(findSensitive(a + secret + b).length).toBeGreaterThan(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("sanitizeSnapshot on huge hostile input stays fast", () => {
    fc.assert(
      fc.property(fc.constantFrom("1 ", "a@", "sk-", "=", "%4", "AAAA", "eyJ.", "-----BEGIN ", " 9"), (unit) => {
        const text = unit.repeat(Math.ceil(300_000 / unit.length));
        const start = performance.now();
        sanitizeSnapshot(text);
        expect(performance.now() - start).toBeLessThan(1500);
      }),
      { numRuns: 9 },
    );
  });
});
