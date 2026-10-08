import { describe, expect, it } from "vitest";
import { collectPageScan } from "./collect.js";
import { LocalRunStore, type KeyValueStore } from "./localStore.js";
import { NEVER_CAPTURE_AUTOCOMPLETE, NEVER_CAPTURE_NAME_PATTERN, PAYMENT_FRAME_HOSTS, isNeverCaptureField, isPaymentFrameUrl } from "./neverCapture.js";
import {
  DEFAULT_SETTINGS,
  SUGGESTED_DENYLIST,
  domainMatches,
  normalizeDomainList,
  normalizeSettings,
  recordingBlockedReason,
} from "./settings.js";

describe("never-capture rules", () => {
  const yes: Parameters<typeof isNeverCaptureField>[0][] = [
    { tag: "input", type: "password" },
    { tag: "input", type: "PASSWORD" },
    { tag: "input", autocomplete: "cc-number" },
    { tag: "input", autocomplete: "section-pay cc-csc" },
    { tag: "input", autocomplete: "one-time-code" },
    { tag: "input", autocomplete: "current-password" },
    { tag: "input", autocomplete: "new-password" },
    { tag: "input", name: "card_number" },
    { tag: "input", name: "cardNumber" },
    { tag: "input", id: "cvv" },
    { tag: "input", name: "CVC2" },
    { tag: "input", name: "otp" },
    { tag: "input", placeholder: "Enter OTP" },
    { tag: "input", name: "user-pin" },
    { tag: "input", name: "userPin" },
    { tag: "input", name: "ssn" },
    { tag: "input", ariaLabel: "Aadhaar number" },
    { tag: "input", name: "aadhar_no" },
    { tag: "input", name: "pan" },
    { tag: "input", name: "csrf_token" },
    { tag: "textarea", name: "secret_note" },
    { tag: "input", label: "IBAN" },
    { tag: "div", contentEditable: true, inPaymentFrame: true },
    { tag: "input", inPaymentFrame: true },
  ];
  const no: Parameters<typeof isNeverCaptureField>[0][] = [
    { tag: "input", type: "text", name: "email" },
    { tag: "input", name: "first_name" },
    { tag: "input", name: "company" },
    { tag: "input", name: "span" },
    { tag: "input", name: "shipping_address" },
    { tag: "input", name: "capital" },
    { tag: "input", name: "pinned" },
    { tag: "input", autocomplete: "email" },
    { tag: "input", autocomplete: "name" },
    { tag: "textarea", name: "message", placeholder: "Your message" },
    { tag: "div", contentEditable: true },
    { tag: "button", name: "pay" },
  ];
  for (const field of yes) {
    it(`never captures ${JSON.stringify(field)}`, () => {
      expect(isNeverCaptureField(field)).toBe(true);
    });
  }
  for (const field of no) {
    it(`still reads ${JSON.stringify(field)}`, () => {
      expect(isNeverCaptureField(field)).toBe(false);
    });
  }
  it("knows payment frames", () => {
    expect(isPaymentFrameUrl("https://js.stripe.com/v3/elements")).toBe(true);
    expect(isPaymentFrameUrl("https://checkout.razorpay.com/x")).toBe(true);
    expect(isPaymentFrameUrl("https://notstripe.com/")).toBe(false);
    expect(isPaymentFrameUrl("not a url")).toBe(false);
    expect(PAYMENT_FRAME_HOSTS.length).toBeGreaterThan(10);
  });
  it("the self-contained copy inside collectPageScan stays in sync with the shared rule", () => {
    const source = collectPageScan.toString();
    expect(source).toContain(NEVER_CAPTURE_NAME_PATTERN.source);
    expect(source).toContain(NEVER_CAPTURE_AUTOCOMPLETE.source);
    for (const host of PAYMENT_FRAME_HOSTS.filter((h) => !h.startsWith("js."))) expect(source, host).toContain(`"${host}"`);
  });
});

describe("settings", () => {
  it("defaults are the safe choice", () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ captureLevel: "standard", deepCapture: false, retentionDays: 7, pageIndicator: true });
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings("garbage")).toEqual(DEFAULT_SETTINGS);
  });
  it("rejects invalid values and falls back", () => {
    const s = normalizeSettings({ captureLevel: "everything", deepCapture: "yes", retentionDays: -4, maxStorageMB: 1e9, siteDenylist: "x", pageIndicator: 3 });
    expect(s.captureLevel).toBe("standard");
    expect(s.deepCapture).toBe(false); // only a real `true` turns it on
    expect(s.retentionDays).toBe(0);
    expect(s.maxStorageMB).toBe(1024);
    expect(s.siteDenylist).toEqual([]);
    expect(s.pageIndicator).toBe(true);
  });
  it("normalises domain lists", () => {
    expect(normalizeDomainList([" MyBank.com ", "https://www.Hospital.org/portal?x=1", "*.corp.example", "bad domain", "", 5, "mybank.com"])).toEqual([
      "mybank.com",
      "www.hospital.org",
      "*.corp.example",
    ]);
  });
  it("matches domains and subdomains but not look-alikes", () => {
    expect(domainMatches("mybank.com", "www.mybank.com")).toBe(true);
    expect(domainMatches("mybank.com", "mybank.com")).toBe(true);
    expect(domainMatches("mybank.com", "notmybank.com")).toBe(false);
    expect(domainMatches("*.corp.example", "corp.example")).toBe(true);
    expect(domainMatches("*.corp.example", "a.corp.example")).toBe(true);
  });
  it("blocks denied sites and sites outside a non-empty allow list", () => {
    const deny = { siteAllowlist: [], siteDenylist: ["mybank.com"] };
    expect(recordingBlockedReason("https://www.mybank.com/login", deny)).toContain("deny list");
    expect(recordingBlockedReason("https://shop.test/", deny)).toBeUndefined();
    const allow = { siteAllowlist: ["shop.test"], siteDenylist: [] };
    expect(recordingBlockedReason("https://shop.test/x", allow)).toBeUndefined();
    expect(recordingBlockedReason("https://other.test/", allow)).toContain("allow list");
    expect(recordingBlockedReason("about:blank", deny)).toBeUndefined();
    expect(recordingBlockedReason(undefined, deny)).toBeUndefined();
  });
  it("the first-run suggestions cover banking, health and password managers", () => {
    for (const d of ["chase.com", "mychart.com", "1password.com", "bitwarden.com"]) expect(SUGGESTED_DENYLIST).toContain(d);
    expect(normalizeDomainList([...SUGGESTED_DENYLIST]).length).toBe(SUGGESTED_DENYLIST.length);
  });
});

function memoryKv(): KeyValueStore & { dump(): string } {
  const data = new Map<string, unknown>();
  return {
    async get(keys) {
      const list = keys === null ? [...data.keys()] : Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))]));
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v));
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
    },
    dump: () => JSON.stringify([...data.entries()]),
  };
}

describe("retention in the extension store", () => {
  const DAY = 86_400_000;
  it("deletes expired runs, with their snapshots, and keeps recent and active ones", async () => {
    const kv = memoryKv();
    const store = new LocalRunStore(kv);
    const now = 100 * DAY;
    const step = (runId: string) => ({ id: "s0", runId, index: 0, kind: "page_read" as const, timestamp: 1, flags: [] });
    for (const [id, age] of [["old1", 30], ["old2", 8], ["fresh", 2], ["active", 40]] as const) {
      await store.startRun({ id, task: `task ${id}`, startedAt: now - age * DAY });
      await store.addStep(id, step(id), `SECRET-SNAPSHOT-${id}`);
      await store.finishRun(id, "success", now);
    }
    const deleted = await store.deleteOlderThan(now - 7 * DAY, "active");
    expect(deleted.sort()).toEqual(["old1", "old2"]);
    expect((await store.listRuns()).map((r) => r.id).sort()).toEqual(["active", "fresh"]);
    const raw = kv.dump();
    expect(raw).not.toContain("SECRET-SNAPSHOT-old1");
    expect(raw).not.toContain("SECRET-SNAPSHOT-old2");
    expect(raw).toContain("SECRET-SNAPSHOT-fresh");
    expect(await store.getSnapshot("old1", "s0")).toBeUndefined();
  });
  it("clear() leaves nothing of any run behind", async () => {
    const kv = memoryKv();
    const store = new LocalRunStore(kv);
    await store.startRun({ id: "r", task: "t", startedAt: 1 });
    await store.addStep("r", { id: "s0", runId: "r", index: 0, kind: "page_read", timestamp: 1, flags: [] }, "TOP-SECRET-TEXT");
    await store.clear();
    expect(kv.dump()).not.toContain("TOP-SECRET-TEXT");
    expect(JSON.parse(kv.dump())).toEqual([]);
  });
  it("setMaxBytes shrinks the budget: older runs are evicted on the next write", async () => {
    const kv = memoryKv();
    const store = new LocalRunStore(kv, { maxBytes: 1_000_000 });
    for (const id of ["a", "b", "c"]) {
      await store.startRun({ id, task: id, startedAt: id.charCodeAt(0) });
      await store.addStep(id, { id: "s0", runId: id, index: 0, kind: "page_read", timestamp: 1, flags: [] }, "x".repeat(3000));
    }
    expect((await store.listRuns()).length).toBe(3);
    store.setMaxBytes(5000);
    await store.startRun({ id: "d", task: "d", startedAt: 1000 });
    expect((await store.listRuns()).length).toBeLessThan(4);
  });
});
