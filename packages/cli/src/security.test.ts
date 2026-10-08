import { request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createViewerServer, isLoopbackHost, VIEWER_CSP, type ServerOptions, type ViewerServer } from "./server.js";

let dir: string;
let server: ViewerServer;
let port: number;

async function start(options: Partial<ServerOptions> = {}): Promise<void> {
  dir = await mkdtemp(path.join(os.tmpdir(), "steplight-sec-"));
  server = createViewerServer({ runsDir: dir, ...options });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
}

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await rm(dir, { recursive: true, force: true });
});

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

interface RawOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  host?: string;
  token?: string | null;
}

/** Raw HTTP request, so the Host and Origin headers can be forged (fetch forbids that). */
function raw(pathName: string, opts: RawOptions = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      host: opts.host ?? `127.0.0.1:${port}`,
      ...(opts.token === null ? {} : { authorization: `Bearer ${opts.token ?? server.token}` }),
      ...opts.headers,
    };
    const req = request({ host: "127.0.0.1", port, path: pathName, method: opts.method ?? "GET", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(opts.body);
  });
}

const run = (id: string) => ({ type: "run_start", run: { id, task: "t", startedAt: 1 } });
const ingest = (body: unknown, extra: RawOptions = {}) =>
  raw("/api/ingest", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), ...extra });

describe("authentication", () => {
  beforeEach(() => start());

  it("generates a 256-bit random token per server", () => {
    const other = createViewerServer({ runsDir: dir });
    expect(server.token).toMatch(/^[0-9a-f]{64}$/);
    expect(other.token).not.toBe(server.token);
  });

  it("answers 401 to every /api route without a token, or with a wrong one", async () => {
    const routes: [string, string][] = [
      ["GET", "/api/runs"],
      ["GET", "/api/runs/abc"],
      ["GET", "/api/runs/abc/snapshot/s0"],
      ["POST", "/api/ingest"],
      ["POST", "/api/import"],
      ["GET", "/api/anything-else"],
    ];
    for (const [method, route] of routes) {
      expect((await raw(route, { method, token: null })).status, `${method} ${route} no token`).toBe(401);
      expect((await raw(route, { method, token: "0".repeat(64) })).status, `${method} ${route} wrong token`).toBe(401);
      expect((await raw(route, { method, headers: { authorization: "Basic abc" }, token: null })).status).toBe(401);
    }
  });

  it("accepts the right token", async () => {
    expect((await raw("/api/runs")).status).toBe(200);
  });

  it("does not accept the token in the query string", async () => {
    expect((await raw(`/api/runs?token=${server.token}`, { token: null })).status).toBe(401);
  });
});

describe("host and origin checks", () => {
  beforeEach(() => start());

  it("rejects a foreign Host header (DNS rebinding) with 403, even with a valid token", async () => {
    for (const host of ["evil.example", `evil.example:${port}`, `127.0.0.1:${port + 1}`, "attacker.test:80", "x"]) {
      expect((await raw("/api/runs", { host })).status, host).toBe(403);
      expect((await raw("/", { host })).status, `static ${host}`).toBe(403);
    }
    expect((await raw("/api/runs", { host: `localhost:${port}` })).status).toBe(200);
  });

  it("rejects web-page origins; allows its own origin and extension origins", async () => {
    expect((await raw("/api/runs", { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await raw("/api/runs", { headers: { origin: "http://127.0.0.1:1" } })).status).toBe(403);
    expect((await raw("/api/runs", { headers: { origin: "null" } })).status).toBe(403);
    const own = await raw("/api/runs", { headers: { origin: `http://127.0.0.1:${port}` } });
    expect(own.status).toBe(200);
    expect(own.headers["access-control-allow-origin"]).toBe(`http://127.0.0.1:${port}`);
    const ext = await raw("/api/runs", { headers: { origin: "chrome-extension://abcdefghijklmnop" } });
    expect(ext.status).toBe(200);
    expect(ext.headers["access-control-allow-origin"]).toBe("chrome-extension://abcdefghijklmnop");
  });

  it("never sends a wildcard CORS origin and does not answer preflight for foreign origins", async () => {
    const pre = await raw("/api/ingest", { method: "OPTIONS", token: null, headers: { origin: "https://evil.example" } });
    expect(pre.status).toBe(403);
    expect(pre.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("restricting to one extension id", () => {
  beforeEach(() => start({ extensionIds: ["goodgoodgoodgood"] }));
  it("only that extension passes", async () => {
    expect((await raw("/api/runs", { headers: { origin: "chrome-extension://goodgoodgoodgood" } })).status).toBe(200);
    expect((await raw("/api/runs", { headers: { origin: "chrome-extension://badbadbadbadbad" } })).status).toBe(403);
  });
});

describe("input validation", () => {
  beforeEach(() => start({ maxBodyBytes: 2_000, maxImportBytes: 3_000 }));

  it("answers 400 to traversal and malformed run / step ids", async () => {
    for (const id of ["..%2F..%2Fetc", "..%2f", "%2e%2e%2f", "a%00b", "a%2Fb", "a%5Cb", "%E0%A4%A", "x".repeat(200)]) {
      expect((await raw(`/api/runs/${id}`)).status, id).toBe(400);
    }
    expect((await ingest(run("../evil"))).status).toBe(400);
    expect((await ingest(run("a/b"))).status).toBe(400);
    expect((await ingest(run("ok-1"))).status).toBe(200);
    expect((await raw("/api/runs/ok-1/snapshot/..%2F..%2Frun.json")).status).toBe(400);
  });

  it("answers 413 for oversized bodies (declared and streamed)", async () => {
    const big = JSON.stringify({ ...run("big"), pad: "x".repeat(3_000) });
    expect((await ingest(big)).status).toBe(413);
    expect((await raw("/api/import", { method: "POST", body: "x".repeat(4_000) })).status).toBe(413);
    // chunked, no Content-Length
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port, path: "/api/ingest", method: "POST", headers: { authorization: `Bearer ${server.token}`, "transfer-encoding": "chunked" } },
        (res) => resolve(res.statusCode ?? 0),
      );
      req.on("error", reject);
      req.write(" ".repeat(1_500));
      req.write(" ".repeat(1_500));
      req.end();
    });
    expect(status).toBe(413);
  });

  it("validates ingest messages against a schema", async () => {
    expect((await ingest("{not json")).status).toBe(400);
    expect((await ingest({ type: "nope" })).status).toBe(400);
    expect((await ingest({ type: "run_start", run: { id: "r1", task: 5, startedAt: 1 } })).status).toBe(400);
    expect((await ingest({ type: "run_start", run: { id: "r1", task: "t", startedAt: -1 } })).status).toBe(400);
    expect((await ingest(run("r1"))).status).toBe(200);
    const step = { id: "s0", runId: "r1", index: 0, kind: "teleport", timestamp: 1, flags: [] };
    expect((await ingest({ type: "step", runId: "r1", step })).status).toBe(400);
    const badFlag = { type: "x", severity: "apocalyptic", message: "", evidence: "" };
    expect((await ingest({ type: "step", runId: "r1", step: { ...step, kind: "click", flags: [badFlag] } })).status).toBe(400);
    expect((await ingest({ type: "step", runId: "r1", step: { ...step, kind: "click", url: 5 } })).status).toBe(400);
    expect((await ingest({ type: "step", runId: "r1", step: { ...step, kind: "click" } })).status).toBe(200);
  });

  it("drops unknown fields instead of storing them", async () => {
    await ingest(run("r2"));
    const step = { id: "s0", runId: "r2", index: 0, kind: "click", timestamp: 1, flags: [], evil: "<script>" };
    await ingest({ type: "step", runId: "r2", step });
    const stored = JSON.parse((await raw("/api/runs/r2")).body) as { steps: Record<string, unknown>[] };
    expect(stored.steps[0]).not.toHaveProperty("evil");
  });
});

describe("rate limit", () => {
  beforeEach(() => start({ rateLimit: 5 }));
  it("answers 429 once the window budget is spent", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await raw("/api/runs")).status);
    expect(statuses.slice(0, 5).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(5).every((s) => s === 429)).toBe(true);
  });
});

describe("response headers", () => {
  beforeEach(() => start());

  it("API answers are no-store, nosniff, same-origin", async () => {
    const r = await raw("/api/runs");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(r.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("the viewer policy allows scripts and connections from itself only", () => {
    expect(VIEWER_CSP).toContain("default-src 'none'");
    expect(VIEWER_CSP).toContain("script-src 'self'");
    expect(VIEWER_CSP).toContain("connect-src 'self'");
    expect(VIEWER_CSP).toContain("frame-ancestors 'none'");
    expect(VIEWER_CSP).not.toMatch(/unsafe-inline|unsafe-eval|\*|https?:/);
  });
});

describe("bind address", () => {
  it("knows which addresses stay on this machine", () => {
    for (const h of ["127.0.0.1", "localhost", "::1", "127.1.2.3"]) expect(isLoopbackHost(h), h).toBe(true);
    for (const h of ["0.0.0.0", "::", "192.168.1.5", "example.com"]) expect(isLoopbackHost(h), h).toBe(false);
  });
});
