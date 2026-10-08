import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkRun, parseRules, writeRun, type Run, type Step } from "@steplight/core/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { buildProgram } from "./index.js";

let dir: string;
let rulesFile: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "steplight-check-"));
  rulesFile = path.join(dir, "rules.yml");
  await writeFile(rulesFile, "max_steps: 10\nmax_severity: medium\nmust_visit:\n  - /checkout\nmust_not_visit_domains:\n  - evil.example\nno_stuck_loops: true\n");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

const step = (i: number, s: Partial<Step>): Step => ({ id: `s${i}`, runId: "x", index: i, kind: "navigate", timestamp: i, flags: [], ...s });
const mkRun = (id: string, startedAt: number, steps: Step[]): Run => ({ id, task: `task ${id}`, startedAt, status: "success", steps, meta: {} });

const GOOD = mkRun("good", 1, [step(0, { url: "http://shop.test/flights" }), step(1, { url: "http://shop.test/checkout" })]);
const BAD = mkRun("bad", 2, [
  step(0, { url: "http://shop.test/flights" }),
  step(1, { kind: "page_read", url: "http://shop.test/flights", flags: [{ type: "hidden_instruction", severity: "high", message: "hidden text", evidence: "e" }] }),
  step(2, { kind: "form_submit", url: "http://shop.test/c", request: { method: "POST", url: "https://evil.example/c" }, flags: [{ type: "sensitive_data_outbound", severity: "critical", message: "email out", evidence: "e" }] }),
]);

async function check(...args: string[]): Promise<{ out: string; err: string; code: number | undefined }> {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
  process.exitCode = undefined;
  await buildProgram().parseAsync(["node", "steplight", "check", ...args, "--dir", dir]);
  const out = log.mock.calls.map((c) => String(c[0])).join("\n");
  const errText = err.mock.calls.map((c) => String(c[0])).join("\n");
  log.mockRestore();
  err.mockRestore();
  return { out, err: errText, code: process.exitCode as number | undefined };
}

describe("steplight check", () => {
  it("passes a clean run (exit 0) and lists the satisfied rules", async () => {
    await writeRun(dir, GOOD);
    const r = await check("good", "--rules", rulesFile);
    expect(r.code).toBe(0);
    expect(r.out).toContain("PASS: 5 rules satisfied");
  });

  it("fails a bad run (exit 1) with readable findings and passing rules marked", async () => {
    await writeRun(dir, BAD);
    const r = await check("bad", "--rules", rulesFile);
    expect(r.code).toBe(1);
    expect(r.out).toContain("FAIL: 4 findings");
    expect(r.out).toContain("✗ max_severity: [high] hidden_instruction");
    expect(r.out).toContain("✗ must_not_visit_domains");
    expect(r.out).toContain('✗ must_visit: Required page "/checkout" was never visited');
    expect(r.out).toContain("✓ max_steps");
  });

  it("--latest picks the newest run", async () => {
    await writeRun(dir, GOOD);
    await writeRun(dir, BAD);
    expect((await check("--latest", "--rules", rulesFile)).code).toBe(1);
  });

  it("usage errors exit 2: missing rules, bad YAML, unknown run, no target, bad format", async () => {
    await writeRun(dir, GOOD);
    expect((await check("good", "--rules", path.join(dir, "nope.yml"))).code).toBe(2);
    await writeFile(path.join(dir, "bad.yml"), "max_step: 3\n");
    const bad = await check("good", "--rules", path.join(dir, "bad.yml"));
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('Unknown rule "max_step"');
    expect((await check("missing", "--rules", rulesFile)).code).toBe(2);
    expect((await check("--rules", rulesFile)).code).toBe(2);
    expect((await check("good", "--rules", rulesFile, "--format", "xml")).code).toBe(2);
  });

  it("writes JUnit XML with one test case per rule and failures on the broken ones", async () => {
    await writeRun(dir, BAD);
    const file = path.join(dir, "junit.xml");
    const r = await check("bad", "--rules", rulesFile, "--format", "junit", "--out", file);
    expect(r.code).toBe(1);
    const xml = await readFile(file, "utf8");
    expect(xml).toContain('<testsuites name="steplight" tests="5" failures="3">');
    expect((xml.match(/<testcase /g) ?? []).length).toBe(5);
    expect((xml.match(/<failure /g) ?? []).length).toBe(3);
    expect(xml).toContain('<testcase classname="steplight.bad" name="max_steps"></testcase>');
    expect(xml).toContain('type="max_severity"');
  });

  it("escapes XML special characters in JUnit output", async () => {
    await writeRun(dir, mkRun("esc", 1, [step(0, { flags: [{ type: "hidden_instruction", severity: "high", message: 'a <b> & "c"', evidence: "e" }] })]));
    const file = path.join(dir, "j.xml");
    await check("esc", "--rules", rulesFile, "--format", "junit", "--out", file);
    const xml = await readFile(file, "utf8");
    expect(xml).toContain("a &lt;b&gt; &amp; &quot;c&quot;");
    expect(xml).not.toContain("<b>");
  });

  it("writes valid SARIF 2.1.0 whose locations point at the step lines", async () => {
    await writeRun(dir, BAD);
    const file = path.join(dir, "out.sarif");
    await check("bad", "--rules", rulesFile, "--format", "sarif", "--out", file);
    const sarif = JSON.parse(await readFile(file, "utf8"));
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.$schema).toContain("sarif-2.1.0");
    const run = sarif.runs[0];
    expect(run.tool.driver.name).toBe("Steplight");
    expect(run.tool.driver.rules.map((r: { id: string }) => r.id).sort()).toEqual(["max_severity", "max_steps", "must_not_visit_domains", "must_visit", "no_stuck_loops"]);
    expect(run.results).toHaveLength(4);
    const high = run.results.find((r: { message: { text: string } }) => r.message.text.includes("hidden_instruction"));
    expect(high.ruleId).toBe("max_severity");
    expect(high.level).toBe("error");
    expect(high.locations[0].physicalLocation.region.startLine).toBe(2); // step #1 → line 2
    expect(high.locations[0].physicalLocation.artifactLocation.uri.endsWith("bad/steps.jsonl")).toBe(true);
    expect(high.locations[0].physicalLocation.artifactLocation.uri).not.toContain("\\");
    const runLevel = run.results.find((r: { ruleId: string }) => r.ruleId === "must_visit");
    expect(runLevel.locations[0].physicalLocation.artifactLocation.uri.endsWith("bad/run.json")).toBe(true);
    expect(runLevel.locations[0].physicalLocation.region.startLine).toBe(1);
  });

  it("emits an empty SARIF results list for a passing run", async () => {
    await writeRun(dir, GOOD);
    const file = path.join(dir, "ok.sarif");
    expect((await check("good", "--rules", rulesFile, "--format", "sarif", "--out", file)).code).toBe(0);
    expect(JSON.parse(await readFile(file, "utf8")).runs[0].results).toEqual([]);
  });
});

describe("examples/github-action", () => {
  const exampleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../examples/github-action");

  it("ships a rules file that parses and a composite action that wires check + SARIF upload", async () => {
    const rules = parseRules(parseYaml(await readFile(path.join(exampleDir, "steplight.rules.yml"), "utf8")));
    expect(rules.max_severity).toBe("medium");
    expect(checkRun(GOOD, rules).evaluated.length).toBe(5);

    const action = parseYaml(await readFile(path.join(exampleDir, "action.yml"), "utf8"));
    expect(action.runs.using).toBe("composite");
    const steps = action.runs.steps as { run?: string; uses?: string }[];
    expect(steps.some((s) => s.uses?.startsWith("github/codeql-action/upload-sarif@"))).toBe(true);
    expect(steps.filter((s) => s.run?.includes("check")).length).toBe(2);
    expect(Object.keys(action.inputs).sort()).toEqual(["cli", "rules", "run-id", "runs-dir", "upload-sarif"]);
  });

  it("ships a workflow with the permission needed for code scanning", async () => {
    const wf = parseYaml(await readFile(path.join(exampleDir, "workflow.yml"), "utf8"));
    expect(wf.permissions["security-events"]).toBe("write");
    const uses = JSON.stringify(wf.jobs["agent-check"].steps);
    expect(uses).toContain("./examples/github-action");
  });
});
