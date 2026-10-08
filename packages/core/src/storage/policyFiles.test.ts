import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendAudit, auditFilePath, loadPolicy, readAuditFile, verifyAuditFile } from "./policyFiles.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "steplight-policy-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const write = (name: string, value: unknown): string => {
  const file = path.join(dir, name);
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  return file;
};

describe("loadPolicy", () => {
  it("is empty when nothing is configured", () => {
    expect(loadPolicy({ cwd: dir, env: {} })).toMatchObject({ policy: {}, sources: [], problems: [] });
  });

  it("merges the org policy, the config file and the environment; the strictest value of each wins", () => {
    const org = write("org.json", { maxCaptureLevel: "standard", siteDenylist: ["bank.com"], requireEncryption: true });
    write("steplight.config.json", { maxCaptureLevel: "full", retentionDays: 30, siteDenylist: ["mine.com"] });
    const { policy, sources } = loadPolicy({
      cwd: dir,
      policyFile: org,
      env: { STEPLIGHT_RETENTION_DAYS: "7", STEPLIGHT_DISABLE_EXPORT: "1" },
    });
    expect(policy).toEqual({
      maxCaptureLevel: "standard",
      retentionDays: 7,
      siteDenylist: ["bank.com", "mine.com"],
      requireEncryption: true,
      disableExport: true,
    });
    expect(sources).toHaveLength(3);
  });

  it("a user config can never loosen the org policy", () => {
    const org = write("org.json", { maxCaptureLevel: "minimal", disableDeepCapture: true, retentionDays: 3 });
    write("steplight.config.json", { maxCaptureLevel: "full", retentionDays: 365 });
    expect(loadPolicy({ cwd: dir, policyFile: org, env: {} }).policy).toMatchObject({ maxCaptureLevel: "minimal", retentionDays: 3, disableDeepCapture: true });
  });

  it("an unreadable or invalid policy file is an error, never 'no restrictions'", () => {
    expect(() => loadPolicy({ cwd: dir, policyFile: path.join(dir, "missing.json"), env: {} })).toThrow(/Cannot read organisation policy/);
    expect(() => loadPolicy({ cwd: dir, policyFile: write("bad.json", "{not json"), env: {} })).toThrow(/Cannot read/);
  });

  it("reports invalid values instead of ignoring them silently", () => {
    const org = write("org.json", { maxCaptureLevel: "everything", forceRedactionPatterns: ["(a+)+$"] });
    const { problems } = loadPolicy({ cwd: dir, policyFile: org, env: {} });
    expect(problems.map((p) => p.key).sort()).toEqual(["forceRedactionPatterns", "maxCaptureLevel"]);
  });

  it("reads $STEPLIGHT_POLICY_FILE and $STEPLIGHT_CONFIG", () => {
    const org = write("o.json", { disableExport: true });
    const cfg = write("c.json", { retentionDays: 9 });
    expect(loadPolicy({ cwd: dir, env: { STEPLIGHT_POLICY_FILE: org, STEPLIGHT_CONFIG: cfg } }).policy).toEqual({ disableExport: true, retentionDays: 9 });
  });
});

describe("audit log file", () => {
  it("lives next to the runs folder unless overridden", () => {
    expect(auditFilePath(path.join(dir, "runs"), {})).toBe(path.join(dir, "audit.jsonl"));
    expect(auditFilePath(path.join(dir, "runs"), { STEPLIGHT_AUDIT_FILE: "/x/a.jsonl" })).toBe("/x/a.jsonl");
  });

  it("appends hash-chained entries that verify", () => {
    const file = path.join(dir, "audit.jsonl");
    appendAudit(file, "server_started", { host: "127.0.0.1" });
    appendAudit(file, "export", { kind: "json", encrypted: true });
    appendAudit(file, "purge", { runs: 2 });
    const entries = readAuditFile(file);
    expect(entries.map((e) => e.action)).toEqual(["server_started", "export", "purge"]);
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(verifyAuditFile(file)).toEqual({ ok: true, entries: 3 });
  });

  it("detects an edited, deleted or injected line", () => {
    const file = path.join(dir, "audit.jsonl");
    for (const a of ["server_started", "export", "purge", "decrypt"] as const) appendAudit(file, a, { n: 1 });
    const original = readFileSync(file, "utf8");
    writeFileSync(file, original.replace('"export"', '"import"'));
    expect(verifyAuditFile(file).ok).toBe(false);
    const lines = original.trim().split("\n");
    writeFileSync(file, [lines[0], lines[2], lines[3]].join("\n") + "\n");
    expect(verifyAuditFile(file)).toMatchObject({ ok: false, brokenAt: 3 });
    writeFileSync(file, original);
    appendFileSync(file, "garbage line\n");
    expect(verifyAuditFile(file).ok).toBe(false);
  });

  it("never throws, even when the log cannot be written", () => {
    writeFileSync(path.join(dir, "blocker"), "");
    expect(appendAudit(path.join(dir, "blocker", "audit.jsonl"), "purge")).toBeUndefined();
  });
});
