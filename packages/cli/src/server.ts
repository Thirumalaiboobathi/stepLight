import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  RunWriter,
  isSafeId,
  listRuns,
  newRunId,
  parseBundle,
  writeRun,
  readRun,
  readSnapshot,
  type Run,
  type Step,
} from "@steplight/core/node";

/** Options for {@link createViewerServer}. */
export interface ServerOptions {
  /** Folder containing run folders (`.steplight/runs`). */
  runsDir: string;
  /** Folder holding the built viewer (index.html + assets). Optional. */
  viewerDir?: string;
}

const MAX_BODY = 8 * 1024 * 1024;
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

/**
 * Locate the built viewer: next to the CLI (published layout) or in the monorepo.
 * @example const dir = findViewerDir(import.meta.url)
 */
export function findViewerDir(fromDir: string): string | undefined {
  const candidates = [
    path.resolve(fromDir, "../viewer-dist"),
    path.resolve(fromDir, "../../viewer/dist"),
  ];
  return candidates.find((c) => existsSync(path.join(c, "index.html")));
}

function send(res: ServerResponse, status: number, body: string | Buffer, type: string): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

function json(res: ServerResponse, status: number, data: unknown): void {
  send(res, status, JSON.stringify(data), "application/json");
}

async function readBody(req: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Message accepted by `POST /api/ingest` (sent by the Chrome extension). */
export type IngestMessage =
  | { type: "run_start"; run: Pick<Run, "id" | "task" | "startedAt"> & { meta?: Run["meta"] } }
  | { type: "step"; runId: string; step: Step; snapshot?: string }
  | { type: "run_end"; runId: string; status: "success" | "failed"; endedAt?: number };

/**
 * Create (but do not start) the local HTTP server: JSON API over the runs folder,
 * an ingest endpoint for the extension, and static files for the viewer.
 * Only meant to be bound to localhost.
 * @example createViewerServer({ runsDir: ".steplight/runs" }).listen(4777, "127.0.0.1")
 */
export function createViewerServer(options: ServerOptions): Server {
  const writers = new Map<string, RunWriter>();
  const cors = (res: ServerResponse) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type");
  };

  async function ingest(msg: IngestMessage): Promise<void> {
    if (msg.type === "run_start") {
      if (!isSafeId(msg.run.id)) throw new Error("bad run id");
      const run: Run = { ...msg.run, status: "running", steps: [], meta: msg.run.meta ?? {} };
      writers.set(msg.run.id, await RunWriter.create(options.runsDir, run));
      return;
    }
    const writer = writers.get(msg.runId);
    if (!writer) throw new Error("unknown run (send run_start first)");
    if (msg.type === "step") {
      await writer.addStep({ ...msg.step, runId: msg.runId }, msg.snapshot);
    } else {
      await writer.finish(msg.status, msg.endedAt ?? Date.now());
      writers.delete(msg.runId);
    }
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]
    if (req.method === "POST" && url.pathname === "/api/ingest") {
      await ingest(JSON.parse(await readBody(req)) as IngestMessage);
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/import") {
      const bundle = parseBundle(await readBody(req));
      const exists = await readRun(options.runsDir, bundle.run.id).then(() => true, () => false);
      const run = exists ? { ...bundle.run, id: newRunId() } : bundle.run;
      await writeRun(options.runsDir, run, bundle.snapshots);
      return json(res, 200, { id: run.id });
    }
    if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
    if (url.pathname === "/api/runs") return json(res, 200, await listRuns(options.runsDir));
    if (parts[1] === "runs" && parts[2]) {
      const id = decodeURIComponent(parts[2]);
      if (!isSafeId(id)) return json(res, 400, { error: "bad run id" });
      const run = await readRun(options.runsDir, id).catch(() => undefined);
      if (!run) return json(res, 404, { error: "run not found" });
      if (parts.length === 3) return json(res, 200, run);
      if (parts[3] === "snapshot" && parts[4]) {
        const step = run.steps.find((s) => s.id === decodeURIComponent(parts[4]!));
        const text = step ? await readSnapshot(options.runsDir, id, step) : undefined;
        if (text === undefined) return json(res, 404, { error: "snapshot not found" });
        return send(res, 200, text, "text/plain; charset=utf-8");
      }
    }
    json(res, 404, { error: "not found" });
  }

  async function handleStatic(res: ServerResponse, url: URL): Promise<void> {
    const dir = options.viewerDir;
    if (!dir) {
      return send(res, 200, "Steplight API is running. Viewer is not built (run `pnpm -r build`).", "text/plain");
    }
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
    let file = path.resolve(dir, rel);
    if (!file.startsWith(path.resolve(dir) + path.sep)) return send(res, 403, "forbidden", "text/plain");
    if (!existsSync(file)) file = path.join(dir, "index.html"); // SPA fallback
    const body = await readFile(file);
    send(res, 200, body, MIME[path.extname(file)] ?? "application/octet-stream");
  }

  return createServer((req, res) => {
    void (async () => {
      try {
        cors(res);
        if (req.method === "OPTIONS") {
          res.writeHead(204);
          return void res.end();
        }
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname.startsWith("/api/")) await handleApi(req, res, url);
        else await handleStatic(res, url);
      } catch (err) {
        if (!res.headersSent) json(res, 400, { error: err instanceof Error ? err.message : "error" });
        else res.end();
      }
    })();
  });
}
