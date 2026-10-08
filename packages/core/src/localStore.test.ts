import { describe, expect, it } from "vitest";
import { createBundle, parseBundle } from "./bundle.js";
import { LocalRunStore, type KeyValueStore } from "./localStore.js";
import type { Run, Step } from "./types.js";

function memoryKv(): KeyValueStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    async get(keys) {
      const list = keys === null ? [...data.keys()] : Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of list) if (data.has(k)) out[k] = structuredClone(data.get(k));
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v));
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
    },
  };
}

const step = (id: string, over: Partial<Step> = {}): Step => ({
  id,
  runId: "x",
  index: 0,
  kind: "page_read",
  timestamp: 1,
  flags: [],
  ...over,
});

describe("LocalRunStore", () => {
  it("stores, lists and reads a run with snapshots", async () => {
    const store = new LocalRunStore(memoryKv());
    await store.startRun({ id: "r1", task: "Book", startedAt: 10, meta: { source: "t" } });
    await store.addStep("r1", step("a"), "page text a@b.co");
    await store.addStep("r1", step("b", { flags: [{ type: "hidden_instruction", severity: "high", message: "m", evidence: "e" }] }));
    await store.finishRun("r1", "success", 20);

    const [summary] = await store.listRuns();
    expect(summary).toMatchObject({ id: "r1", stepCount: 2, flagCount: 1, maxSeverity: "high", status: "success" });
    const run = (await store.getRun("r1"))!;
    expect(run.steps.map((s) => s.index)).toEqual([0, 1]);
    expect(run.steps[0]!.snapshotRef).toBeDefined();
    expect(run.steps[1]!.snapshotRef).toBeUndefined();
    expect(await store.getSnapshot("r1", "a")).toBe("page text [REDACTED:email]");
  });

  it("ignores steps for unknown runs and returns undefined for missing data", async () => {
    const store = new LocalRunStore(memoryKv());
    await store.addStep("nope", step("a"));
    expect(await store.listRuns()).toEqual([]);
    expect(await store.getRun("nope")).toBeUndefined();
    expect(await store.getSnapshot("nope", "a")).toBeUndefined();
  });

  it("evicts the oldest runs when over budget but never the active one", async () => {
    const kv = memoryKv();
    const store = new LocalRunStore(kv, { maxBytes: 3000, maxSnapshotChars: 1000 });
    for (const id of ["old1", "old2", "cur"]) {
      await store.startRun({ id, task: id, startedAt: id === "cur" ? 3 : id === "old2" ? 2 : 1 });
      await store.addStep(id, step("s"), "x".repeat(900));
    }
    const ids = (await store.listRuns()).map((r) => r.id);
    expect(ids).toContain("cur");
    expect(ids).not.toContain("old1");
    expect([...kv.data.keys()].some((k) => k.includes("old1"))).toBe(false);
    // A single run larger than the budget is kept rather than evicting itself.
    for (let i = 0; i < 10; i++) await store.addStep("cur", step(`t${i}`), "y".repeat(900));
    expect((await store.listRuns()).map((r) => r.id)).toEqual(["cur"]);
  });

  it("truncates huge snapshots", async () => {
    const store = new LocalRunStore(memoryKv(), { maxSnapshotChars: 100 });
    await store.startRun({ id: "r", task: "t", startedAt: 1 });
    await store.addStep("r", step("a"), "z".repeat(5000));
    expect((await store.getSnapshot("r", "a"))!.length).toBeLessThan(200);
  });

  it("restarting a run id replaces it, deleteRun and clear remove data", async () => {
    const kv = memoryKv();
    kv.data.set("unrelated", 1);
    const store = new LocalRunStore(kv);
    await store.startRun({ id: "r", task: "t", startedAt: 1 });
    await store.addStep("r", step("a"), "x");
    await store.startRun({ id: "r", task: "t2", startedAt: 2 });
    expect((await store.getRun("r"))!.steps).toHaveLength(0);
    await store.addStep("r", step("a"), "x");
    await store.deleteRun("r");
    expect(await store.listRuns()).toEqual([]);
    await store.startRun({ id: "q", task: "t", startedAt: 1 });
    await store.clear();
    expect([...kv.data.keys()]).toEqual(["unrelated"]);
  });

  it("serialises concurrent writes", async () => {
    const store = new LocalRunStore(memoryKv());
    await store.startRun({ id: "r", task: "t", startedAt: 1 });
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.addStep("r", step(`s${i}`))));
    const run = (await store.getRun("r"))!;
    expect(run.steps).toHaveLength(20);
    expect(run.steps.map((s) => s.index)).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it("imports a run, using a new id when it already exists", async () => {
    const store = new LocalRunStore(memoryKv());
    const run: Run = { id: "dup", task: "t", startedAt: 1, status: "success", meta: {}, steps: [step("a", { snapshotRef: "x" })] };
    expect(await store.importRun(run, { a: "text" })).toBe("dup");
    const second = await store.importRun(run, { a: "text" });
    expect(second).not.toBe("dup");
    expect(await store.getSnapshot(second, "a")).toBe("text");
    expect(await store.listRuns()).toHaveLength(2);
  });
});

describe("run bundles", () => {
  const run: Run = {
    id: "r1",
    task: "Book",
    startedAt: 1,
    endedAt: 9,
    status: "success",
    meta: { a: "b" },
    steps: [step("a", { snapshotRef: "snapshots/a.txt" }), step("b", { snapshotRef: "snapshots/b.txt" })],
  };

  it("round-trips and drops dangling snapshot refs", () => {
    const text = JSON.stringify(createBundle(run, { a: "hello sk-abcdefghijklmnopqrstuv" }));
    const back = parseBundle(text);
    expect(back.snapshots).toEqual({ a: "hello [REDACTED:api_key]" });
    expect(back.run.steps[0]!.snapshotRef).toBeDefined();
    expect(back.run.steps[1]!.snapshotRef).toBeUndefined();
    expect(back.run.endedAt).toBe(9);
  });

  it("rejects malformed input", () => {
    expect(() => parseBundle("nope")).toThrow(/not valid JSON/);
    expect(() => parseBundle("{}")).toThrow(/format/);
    expect(() => parseBundle(JSON.stringify({ format: "steplight-run", version: 2 }))).toThrow(/version/);
    const bad = (patch: object) => JSON.stringify({ ...createBundle(run), run: { ...run, ...patch } });
    expect(() => parseBundle(bad({ id: "../x" }))).toThrow(/run id/);
    expect(() => parseBundle(bad({ status: "weird" }))).toThrow(/status/);
    expect(() => parseBundle(bad({ steps: [{ id: 1 }] }))).toThrow(/step 0/);
    expect(() => parseBundle("x".repeat(26 * 1024 * 1024))).toThrow(/too large/);
  });

  it("redacts secrets that a hand-edited file smuggles in", () => {
    const b = createBundle(run);
    b.run.steps[0]!.request = { method: "POST", url: "http://x.test", bodyPreview: "e=a@b.co" };
    const back = parseBundle(JSON.stringify(b));
    expect(back.run.steps[0]!.request!.bodyPreview).toBe("e=[REDACTED:email]");
  });
});

describe("bundle redaction of run-level fields", () => {
  it("redacts the task and meta values on create and on parse", () => {
    const run: Run = { id: "r", task: "Book for jane@example.com", startedAt: 1, status: "success", meta: { owner: "bob@example.com" }, steps: [] };
    const made = createBundle(run);
    expect(made.run.task).toBe("Book for [REDACTED:email]");
    expect(made.run.meta["owner"]).toBe("[REDACTED:email]");
    const raw = JSON.stringify({ ...made, run: { ...made.run, task: "again jane@example.com", meta: { k: "sk-abcdefghijklmnopqrstuv" } } });
    const parsed = parseBundle(raw);
    expect(parsed.run.task).toBe("again [REDACTED:email]");
    expect(parsed.run.meta["k"]).toBe("[REDACTED:api_key]");
  });
});
