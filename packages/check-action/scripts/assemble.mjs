// Rebuild the action and write exactly the files of the public repository to out/check-action/.
// A `.git` folder in the output (the public repository's own history) is left untouched.
// Fails if anything outside the allow-list is present, or if action.yml breaks a Marketplace rule.
import { spawnSync } from "node:child_process";
import { cp, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = process.env["ASSEMBLE_OUT"] ? path.resolve(process.env["ASSEMBLE_OUT"]) : path.resolve(pkg, "..", "..", "out", "check-action"); // ASSEMBLE_OUT: tests only

/** The complete content of the public repository. */
const ALLOWED = ["action.yml", "dist/index.js", "dist/licenses.txt", "README.md", "LICENSE", "SECURITY.md"];
const SOURCES = {
  "action.yml": "publish/action.yml",
  "dist/index.js": "dist/index.js",
  "dist/licenses.txt": "dist/licenses.txt",
  "README.md": "publish/README.md",
  LICENSE: "publish/LICENSE",
  "SECURITY.md": "publish/SECURITY.md",
};

function fail(message) {
  console.error(`assemble: ${message}`);
  process.exit(1);
}

// 1. Rebuild the bundle.
const build = spawnSync(process.execPath, [path.join(pkg, "scripts", "build.mjs")], { stdio: "inherit" });
if (build.status !== 0) fail("build failed");

// 2. Validate action.yml against the Marketplace and runner rules we can check offline.
const meta = parse(await readFile(path.join(pkg, SOURCES["action.yml"]), "utf8"));
if (!meta.name || typeof meta.name !== "string") fail("action.yml needs a name");
if (!meta.description || meta.description.length > 125) fail(`action.yml description must be 1-125 characters (is ${meta.description?.length ?? 0})`);
if (meta.author !== "Thirumalaiboobathi B") fail("action.yml author must be 'Thirumalaiboobathi B'");
if (!meta.branding?.icon || !meta.branding?.color) fail("action.yml needs branding.icon and branding.color");
if (!["node20", "node24"].includes(meta.runs?.using)) fail(`runs.using must be node20 or node24 (is ${meta.runs?.using})`);
if (meta.runs.main !== "dist/index.js") fail("runs.main must be dist/index.js");

// 3. Write the allow-listed files, replacing whatever was there (except .git).
await mkdir(out, { recursive: true });
for (const entry of await readdir(out)) if (entry !== ".git") await rm(path.join(out, entry), { recursive: true, force: true });
for (const [dest, src] of Object.entries(SOURCES)) {
  await mkdir(path.dirname(path.join(out, dest)), { recursive: true });
  await cp(path.join(pkg, src), path.join(out, dest));
}

// 4. Enforce the allow-list (no workflows, no stray files).
async function walk(dir, base = "") {
  const files = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (base === "" && e.name === ".git") continue;
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) files.push(...(await walk(path.join(dir, e.name), rel)));
    else files.push(rel);
  }
  return files;
}
const present = (await walk(out)).sort();
const extra = present.filter((f) => !ALLOWED.includes(f));
const missing = ALLOWED.filter((f) => !present.includes(f));
if (extra.length) fail(`files outside the allow-list: ${extra.join(", ")}`);
if (missing.length) fail(`missing files: ${missing.join(", ")}`);
if (present.some((f) => f.startsWith(".github"))) fail("an action repository must not contain workflow files");

console.log(`\nassembled ${path.relative(process.cwd(), out) || out} (${meta.name}, ${meta.runs.using}):`);
let total = 0;
for (const f of present) {
  const { size } = await stat(path.join(out, f));
  total += size;
  console.log(`  ${f.padEnd(20)} ${String(size).padStart(8)} bytes`);
}
console.log(`  ${"total".padEnd(20)} ${String(total).padStart(8)} bytes`);
