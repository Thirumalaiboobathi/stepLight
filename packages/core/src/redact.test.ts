import { afterEach, describe, expect, it } from "vitest";
import { ibanCheckDigits, ibanValid, verhoeffAppend, verhoeffValid } from "./checksums.js";
import { hasCatastrophicShape, validatePattern } from "./customPatterns.js";
import {
  configureRedaction,
  describeKind,
  findSensitive,
  maskSensitive,
  redactText,
  sanitizeBody,
  type SensitiveKind,
} from "./redact.js";

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

/** Each case: input text, the secret that must not survive, and the kind that must be reported. */
const SECRETS: [name: string, text: string, secret: string, kind: SensitiveKind][] = [
  ["email", "contact jane.doe@example.co.uk today", "jane.doe@example.co.uk", "email"],
  ["Luhn card", "card 4242 4242 4242 4242 exp 12/30", "4242 4242 4242 4242", "card"],
  ["JWT", "t=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijk", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijk", "jwt"],
  ["AWS access key", "id AKIAIOSFODNN7EXAMPLE here", "AKIAIOSFODNN7EXAMPLE", "api_key"],
  ["GitHub token", `x ghp_${"a1B2c3D4e5".repeat(4)} y`, `ghp_${"a1B2c3D4e5".repeat(4)}`, "api_key"],
  ["GitHub fine-grained", `x github_pat_${"A1b2C3d4E5".repeat(6)} y`, `github_pat_${"A1b2C3d4E5".repeat(6)}`, "api_key"],
  ["OpenAI key", "OPENAI sk-proj-abcdefghijklmnopqrstuvwx1234", "sk-proj-abcdefghijklmnopqrstuvwx1234", "api_key"],
  ["Anthropic key", "k sk-ant-api03-abcdefghijklmnopqrstuvwx1234 z", "sk-ant-api03-abcdefghijklmnopqrstuvwx1234", "api_key"],
  ["Slack token", "xoxb-1234567890-abcdefghijkl", "xoxb-1234567890-abcdefghijkl", "api_key"],
  ["Stripe live key", `use sk_live_${"4eC39HqLyjWDarjt".repeat(2)} now`, `sk_live_${"4eC39HqLyjWDarjt".repeat(2)}`, "api_key"],
  ["Google API key", `AIzaSy${"A".repeat(33)}`, `AIzaSy${"A".repeat(33)}`, "api_key"],
  ["private key block", "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7\nabcdef\n-----END RSA PRIVATE KEY----- tail", "MIIEowIBAAKCAQEA7", "private_key"],
  ["bearer token", "Authorization: Bearer abcdefghijklmnopqrstuvwx", "abcdefghijklmnopqrstuvwx", "bearer"],
  ["basic auth", "Authorization: Basic dXNlcjpwYXNzd29yZDEyMzQ1", "dXNlcjpwYXNzd29yZDEyMzQ1", "bearer"],
  ["IBAN (spaced)", "pay to GB82 WEST 1234 5698 7654 32 please", "GB82 WEST 1234 5698 7654 32", "iban"],
  ["IBAN (compact)", "DE89370400440532013000", "DE89370400440532013000", "iban"],
  ["US SSN", "ssn 123-45-6789.", "123-45-6789", "ssn"],
  ["Aadhaar (grouped, Verhoeff)", `uid ${verhoeffAppend("23456789012").replace(/(\d{4})(\d{4})(\d{4})/, "$1 $2 $3")}`, verhoeffAppend("23456789012").replace(/(\d{4})(\d{4})(\d{4})/, "$1 $2 $3"), "aadhaar"],
  ["Aadhaar (plain, with context)", `Aadhaar: ${verhoeffAppend("34567890123")}`, verhoeffAppend("34567890123"), "aadhaar"],
  ["PAN", "PAN ABCPE1234F filed", "ABCPE1234F", "pan"],
  ["Indian mobile", "call 98765 43210 now", "98765 43210", "phone"],
  ["Indian mobile +91", "call +91 98765 43210 now", "+91 98765 43210", "phone"],
  ["Indian mobile plain", "call 9876543210 now", "9876543210", "phone"],
  ["international phone", "call +44 20 7946 0958 now", "+44 20 7946 0958", "phone"],
  ["NANP phone", "call (415) 555-0132 now", "(415) 555-0132", "phone"],
  ["password pair", "login=bob&password=hunter2&x=1", "hunter2", "password"],
  ["JSON password", '{"password":"correct horse"}', "correct", "password"],
  ["api_key pair", "api_key: abc123def456", "abc123def456", "password"],
  ["snake_case password", "new_password=Tr0ub4dor", "Tr0ub4dor", "password"],
  ["secret URL params", "https://app.test/cb?code=4%2F0AbCdEf&state=ok&token=zzTop99", "zzTop99", "url_param"],
];

describe("redactText: each kind", () => {
  for (const [name, text, secret, kind] of SECRETS) {
    it(`redacts ${name}`, () => {
      const out = redactText(text);
      expect(out, name).not.toContain(secret);
      expect(out, name).toContain(`[REDACTED:${kind}]`);
    });
  }

  it("keeps the surrounding text and the parameter names", () => {
    expect(redactText("login=bob&password=hunter2&x=1")).toBe("login=bob&password=[REDACTED:password]&x=1");
    expect(redactText("https://app.test/cb?code=abc&state=ok")).toBe("https://app.test/cb?code=[REDACTED:url_param]&state=ok");
  });
});

describe("redactText: encodings", () => {
  it("decodes percent-encoding, including double encoding", () => {
    expect(redactText("e=jane%40example.com")).toBe("e=[REDACTED:email]");
    expect(redactText("e=jane%2540example.com")).toBe("e=[REDACTED:email]");
  });
  it("decodes JSON \\u escapes and HTML numeric entities", () => {
    expect(redactText('{"e":"jane\\u0040example.com"}')).toContain("[REDACTED:email]");
    expect(redactText("jane&#64;example.com")).toBe("[REDACTED:email]");
    expect(redactText("jane&#x40;example.com")).toBe("[REDACTED:email]");
  });
  it("redacts base64 and base64url segments that decode to something sensitive", () => {
    const out = redactText(`payload=${b64("email=jane@example.com&x=1")} end`);
    expect(out).toBe("payload=[REDACTED:encoded] end");
    const url = b64("card 4242 4242 4242 4242 please").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(redactText(`d=${url}`)).toContain("[REDACTED:encoded]");
  });
  it("leaves harmless base64 and long words alone", () => {
    const harmless = b64("hello there, this is a perfectly ordinary sentence");
    expect(redactText(`x ${harmless} y`)).toBe(`x ${harmless} y`);
    expect(redactText("antidisestablishmentarianism-anticonstitutionnellement")).toContain("antidis");
  });
});

describe("redactText: precision (no false positives on ordinary text)", () => {
  const BENIGN = [
    "Order 7891234 shipped on 2026-10-08 for ₹28,000 (was ₹31,500).",
    "Call 1800 123 4567 (toll free) or visit https://shop.test/help?lang=en&page=2",
    "timestamp 1700000000000 and id 20261008-101500-a1b2c3 and uuid 123e4567-e89b-12d3-a456-426614174000",
    "sha 5d41402abc4b2a76b9719d911017c592 version v1.2.3 IP 192.168.1.100 isbn 978-3-16-148410-0",
    "lat 28.6139, long 77.2090, zip 110001, flight AI-101 seat 12A",
    "Passport: required. Password must be at least 8 characters. Keyword: shoes. monkey=banana",
    "Reset your password: click the link below to continue.".replace("password: click", "password. Click"),
    "12 34 56 78 90 12 and 4111 1111 1111 1112 (not a card) and 000-12-3456 and 666-12-3456",
    "ABCDE1234F is not a PAN (4th letter D), but ABCPE12345 has too many digits",
    "IBAN-like but wrong: GB82 WEST 1234 5698 7654 33",
    "The quick brown fox jumps over the lazy dog. Price: 1,499. Call us.",
  ];
  for (const text of BENIGN) {
    it(`unchanged: ${text.slice(0, 50)}`, () => {
      expect(redactText(text)).toBe(text);
    });
  }
  it("a plain 12-digit number is only Aadhaar when the text says so", () => {
    const plain = verhoeffAppend("45678901234");
    expect(redactText(`ref ${plain}`)).toBe(`ref ${plain}`);
    expect(redactText(`Aadhaar no ${plain}`)).toContain("[REDACTED:aadhaar]");
  });
});

describe("redactText: properties", () => {
  it("is idempotent", () => {
    for (const [, text] of SECRETS) {
      const once = redactText(text);
      expect(redactText(once), text).toBe(once);
    }
  });
  it("fails closed: any internal error drops the data instead of returning it raw", () => {
    const bad = { toString: () => { throw new Error("boom"); } } as unknown as string;
    // redactText reads the string; a hostile non-string input must not come back unredacted.
    expect(redactText(bad)).toBe("[REDACTED:error]");
  });
});

describe("findSensitive (detector tier)", () => {
  it("reports high-precision kinds, not phones, and masks them for evidence", () => {
    const kinds = (t: string): SensitiveKind[] => findSensitive(t).map((m) => m.kind);
    expect(kinds("call 98765 43210")).toEqual([]); // phones are redacted, not flagged
    expect(kinds("a@b.co AKIAIOSFODNN7EXAMPLE 123-45-6789 ABCPE1234F")).toEqual(["email", "api_key", "ssn", "pan"]);
    for (const m of findSensitive("jane@example.com 4242 4242 4242 4242 123-45-6789")) {
      expect(maskSensitive(m)).not.toContain("jane@");
      expect(maskSensitive(m)).not.toMatch(/4242 4242 4242/);
      expect(maskSensitive(m)).not.toContain("123-45");
    }
  });
  it("includes passwords and secret URL parameters only on request (a login form to its own site is normal)", () => {
    expect(findSensitive("password=hunter2")).toEqual([]);
    expect(findSensitive("password=hunter2", { credentials: true }).map((m) => m.kind)).toEqual(["password"]);
    expect(findSensitive("https://x.test/?token=abcdef", { credentials: true }).map((m) => m.kind)).toEqual(["url_param"]);
  });
  it("treats [REDACTED:…] markers from source-side redaction as findings", () => {
    const found = findSensitive("email=[REDACTED:email]&x=[REDACTED:card]");
    expect(found.map((m) => m.kind)).toEqual(["email", "card"]);
    expect(maskSensitive(found[0]!)).toBe("[redacted at source]");
    expect(findSensitive("password=[REDACTED:password]")).toEqual([]);
  });
  it("sees through base64 encoding", () => {
    const found = findSensitive(`d=${b64("send jane@example.com now please")}`);
    expect(found.map((m) => m.kind)).toEqual(["encoded"]);
    expect(describeKind("encoded")).toContain("hides");
  });
  it("sanitizeBody redacts everything it can before storage", () => {
    expect(sanitizeBody("email=jane%40example.com&password=pw12345&phone=%2B91%2098765%2043210")).toBe(
      "email=[REDACTED:email]&password=[REDACTED:password]&phone=[REDACTED:phone]",
    );
  });
});

describe("checksums", () => {
  it("Verhoeff and IBAN validators accept good numbers and reject corrupted ones", () => {
    const aadhaar = verhoeffAppend("23456789012");
    expect(verhoeffValid(aadhaar)).toBe(true);
    const bad = aadhaar.slice(0, -1) + String((Number(aadhaar.at(-1)) + 1) % 10);
    expect(verhoeffValid(bad)).toBe(false);
    expect(ibanValid("GB82 WEST 1234 5698 7654 32")).toBe(true);
    expect(ibanValid("GB82 WEST 1234 5698 7654 33")).toBe(false);
    expect(ibanCheckDigits("GB", "WEST12345698765432")).toBe("82");
  });
});

describe("custom patterns", () => {
  afterEach(() => configureRedaction({ customPatterns: [] }));

  it("redact what the user asked for, case-insensitively", () => {
    configureRedaction({ customPatterns: ["EMP-\\d{6}", "\\bproject\\s+falcon\\b"] });
    expect(redactText("badge emp-123456 for Project Falcon")).toBe("badge [REDACTED:custom] for [REDACTED:custom]");
    expect(redactText("nothing here")).toBe("nothing here");
  });
  it("skip invalid or dangerous patterns instead of failing", () => {
    configureRedaction({ customPatterns: ["(a+)+$", "[", "EMP-\\d{6}"] });
    expect(redactText("EMP-123456 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!")).toContain("[REDACTED:custom]");
  });
  it("clearing the list turns them off", () => {
    configureRedaction({ customPatterns: ["EMP-\\d{6}"] });
    configureRedaction({ customPatterns: [] });
    expect(redactText("EMP-123456")).toBe("EMP-123456");
  });
});

describe("validatePattern (ReDoS protection)", () => {
  const REJECT = [
    "(a+)+$",
    "(a|aa)+$",
    "^(\\w+\\s?)*$",
    "(.*)*x",
    "([a-z]+)*\\d",
    "(\\d+)+",
    "\\d+\\d+x",
    ".*.*x",
    "(x+x+)+y",
    "(a|a)*b",
    "(\\w|\\d)+",
    "(.|x)*",
    "a*",
    "",
    "[",
    "x".repeat(201),
  ];
  for (const source of REJECT) {
    it(`rejects ${JSON.stringify(source.slice(0, 30))}`, () => {
      const started = performance.now();
      const result = validatePattern(source);
      expect(result.ok, source).toBe(false);
      expect(performance.now() - started, "rejection must be quick").toBeLessThan(500);
    });
  }
  const ACCEPT = ["EMP-\\d{6}", "\\bACME-[A-Z0-9]{8}\\b", "customer_id=\\d+", "(?:foo|bar)baz", "(?:foo|bar)+", "\\b\\d{3}-\\d{4}\\b", "secret\\s+project", "[A-Z]{2}\\d{6}"];
  for (const source of ACCEPT) {
    it(`accepts ${source}`, () => {
      const result = validatePattern(source);
      expect(result, source).toMatchObject({ ok: true });
    });
  }
  it("hasCatastrophicShape ignores escaped and class parentheses", () => {
    expect(hasCatastrophicShape("\\(a+\\)+")).toBe(false);
    expect(hasCatastrophicShape("[(]+x")).toBe(false);
  });
  it("explains why", () => {
    const r = validatePattern("(a+)+$");
    expect(r.ok === false && r.reason).toContain("Nested");
  });
});
