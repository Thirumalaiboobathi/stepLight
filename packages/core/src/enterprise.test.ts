import { describe, expect, it } from "vitest";
import { GENESIS, cleanDetail, nextAuditEntry, trimAuditLog, verifyAuditLog, type AuditEntry } from "./auditLog.js";
import { applyPolicy, mergePolicies, normalizePolicy, policyFromEnv, type PolicyProblem } from "./policy.js";
import { DEFAULT_SETTINGS, normalizeSettings } from "./settings.js";

describe("normalizePolicy", () => {
  it("accepts a full valid policy", () => {
    const p = normalizePolicy({
      maxCaptureLevel: "standard",
      forceRedactionPatterns: ["EMP-\\d{6}"],
      siteAllowlist: ["corp.example"],
      siteDenylist: ["MyBank.com", "*.hospital.org"],
      retentionDays: 3,
      disableExport: true,
      disableCliConnection: true,
      disableDeepCapture: true,
      requireEncryption: true,
    });
    expect(p).toEqual({
      maxCaptureLevel: "standard",
      forceRedactionPatterns: ["EMP-\\d{6}"],
      siteAllowlist: ["corp.example"],
      siteDenylist: ["mybank.com", "*.hospital.org"],
      retentionDays: 3,
      disableExport: true,
      disableCliConnection: true,
      disableDeepCapture: true,
      requireEncryption: true,
    });
  });
  it("drops and reports anything malformed, including unsafe patterns, without throwing", () => {
    const problems: PolicyProblem[] = [];
    const p = normalizePolicy(
      { maxCaptureLevel: "everything", retentionDays: 0, forceRedactionPatterns: ["(a+)+$", "ok-\\d+"], disableExport: "yes", siteDenylist: "x", extra: 1 },
      problems,
    );
    expect(p).toEqual({ forceRedactionPatterns: ["ok-\\d+"] });
    expect(problems.map((x) => x.key).sort()).toEqual(["disableExport", "extra", "forceRedactionPatterns", "maxCaptureLevel", "retentionDays", "siteDenylist"]);
    for (const junk of [null, undefined, 5, "x", []]) expect(normalizePolicy(junk)).toEqual({});
  });
});

describe("mergePolicies: the result is never looser than any input", () => {
  it("takes the stricter of each setting", () => {
    const m = mergePolicies(
      { maxCaptureLevel: "full", retentionDays: 30, siteDenylist: ["a.com"], siteAllowlist: ["x.com", "y.com"], disableExport: true },
      { maxCaptureLevel: "minimal", retentionDays: 7, siteDenylist: ["b.com"], siteAllowlist: ["y.com", "z.com"], requireEncryption: true },
    );
    expect(m).toEqual({
      maxCaptureLevel: "minimal",
      retentionDays: 7,
      siteDenylist: ["a.com", "b.com"],
      siteAllowlist: ["y.com"],
      disableExport: true,
      requireEncryption: true,
    });
  });
  it("an empty policy changes nothing", () => {
    expect(mergePolicies({}, { retentionDays: 5 })).toEqual({ retentionDays: 5 });
  });
});

describe("applyPolicy", () => {
  const user = normalizeSettings({ captureLevel: "full", deepCapture: true, retentionDays: 30, siteDenylist: ["mine.com"], customPatterns: ["MY-\\d+"], siteAllowlist: ["mine.com"] });

  it("overrides what the user chose, never the other way round", () => {
    const eff = applyPolicy(user, {
      maxCaptureLevel: "standard",
      disableDeepCapture: true,
      retentionDays: 7,
      siteDenylist: ["bank.com"],
      forceRedactionPatterns: ["EMP-\\d+"],
      siteAllowlist: ["corp.example"],
    });
    expect(eff.settings).toMatchObject({
      captureLevel: "standard",
      deepCapture: false,
      retentionDays: 7,
      siteDenylist: ["bank.com", "mine.com"],
      customPatterns: ["EMP-\\d+", "MY-\\d+"],
      siteAllowlist: ["corp.example"],
    });
    expect(eff.managed).toBe(true);
    expect(eff.lockedKeys.sort()).toEqual(["deepCapture", "siteAllowlist"]);
    expect(eff.forcedDenylist).toEqual(["bank.com"]);
    expect(eff.forcedPatterns).toEqual(["EMP-\\d+"]);
  });
  it("the user may be stricter than the policy", () => {
    const strict = normalizeSettings({ captureLevel: "minimal", retentionDays: 2 });
    const eff = applyPolicy(strict, { maxCaptureLevel: "full", retentionDays: 30 });
    expect(eff.settings).toMatchObject({ captureLevel: "minimal", retentionDays: 2 });
  });
  it("a policy retention applies even if the user keeps runs forever", () => {
    expect(applyPolicy({ ...DEFAULT_SETTINGS, retentionDays: 0 }, { retentionDays: 14 }).settings.retentionDays).toBe(14);
  });
  it("no policy = nothing managed, settings untouched", () => {
    const eff = applyPolicy(user, {});
    expect(eff.managed).toBe(false);
    expect(eff.settings).toEqual(user);
    expect(eff.lockedKeys).toEqual([]);
  });
});

describe("policyFromEnv", () => {
  it("reads STEPLIGHT_* variables", () => {
    const p = policyFromEnv({
      STEPLIGHT_MAX_CAPTURE_LEVEL: "minimal",
      STEPLIGHT_SITE_DENYLIST: "a.com, b.com",
      STEPLIGHT_RETENTION_DAYS: "5",
      STEPLIGHT_DISABLE_EXPORT: "1",
      STEPLIGHT_REQUIRE_ENCRYPTION: "true",
      STEPLIGHT_DISABLE_DEEP_CAPTURE: "0",
      STEPLIGHT_FORCE_REDACTION_PATTERNS: "EMP-\\d+\nCASE-\\d+",
    });
    expect(p).toEqual({
      maxCaptureLevel: "minimal",
      siteDenylist: ["a.com", "b.com"],
      retentionDays: 5,
      disableExport: true,
      requireEncryption: true,
      forceRedactionPatterns: ["EMP-\\d+", "CASE-\\d+"],
    });
    expect(policyFromEnv({})).toEqual({});
  });
});

describe("tamper-evident audit log", () => {
  const build = (n: number): AuditEntry[] => {
    const log: AuditEntry[] = [];
    for (let i = 0; i < n; i++) log.push(nextAuditEntry(log.at(-1), i % 2 ? "export" : "recording_started", { i, kind: "json" }, 1000 + i));
    return log;
  };

  it("chains entries and verifies", () => {
    const log = build(6);
    expect(log[0]!.prev).toBe(GENESIS);
    expect(log[1]!.prev).toBe(log[0]!.hash);
    expect(log.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(verifyAuditLog(log)).toEqual({ ok: true, entries: 6 });
    expect(verifyAuditLog([])).toEqual({ ok: true, entries: 0 });
  });
  it("detects a changed entry, a removed entry, reordering and a forged tail", () => {
    const log = build(6);
    const edited = structuredClone(log);
    edited[2]!.detail["kind"] = "html";
    expect(verifyAuditLog(edited)).toMatchObject({ ok: false, brokenAt: 3, reason: expect.stringContaining("modified") });
    expect(verifyAuditLog([...log.slice(0, 2), ...log.slice(3)])).toMatchObject({ ok: false, brokenAt: 4 });
    expect(verifyAuditLog([log[0]!, log[2]!, log[1]!, ...log.slice(3)])).toMatchObject({ ok: false });
    const rewritten = structuredClone(log);
    rewritten[4]!.ts = 5;
    expect(verifyAuditLog(rewritten).ok).toBe(false);
    // an attacker who edits entry 3 AND recomputes its hash still breaks entry 4's link
    const forged = structuredClone(log);
    forged[2] = nextAuditEntry(forged[1], "export", { i: 99 }, 5000);
    expect(verifyAuditLog(forged)).toMatchObject({ ok: false, brokenAt: 4 });
  });
  it("a trimmed log still verifies from its anchor, and a wrong anchor fails", () => {
    const log = build(10);
    const { entries, anchor } = trimAuditLog(log, 4);
    expect(entries.map((e) => e.seq)).toEqual([7, 8, 9, 10]);
    expect(verifyAuditLog(entries, anchor).ok).toBe(true);
    expect(verifyAuditLog(entries, GENESIS).ok).toBe(false);
  });
  it("keeps details small, flat and free of non-primitive data", () => {
    const d = cleanDetail({ a: "x".repeat(500), b: 3, c: true, d: { nested: 1 }, e: [1], f: NaN, g: undefined });
    expect(d).toEqual({ a: "x".repeat(120), b: 3, c: true });
    expect(Object.keys(cleanDetail(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i])))).length).toBe(12);
  });
});
