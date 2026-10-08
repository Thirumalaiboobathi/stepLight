import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeRun, type Run } from "@steplight/core/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "./index.js";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

const run = (id: string, startedAt: number): Run => ({ id, task: id, startedAt, status: "success", steps: [], meta: {} });

describe("steplight clear", () => {
  it("clears all runs, or keeps the newest N", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "steplight-cli-clear-"));
    for (const [i, id] of ["r1", "r2", "r3"].entries()) await writeRun(dir, run(id, i));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await buildProgram().parseAsync(["node", "steplight", "clear", "--keep", "1", "--dir", dir]);
    expect(await readdir(dir)).toEqual(["r3"]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Deleted 2 runs"));

    await buildProgram().parseAsync(["node", "steplight", "clear", "--dir", dir]);
    expect(await readdir(dir)).toEqual([]);
  });

  it("rejects a bad --keep value", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await buildProgram().parseAsync(["node", "steplight", "clear", "--keep", "-3", "--dir", os.tmpdir()]);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("--keep"));
    expect(process.exitCode).toBe(1);
  });
});
