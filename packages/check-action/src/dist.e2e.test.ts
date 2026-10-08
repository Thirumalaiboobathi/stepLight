// Runs the BUILT bundle (dist/index.js) as a real subprocess, the way the runner does: environment
// variables INPUT_*, GITHUB_OUTPUT, GITHUB_STEP_SUMMARY and GITHUB_WORKSPACE, node as the interpreter.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanRun, hijackedRun, makeWorkspace, type Workspace } from "./fixtures.js";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = path.join(PKG, "dist", "index.js");
const REPO_RUNS = path.resolve(PKG, "..", "..", ".steplight", "runs");
const made: Workspace[] = [];

beforeAll(() => {
  const r = spawnSync(process.execPath, [path.join(PKG, "scripts", "build.mjs")], { cwd: PKG, encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
});
afterAll(async () => {
  for (const w of made) await rm(w.dir, { recursive: true, force: true });
});

function runBundle(w: Workspace, inputs: Record<string, string> = {}, cwd = path.dirname(w.dir)) {
  // A minimal environment: only what the runner sets, so nothing from this process leaks in.
  const env = { PATH: process.env["PATH"] ?? "", SystemRoot: process.env["SystemRoot"] ?? "", ...w.env(inputs) } as NodeJS.ProcessEnv;
  const r = spawnSync(process.execPath, [BUNDLE], { cwd, env, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("dist/index.js as a subprocess", () => {
  it("is one self-contained file that loads nothing from node_modules and makes no network calls", () => {
    const text = readFileSync(BUNDLE, "utf8");
    const requires = [...text.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]!);
    expect(requires.length).toBeGreaterThan(0);
    for (const r of requires) expect(r.startsWith("node:") || ["process", "buffer", "events", "stream", "util", "os", "fs", "path", "crypto"].includes(r)).toBe(true);
    for (const banned of ["node:http", "node:https", "node:net", "node:dns", "node:tls", "fetch(", "XMLHttpRequest", "child_process"]) expect(text).not.toContain(banned);
    expect(statSync(BUNDLE).size).toBeLessThan(2 * 1024 * 1024);
  });

  it("clean run: exit 0, outputs and summary written", async () => {
    const w = await makeWorkspace([cleanRun()], "max_severity: medium\n");
    made.push(w);
    const r = runBundle(w);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("PASS");
    expect(await w.readOutputs()).toMatchObject({ result: "pass", "flag-count": "0", "max-severity": "none" });
    expect(await w.readSummary()).toContain("✅ pass");
  });

  it("hijacked run: exit 1, error annotation, outputs say fail", async () => {
    const w = await makeWorkspace([cleanRun(), hijackedRun()], "max_severity: medium\n");
    made.push(w);
    const r = runBundle(w);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("::error::Steplight check failed");
    expect(await w.readOutputs()).toMatchObject({ result: "fail", "flag-count": "2", "max-severity": "critical" });
    expect(await w.readSummary()).toContain("❌ fail");
  });

  it("works from any working directory and writes SARIF inside the workspace", async () => {
    const w = await makeWorkspace([hijackedRun("hijacked")], "max_severity: medium\n");
    made.push(w);
    const r = runBundle(w, { format: "sarif", "output-file": "reports/agent.sarif", "run-id": "hijacked" }, PKG);
    expect(r.code).toBe(1);
    const sarifPath = (await w.readOutputs())["report-file"]!;
    expect(sarifPath).toBe(path.join(w.dir, "reports", "agent.sarif"));
    expect(JSON.parse(readFileSync(sarifPath, "utf8")).version).toBe("2.1.0");
  });

  it("rejects path traversal in the real process too", async () => {
    const w = await makeWorkspace([cleanRun()], "");
    made.push(w);
    for (const inputs of [{ "runs-dir": "../.." } as Record<string, string>, { "output-file": "../x.xml", format: "junit" } as Record<string, string>, { "run-id": "../clean" } as Record<string, string>]) {
      const r = runBundle(w, inputs);
      expect(r.code).toBe(1);
      expect(r.stdout).toMatch(/::error::Steplight check: /);
      expect((await w.readOutputs())["result"]).toBeUndefined();
    }
  });

  it("fails cleanly (not with a stack trace) when GITHUB_WORKSPACE has no runs", async () => {
    const w = await makeWorkspace([], "");
    made.push(w);
    const r = runBundle(w);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("no runs found");
    expect(r.stderr).toBe("");
  });

  // The demo runs are created by `pnpm demo`; this test uses them when they are present.
  const demo = existsSync(REPO_RUNS);
  it.skipIf(!demo)("checks the real demo runs: the hijacked flight booking fails, the clean control passes", async () => {
    const { listRuns } = await import("@steplight/core/run-store");
    const runs = await listRuns(REPO_RUNS);
    const hijacked = runs.find((r) => r.task.startsWith("Book the cheapest flight") && r.maxSeverity && ["high", "critical"].includes(r.maxSeverity));
    const clean = runs.find((r) => r.task.startsWith("Book the cheapest flight") && r.maxSeverity === undefined);
    if (!hijacked || !clean) return; // demo runs from an older version; nothing to assert
    // The workspace must contain the runs, so point GITHUB_WORKSPACE at the repository root.
    const run = (id: string) =>
      spawnSync(process.execPath, [BUNDLE], {
        cwd: PKG,
        encoding: "utf8",
        env: { PATH: process.env["PATH"] ?? "", SystemRoot: process.env["SystemRoot"] ?? "", GITHUB_WORKSPACE: path.resolve(PKG, "..", ".."), "INPUT_RUN-ID": id, "INPUT_RUNS-DIR": ".steplight/runs", INPUT_RULES: "steplight.rules.yml", "INPUT_FAIL-ON": "high" },
      });
    expect(run(hijacked.id).status).toBe(1);
    expect(run(clean.id).status).toBe(0);
  });
});
