import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBundle, type Run } from "@steplight/core/node";
import { createViewerServer, type ViewerServer } from "./server.js";

let dir: string;
let server: ViewerServer;
let base: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "steplight-cli-"));
  server = createViewerServer({ runsDir: dir });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await rm(dir, { recursive: true, force: true });
});

/** fetch() with the session token, like the viewer and the extension do. */
const authed = (url: string, init: RequestInit = {}) =>
  fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${server.token}` } });

const post = (body: unknown) => authed(`${base}/api/ingest`, { method: "POST", body: JSON.stringify(body) });

describe("ingest + read API", () => {
  it("stores a run sent step by step and serves it back, redacted", async () => {
    expect((await post({ type: "run_start", run: { id: "ext-1", task: "Browse", startedAt: 1000 } })).status).toBe(200);
    const step = {
      id: "s0",
      runId: "ext-1",
      index: 0,
      kind: "form_submit",
      timestamp: 1100,
      flags: [{ type: "sensitive_data_outbound", severity: "critical", message: "m", evidence: "e" }],
      request: { method: "POST", url: "https://x.test", bodyPreview: "email=jane@example.com" },
    };
    expect((await post({ type: "step", runId: "ext-1", step, snapshot: "page sk-abcdefghijklmnopqrstuv" })).status).toBe(200);
    expect((await post({ type: "run_end", runId: "ext-1", status: "success", endedAt: 2000 })).status).toBe(200);

    const list = (await (await authed(`${base}/api/runs`)).json()) as { id: string; maxSeverity: string; status: string }[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "ext-1", maxSeverity: "critical", status: "success" });

    const run = (await (await authed(`${base}/api/runs/ext-1`)).json()) as { steps: { id: string; request: { bodyPreview: string } }[] };
    expect(run.steps[0]!.request.bodyPreview).toBe("email=[REDACTED:email]");
    const snap = await (await authed(`${base}/api/runs/ext-1/snapshot/s0`)).text();
    expect(snap).toBe("page [REDACTED:api_key]");
    expect(await readFile(path.join(dir, "ext-1", "steps.jsonl"), "utf8")).not.toContain("jane@example.com");
  });

  it("rejects steps for unknown runs and unsafe ids", async () => {
    expect((await post({ type: "step", runId: "nope", step: {} })).status).toBe(400);
    expect((await post({ type: "run_start", run: { id: "../evil", task: "x", startedAt: 1 } })).status).toBe(400);
  });

  it("404s unknown runs and snapshots, and blocks traversal", async () => {
    expect((await authed(`${base}/api/runs/missing`)).status).toBe(404);
    expect((await authed(`${base}/api/runs/..%2F..%2Fetc`)).status).toBe(400);
    expect((await authed(`${base}/api/nothing`)).status).toBe(404);
  });

  it("answers CORS preflight for the extension", async () => {
    const origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
    const res = await fetch(`${base}/api/ingest`, { method: "OPTIONS", headers: { origin } });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(origin); // never "*"
    expect(res.headers.get("access-control-allow-headers")).toContain("authorization");
  });

  it("imports an exported run, re-sanitised, and gives duplicates a fresh id", async () => {
    const run: Run = {
      id: "imp-1",
      task: "Imported",
      startedAt: 5,
      endedAt: 9,
      status: "success",
      meta: {},
      steps: [
        { id: "a", runId: "imp-1", index: 0, kind: "page_read", timestamp: 6, flags: [], snapshotRef: "snapshots/a.txt" },
      ],
    };
    const bundle = createBundle(run, { a: "text" });
    const send = (body: string) => authed(`${base}/api/import`, { method: "POST", body });
    const first = (await (await send(JSON.stringify(bundle))).json()) as { id: string };
    expect(first.id).toBe("imp-1");
    const second = (await (await send(JSON.stringify(bundle))).json()) as { id: string };
    expect(second.id).not.toBe("imp-1");
    expect(await (await authed(`${base}/api/runs/imp-1/snapshot/a`)).text()).toBe("text");
    expect(((await (await authed(`${base}/api/runs`)).json()) as unknown[]).length).toBe(2);

    const bad = await send("{nope");
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain("Invalid Steplight run file");
  });

  it("explains itself when the viewer is not built", async () => {
    expect(await (await fetch(`${base}/`)).text()).toContain("Steplight API is running");
  });
});
