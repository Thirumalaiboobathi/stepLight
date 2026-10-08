import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearRuns, deleteRun, writeRun } from "./storage/runStore.js";
import type { Run } from "./types.js";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const run = (id: string, startedAt: number, meta: Record<string, string> = {}): Run => ({
  id,
  task: id,
  startedAt,
  status: "success",
  steps: [],
  meta,
});

async function setup(): Promise<string> {
  dir = await mkdtemp(path.join(os.tmpdir(), "steplight-clear-"));
  await writeRun(dir, run("a", 1, { agent: "demo" }));
  await writeRun(dir, run("b", 2));
  await writeRun(dir, run("c", 3, { agent: "demo" }));
  await mkdir(path.join(dir, "not-a-run"));
  await writeFile(path.join(dir, "notes.txt"), "keep me");
  return dir;
}

describe("clearRuns", () => {
  it("deletes every run but leaves unrelated files and folders alone", async () => {
    const root = await setup();
    expect((await clearRuns(root)).sort()).toEqual(["a", "b", "c"]);
    expect((await readdir(root)).sort()).toEqual(["not-a-run", "notes.txt"]);
  });
  it("keeps the newest N", async () => {
    const root = await setup();
    expect((await clearRuns(root, { keep: 2 })).sort()).toEqual(["a"]);
    expect((await readdir(root)).sort()).toEqual(["b", "c", "not-a-run", "notes.txt"]);
  });
  it("only touches runs matching the filter", async () => {
    const root = await setup();
    expect((await clearRuns(root, { filter: (r) => r.meta["agent"] === "demo" })).sort()).toEqual(["a", "c"]);
    expect((await readdir(root)).sort()).toEqual(["b", "not-a-run", "notes.txt"]);
  });
  it("is a no-op on a missing directory and deleteRun reports absence", async () => {
    const root = await setup();
    expect(await clearRuns(path.join(root, "missing"))).toEqual([]);
    expect(await deleteRun(root, "a")).toBe(true);
    expect(await deleteRun(root, "a")).toBe(false);
    await expect(deleteRun(root, "../x")).rejects.toThrow();
  });
});
