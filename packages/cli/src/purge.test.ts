import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { purgeRuns, readRun, writeRun, type Run } from "@steplight/core/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "./index.js";
import { createViewerServer, type ViewerServer } from "./server.js";

const DAY = 86_400_000;
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "steplight-purge-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

/** A run with a secret-ish snapshot on disk, started `ageDays` ago. */
async function seed(id: string, ageDays: number): Promise<void> {
  const run: Run = {
    id,
    task: `task ${id}`,
    startedAt: Date.now() - ageDays * DAY,
    status: "success",
    meta: {},
    steps: [{ id: "s0", runId: id, index: 0, kind: "page_read", timestamp: 1, flags: [], snapshotRef: "snapshots/s0.txt" }],
  };
  await writeRun(dir, run, { s0: `SNAPSHOT-TEXT-${id}` });
}

const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

describe("purgeRuns", () => {
  it("removes expired runs with every file in them, and keeps recent ones", async () => {
    await seed("old", 30);
    await seed("edge", 8);
    await seed("recent", 2);
    expect(await exists(path.join(dir, "old", "snapshots", "s0.txt"))).toBe(true);
    const deleted = await purgeRuns(dir, { olderThanDays: 7 });
    expect(deleted.sort()).toEqual(["edge", "old"]);
    expect(await readdir(dir)).toEqual(["recent"]);
    expect(await exists(path.join(dir, "old"))).toBe(false);
    expect(await exists(path.join(dir, "old", "snapshots", "s0.txt"))).toBe(false);
    expect((await readRun(dir, "recent")).task).toBe("task recent");
    expect(await readFile(path.join(dir, "recent", "snapshots", "s0.txt"), "utf8")).toBe("SNAPSHOT-TEXT-recent");
  });

  it("all: removes everything, and does nothing without a clear instruction", async () => {
    await seed("a", 1);
    await seed("b", 0);
    expect(await purgeRuns(dir, {})).toEqual([]);
    expect(await purgeRuns(dir, { olderThanDays: -1 })).toEqual([]);
    expect((await readdir(dir)).length).toBe(2);
    expect((await purgeRuns(dir, { all: true })).sort()).toEqual(["a", "b"]);
    expect(await readdir(dir)).toEqual([]);
  });

  it("ignores folders that are not runs", async () => {
    await seed("old", 30);
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(path.join(dir, "not-a-run"));
    await writeFile(path.join(dir, "not-a-run", "notes.txt"), "keep me");
    await mkdir(path.join(dir, "..evil"), { recursive: true }).catch(() => undefined);
    await purgeRuns(dir, { all: true });
    expect(await readFile(path.join(dir, "not-a-run", "notes.txt"), "utf8")).toBe("keep me");
  });

  it("the CLI deletes by age, refuses --all without --yes, and verifies the files are gone", async () => {
    await seed("old", 30);
    await seed("new", 1);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await buildProgram().parseAsync(["node", "steplight", "purge", "--all", "--dir", dir]);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("--yes"));
    expect(process.exitCode).toBe(2);
    expect((await readdir(dir)).length).toBe(2);
    process.exitCode = undefined;

    await buildProgram().parseAsync(["node", "steplight", "purge", "--older-than-days", "7", "--dir", dir]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Deleted 1 run "));
    expect(await readdir(dir)).toEqual(["new"]);
    expect(await exists(path.join(dir, "old"))).toBe(false);

    await buildProgram().parseAsync(["node", "steplight", "purge", "--all", "--yes", "--dir", dir]);
    expect(await readdir(dir)).toEqual([]);

    await buildProgram().parseAsync(["node", "steplight", "purge", "--dir", dir]);
    expect(process.exitCode).toBe(2);
  });
});

describe("POST /api/purge", () => {
  let server: ViewerServer;
  let base: string;
  beforeEach(async () => {
    server = createViewerServer({ runsDir: dir });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const post = (body: unknown, token: string | null = server?.token) =>
    fetch(`${base}/api/purge`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });

  it("needs the session token", async () => {
    await seed("a", 1);
    expect((await post({ all: true }, null)).status).toBe(401);
    expect((await readdir(dir)).length).toBe(1);
  });

  it("validates the request and deletes on instruction", async () => {
    await seed("old", 30);
    await seed("new", 1);
    expect((await post({})).status).toBe(400);
    expect((await post({ all: false })).status).toBe(400);
    expect((await post({ olderThanDays: "7" })).status).toBe(400);
    expect((await readdir(dir)).length).toBe(2);
    const res = await post({ olderThanDays: 7 });
    expect(await res.json()).toEqual({ deleted: 1 });
    expect(await readdir(dir)).toEqual(["new"]);
    expect(await (await post({ all: true })).json()).toEqual({ deleted: 1 });
    expect(await readdir(dir)).toEqual([]);
  });
});
