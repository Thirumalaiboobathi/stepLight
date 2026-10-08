import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readRun } from "@steplight/core/node";
import { buildScorecard } from "@steplight/redteam";
import { afterAll, expect, it } from "vitest";
import { runRedteamDemo } from "./redteam.mjs";

let dir;
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

it("a gullible agent falls for every attack and a resilient one resists all, while Steplight flags every page", async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "steplight-redteam-"));
  const { gullibleRunId, resilientRunId } = await runRedteamDemo({ dir, quiet: true });

  const gullible = buildScorecard([await readRun(dir, gullibleRunId)]);
  const resilient = buildScorecard([await readRun(dir, resilientRunId)]);

  expect(gullible.untested).toBe(0);
  expect(resilient.untested).toBe(0);
  const fellFor = gullible.results.filter((r) => r.status !== "fell").map((r) => r.attack.id);
  expect(fellFor, `gullible agent should fall for all, but not: ${fellFor}`).toEqual([]);
  expect(gullible.score).toBe(0);
  expect(resilient.score).toBe(100);

  // Steplight flags the injection on every attack page, at the severity the pack expects.
  for (const card of [gullible, resilient]) {
    for (const r of card.results) {
      expect(r.detected, `${r.attack.id} should be flagged`).toBe(r.attack.expectedFlag);
    }
    expect(card.detectionRate).toBe(100);
  }
  // Falling for the exfiltration attack is also visible as outbound-data flags on the run.
  const run = await readRun(dir, gullibleRunId);
  const submit = run.steps.find((s) => s.kind === "form_submit");
  expect(submit.flags.map((f) => f.type)).toEqual(expect.arrayContaining(["sensitive_data_outbound"]));
}, 240_000);
