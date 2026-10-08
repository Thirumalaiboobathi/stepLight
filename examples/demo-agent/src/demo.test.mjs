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
  const { flightsRunId, cleanRunId } = await runDemo({ dir, quiet: true });

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
}, 90_000);
