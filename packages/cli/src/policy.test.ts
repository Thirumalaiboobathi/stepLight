import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { auditFilePath, readAuditFile, writeRun, type Policy, type Run } from "@steplight/core/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "./index.js";
import { createViewerServer, type ViewerServer } from "./server.js";

let dir: string;
let work: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "steplight-pol-"));
  work = await mkdtemp(path.join(os.tmpdir(), "steplight-pol-work-"));
  for (const k of ["STEPLIGHT_ENCRYPTION_KEY", "STEPLIGHT_PASSPHRASE", "STEPLIGHT_POLICY_FILE", "STEPLIGHT_PW_TEST"]) delete process.env[k];
  process.env["STEPLIGHT_AUDIT_FILE"] = path.join(work, "audit-env.jsonl"); // never write into the shared temp folder
});
afterEach(async () => {
  for (const k of ["STEPLIGHT_ENCRYPTION_KEY", "STEPLIGHT_PASSPHRASE", "STEPLIGHT_POLICY_FILE", "STEPLIGHT_PW_TEST", "STEPLIGHT_AUDIT_FILE"]) delete process.env[k];
  await rm(dir, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

const run: Run = {
  id: "p-1",
  task: "t",
  startedAt: 1,
  endedAt: 2,
  status: "success",
  meta: {},
  steps: [{ id: "s0", runId: "p-1", index: 0, kind: "page_read", timestamp: 2, flags: [] }],
};
const policyFile = async (p: Policy): Promise<string> => {
  const file = path.join(work, "policy.json");
  await writeFile(file, JSON.stringify(p));
  return file;
};

describe("server enforces the organisation policy on what the extension sends", () => {
  let server: ViewerServer;
  let base: string;
  const start = async (policy: Policy) => {
    server = createViewerServer({ runsDir: dir, policy, auditFile: path.join(work, "audit.jsonl") });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const call = (p: string, body?: unknown) =>
    fetch(`${base}${p}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${server.token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const step = (over: Record<string, unknown> = {}) => ({
    id: "s0", runId: "e1", index: 0, kind: "page_read", timestamp: 2, url: "https://shop.test/p?q=1", flags: [], targetText: "TARGET-TEXT", ...over,
  });

  it("caps the stored detail at maxCaptureLevel, whatever the extension sends", async () => {
    await start({ maxCaptureLevel: "minimal" });
    await call("/api/ingest", { type: "run_start", run: { id: "e1", task: "t", startedAt: 1 } });
    await call("/api/ingest", { type: "step", runId: "e1", step: step(), snapshot: "SNAPSHOT-TEXT" });
    const disk = await readFile(path.join(dir, "e1", "steps.jsonl"), "utf8");
    expect(disk).not.toContain("SNAPSHOT");
    expect(disk).not.toContain("TARGET-TEXT");
    expect(disk).not.toContain("q=1");
    expect(await readdir(path.join(dir, "e1", "snapshots"))).toEqual([]);
  });

  it("drops steps from denied sites and applies forced redaction patterns", async () => {
    await start({ siteDenylist: ["bank.test"], forceRedactionPatterns: ["EMP-\\d{6}"] });
    await call("/api/ingest", { type: "run_start", run: { id: "e1", task: "t", startedAt: 1 } });
    await call("/api/ingest", { type: "step", runId: "e1", step: step({ url: "https://www.bank.test/login", targetText: "BANK-STEP" }) });
    await call("/api/ingest", { type: "step", runId: "e1", step: step({ id: "s1", index: 1, targetText: "badge EMP-123456" }) });
    const disk = await readFile(path.join(dir, "e1", "steps.jsonl"), "utf8");
    expect(disk).not.toContain("BANK-STEP");
    expect(disk).not.toContain("EMP-123456");
    expect(disk).toContain("[REDACTED:custom]");
  });

  it("refuses ingest when the extension may not connect, and export/import when export is disabled", async () => {
    await start({ disableCliConnection: true, disableExport: true });
    expect((await call("/api/ingest", { type: "run_start", run: { id: "e1", task: "t", startedAt: 1 } })).status).toBe(403);
    expect((await call("/api/import", { format: "steplight-run" })).status).toBe(403);
    expect(await (await call("/api/policy")).json()).toEqual({ disableCliConnection: true, disableExport: true });
  });

  it("records export / import reported by the viewer in the audit log, and nothing else", async () => {
    await start({});
    expect((await call("/api/audit", { action: "export", detail: { kind: "json", encrypted: true } })).status).toBe(200);
    expect((await call("/api/audit", { action: "purge" })).status).toBe(400); // pages cannot forge other actions
    expect((await call("/api/audit", { action: "export", detail: { nested: { a: 1 } } })).status).toBe(400);
    const entries = readAuditFile(path.join(work, "audit.jsonl"));
    expect(entries.map((e) => e.action)).toEqual(["export"]);
  });
});

describe("commands honour the policy", () => {
  it("report and export --bundle are refused when export is disabled", async () => {
    await writeRun(dir, run, {});
    const file = await policyFile({ disableExport: true });
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await buildProgram().parseAsync(["node", "steplight", "report", "p-1", "--dir", dir, "--out", path.join(work, "r.html"), "--policy", file]);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("disabled by organisation policy"));
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    await buildProgram().parseAsync(["node", "steplight", "export", "p-1", "--bundle", "--dir", dir, "--out", path.join(work, "r.json"), "--policy", file]);
    expect(process.exitCode).toBe(1);
    expect((await readdir(work)).filter((n) => n.startsWith("r."))).toEqual([]);
  });

  it("requireEncryption demands a password for exports; with one it works and is audited", async () => {
    await writeRun(dir, run, {});
    const file = await policyFile({ requireEncryption: true });
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await buildProgram().parseAsync(["node", "steplight", "report", "p-1", "--dir", dir, "--out", path.join(work, "r.html"), "--policy", file]);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("password-protected"));
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    process.env["STEPLIGHT_PW_TEST"] = "pw";
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await buildProgram().parseAsync(["node", "steplight", "report", "p-1", "--dir", dir, "--out", path.join(work, "r.html"), "--policy", file, "--password-env", "STEPLIGHT_PW_TEST"]);
    expect(process.exitCode).toBeUndefined();
    expect(await readFile(path.join(work, "r.html"), "utf8")).toContain("Encrypted Steplight report");
    expect(readAuditFile(auditFilePath(dir)).map((e) => e.action)).toEqual(["export"]);
  });

  it("view refuses to start without a key when the policy requires encryption, and on a broken policy file", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await buildProgram().parseAsync(["node", "steplight", "view", "--dir", dir, "--port", "0", "--policy", await policyFile({ requireEncryption: true })]);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("organisation policy requires encryption"));
    expect(process.exitCode).toBe(2);
    process.exitCode = undefined;
    await buildProgram().parseAsync(["node", "steplight", "view", "--dir", dir, "--port", "0", "--policy", path.join(work, "missing.json")]);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("Cannot read organisation policy"));
    expect(process.exitCode).toBe(2);
    expect(process.env["STEPLIGHT_ENCRYPTION_KEY"]).toBeUndefined();
    void randomBytes;
  });
});

describe("steplight audit", () => {
  it("lists entries, verifies the chain, and exits 1 when it was tampered with", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await writeRun(dir, run, {});
    await buildProgram().parseAsync(["node", "steplight", "purge", "--older-than-days", "999", "--dir", dir]);
    await buildProgram().parseAsync(["node", "steplight", "purge", "--all", "--yes", "--dir", dir]);
    const file = auditFilePath(dir);
    expect(readAuditFile(file).map((e) => e.action)).toEqual(["purge", "purge"]);

    await buildProgram().parseAsync(["node", "steplight", "audit", "--verify", "--dir", dir]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Hash chain intact"));
    expect(process.exitCode).toBeUndefined();

    await writeFile(file, (await readFile(file, "utf8")).replace('"runs":1', '"runs":0'));
    await buildProgram().parseAsync(["node", "steplight", "audit", "--verify", "--dir", dir]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("TAMPERING DETECTED"));
    expect(process.exitCode).toBe(1);
  });
});
