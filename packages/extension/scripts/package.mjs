// Build the extension and zip dist/ for upload to the Chrome Web Store.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");

const build = spawnSync("node", [path.join(root, "scripts/build.mjs")], { stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);

/** Collect dist files as { "relative/path": bytes }. Store-friendly: forward slashes, fixed mtime. */
function collect(dir, base = "") {
  const out = {};
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    if (statSync(full).isDirectory()) Object.assign(out, collect(full, rel));
    else out[rel] = [new Uint8Array(readFileSync(full)), { mtime: new Date("2026-01-01T00:00:00Z") }];
  }
  return out;
}

const manifest = JSON.parse(readFileSync(path.join(dist, "manifest.json"), "utf8"));
const zipPath = path.join(root, `steplight-extension-${manifest.version}.zip`);
const files = collect(dist);
writeFileSync(zipPath, zipSync(files, { level: 9 }));
console.log(`packaged ${Object.keys(files).length} files → ${zipPath} (${statSync(zipPath).size} bytes)`);
