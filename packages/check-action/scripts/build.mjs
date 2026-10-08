// Bundle the action into one self-contained dist/index.js (no runtime install, no network) and
// collect the licenses of every third-party package that ended up in the bundle.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");

// Keep this in step with `runs.using` in action.yml (node24 is the newest runtime GitHub supports).
const TARGET = "node24";

await mkdir(dist, { recursive: true });
// The workspace package is "type": "module"; the bundle is CommonJS (the public repository has no
// package.json at all, so Node treats dist/index.js as CommonJS there). This marker makes the local
// copy behave the same; it is NOT part of the published files.
await writeFile(path.join(dist, "package.json"), `${JSON.stringify({ type: "commonjs" })}\n`);
const result = await build({
  entryPoints: [path.join(root, "src/index.ts")],
  outfile: path.join(dist, "index.js"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: TARGET,
  minify: false,
  sourcemap: false,
  legalComments: "none",
  metafile: true,
  logLevel: "warning",
});

// Third-party packages that contribute code to the bundle (not merely imported and tree-shaken): the directory right after the last `node_modules/` segment.
const packages = new Map();
const emitted = Object.values(result.metafile.outputs)[0].inputs;
for (const [input, info] of Object.entries(emitted)) {
  if (info.bytesInOutput === 0) continue; // tree-shaken away: not part of the shipped code
  const idx = input.lastIndexOf("node_modules/");
  if (idx < 0) continue;
  const rest = input.slice(idx + "node_modules/".length).split("/");
  const name = rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
  const dir = path.join(root, input.slice(0, idx + "node_modules/".length), name);
  packages.set(name, dir);
}

const sections = [];
for (const [name, dir] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
  let pkg = {};
  try {
    pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    /* no package.json at the expected place */
  }
  const licenseFile = existsSync(dir) ? readdirSync(dir).find((f) => /^licen[cs]e(\.|$)/i.test(f)) : undefined;
  const text = licenseFile ? readFileSync(path.join(dir, licenseFile), "utf8").trim() : "(no license file shipped; see the package metadata)";
  sections.push(`${name}@${pkg.version ?? "?"}\nLicense: ${typeof pkg.license === "string" ? pkg.license : JSON.stringify(pkg.license ?? "unknown")}\n\n${text}`);
}

const own = "Steplight (packages @steplight/core, @steplight/cli check formatters and this action) is licensed under the Apache License 2.0; see LICENSE.";
await writeFile(
  path.join(dist, "licenses.txt"),
  `Third-party software bundled into dist/index.js (${packages.size} package${packages.size === 1 ? "" : "s"}).\n${own}\n\n${sections.join("\n\n" + "=".repeat(72) + "\n\n")}\n`,
);
console.log(`check-action: bundled dist/index.js (target ${TARGET}), ${packages.size} third-party package(s) in dist/licenses.txt`);
