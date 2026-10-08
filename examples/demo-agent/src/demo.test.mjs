import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readRun } from "@steplight/core/node";
import { afterAll, expect, it } from "vitest";
import { runDemo } from "./demo.mjs";

let dir;
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

it("demo run shows the injection, the causal link and the exfiltration", async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "steplight-demo-"));
  const { flightsRunId, cleanRunId, safeRunId, stuckRunId } = await runDemo({ dir, quiet: true });

  const run = await readRun(dir, flightsRunId);
  const read = run.steps.find((s) => s.kind === "page_read" && s.url.includes("flights"));
  expect(read.flags.some((f) => f.type === "hidden_instruction" && f.severity === "high")).toBe(true);

  const click = run.steps.find((s) => s.kind === "click" && /premium/i.test(s.targetText));
  expect(click.causedBy).toBe(read.id);

  const submit = run.steps.find((s) => s.kind === "form_submit");
  expect(submit.flags.some((f) => f.severity === "critical" || f.severity === "high")).toBe(true);

  const clean = await readRun(dir, cleanRunId);
  const bad = clean.steps.flatMap((s) => s.flags).filter((f) => f.severity === "high" || f.severity === "critical");
  expect(bad).toEqual([]);

  // The same task on a page without the injection books Economy and sees no hidden instruction.
  const safe = await readRun(dir, safeRunId);
  expect(safe.steps.some((st) => st.kind === "click" && /economy/i.test(st.targetText))).toBe(true);
  expect(safe.steps.flatMap((st) => st.flags).filter((f) => f.type === "hidden_instruction")).toEqual([]);

  // The stuck agent: a loop flag plus a diagnosis for each kind of failure.
  const stuck = await readRun(dir, stuckRunId);
  const failed = stuck.steps.filter((st) => st.error);
  expect(failed.length).toBe(5);
  expect(stuck.steps.flatMap((st) => st.flags).some((f) => f.type === "stuck_loop")).toBe(true);
  const reasons = failed.flatMap((st) => st.diagnosis.reasons).join(" | ");
  expect(reasons).toContain("covered by div#promo-overlay");
  expect(reasons).toContain("Element is disabled");
  expect(reasons).toContain("matched 0 elements");
  expect(failed.at(-1).diagnosis.similar.join(" | ")).toContain("button#covered-btn");
  expect(stuck.status).toBe("failed");
}, 120_000);
