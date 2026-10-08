import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeRun, type Run, type Step } from "@steplight/core/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "./index.js";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
  vi.restoreAllMocks();
});

const read = (i: number, total: number): Step => ({
  id: `s${i}`,
  runId: "r",
  index: i,
  kind: "page_read",
  timestamp: i,
  url: `http://h/p${i}.html`,
  flags: [],
  tokens: { total, visibleChars: total * 4, hiddenChars: 40, boilerplateChars: total * 2, boilerplateShare: 0.5, estimated: true },
});

describe("steplight tokens", () => {
  it("prints the estimated total and the most expensive pages", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "steplight-tok-"));
    const run: Run = { id: "r", task: "t", startedAt: 1, status: "success", meta: {}, steps: [read(0, 1200), read(1, 15_000), read(2, 300), read(3, 90)] };
    await writeRun(dir, run);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await buildProgram().parseAsync(["node", "steplight", "tokens", "r", "--dir", dir]);
    const out = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toContain("~16.6k tokens (estimate) over 4 page reads");
    expect(out).toContain("50% boilerplate");
    expect(out.indexOf("p1.html")).toBeLessThan(out.indexOf("p0.html")); // most expensive first
    expect(out).not.toContain("p3.html"); // only the top 3
  });
  it("explains when a run has no estimates", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "steplight-tok-"));
    await writeRun(dir, { id: "old", task: "t", startedAt: 1, status: "success", meta: {}, steps: [] });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await buildProgram().parseAsync(["node", "steplight", "tokens", "old", "--dir", dir]);
    expect(log.mock.calls[0]![0]).toContain("No token estimates");
  });
});
