// Tiny local servers used by the demo and tests: a "site" serving ./public and a
// separate "collector" origin (another port) standing in for an unknown third-party domain.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript" };

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server.address().port));
  });
}

/**
 * Start the fixtures site and the collector origin on two ports (0 = pick free ports).
 * @param {{ port?: number, collectorPort?: number }} [options]
 * @returns {Promise<{ url: string, collectorUrl: string, received: string[], close: () => Promise<void> }>}
 * @example const site = await startFixtureSites(); // site.url → http://127.0.0.1:PORT
 */
export async function startFixtureSites(options = {}) {
  const received = [];
  const collector = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push(`${req.method} ${req.url} ${body}`);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><title>Received</title><h1>Received</h1>");
    });
  });
  const collectorPort = await listen(collector, options.collectorPort ?? 0);
  const collectorUrl = `http://127.0.0.1:${collectorPort}`;

  const site = createServer(async (req, res) => {
    try {
      const name = new URL(req.url ?? "/", "http://x").pathname.replace(/^\/+/, "") || "index.html";
      const file = path.join(PUBLIC_DIR, name);
      if (!file.startsWith(PUBLIC_DIR + path.sep)) throw new Error("bad path");
      let content = await readFile(file, "utf8");
      content = content.replaceAll("__COLLECTOR_URL__", collectorUrl);
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "text/plain" });
      res.end(content);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  });
  const sitePort = await listen(site, options.port ?? 0);

  return {
    url: `http://127.0.0.1:${sitePort}`,
    collectorUrl,
    received,
    close: () =>
      new Promise((resolve) => {
        site.closeAllConnections?.();
        collector.closeAllConnections?.();
        site.close(() => collector.close(() => resolve()));
      }),
  };
}

// Run directly: `node server.mjs` serves on 4001 / 4002.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const s = await startFixtureSites({ port: 4001, collectorPort: 4002 });
  console.log(`fixtures: ${s.url}  collector: ${s.collectorUrl}`);
}
