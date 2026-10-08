import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { afterAll, describe, expect, it } from "vitest";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED = ["LICENSE", "README.md", "SECURITY.md", "action.yml", "dist/index.js", "dist/licenses.txt"];
const tmp: string[] = [];
afterAll(async () => {
  for (const d of tmp) await rm(d, { recursive: true, force: true });
});

async function files(dir: string, base = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (!base && e.name === ".git") continue;
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await files(path.join(dir, e.name), rel)));
    else out.push(rel);
  }
  return out.sort();
}

describe("pnpm assemble", () => {
  it("writes exactly the allow-listed files, removes strays (workflows included) and keeps .git", async () => {
    const out = await mkdtemp(path.join(os.tmpdir(), "steplight-assemble-"));
    tmp.push(out);
    await mkdir(path.join(out, ".github", "workflows"), { recursive: true });
    await writeFile(path.join(out, ".github", "workflows", "ci.yml"), "name: x\n");
    await writeFile(path.join(out, "stray.txt"), "x");
    await mkdir(path.join(out, ".git"), { recursive: true });
    await writeFile(path.join(out, ".git", "HEAD"), "ref: refs/heads/main\n");

    const r = spawnSync(process.execPath, [path.join(PKG, "scripts", "assemble.mjs")], { cwd: PKG, encoding: "utf8", env: { ...process.env, ASSEMBLE_OUT: out } });
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(await files(out)).toEqual(ALLOWED);
    expect(await readFile(path.join(out, ".git", "HEAD"), "utf8")).toContain("refs/heads/main");
    expect(r.stdout).toContain("dist/index.js");
  });
});

describe("action.yml", () => {
  it("meets the Marketplace rules and matches what the code reads and writes", async () => {
    const meta = parse(await readFile(path.join(PKG, "publish", "action.yml"), "utf8"));
    expect(meta.name).toBe("Steplight Agent Check");
    expect(meta.description.length).toBeLessThanOrEqual(125);
    expect(meta.author).toBe("Thirumalaiboobathi B");
    expect(meta.branding).toEqual({ icon: "shield", color: "purple" });
    expect(meta.runs).toEqual({ using: "node24", main: "dist/index.js" });

    expect(Object.keys(meta.inputs).sort()).toEqual(["fail-on", "format", "output-file", "rules", "run-id", "runs-dir"]);
    expect(meta.inputs["runs-dir"].default).toBe(".steplight/runs");
    expect(meta.inputs["rules"].default).toBe("steplight.rules.yml");
    expect(meta.inputs["format"].default).toBe("text");
    expect(meta.inputs["fail-on"].default).toBe("high");
    expect(Object.keys(meta.outputs).sort()).toEqual(["flag-count", "max-severity", "report-file", "result"]);

    const main = await readFile(path.join(PKG, "src", "main.ts"), "utf8");
    for (const name of Object.keys(meta.outputs)) expect(main).toContain(`"${name}"`);
    const inputs = await readFile(path.join(PKG, "src", "inputs.ts"), "utf8");
    for (const name of Object.keys(meta.inputs)) expect(inputs).toContain(`"${name}"`);
  });

  it("uses the same Node target in the bundle and in action.yml", async () => {
    const build = await readFile(path.join(PKG, "scripts", "build.mjs"), "utf8");
    const meta = parse(await readFile(path.join(PKG, "publish", "action.yml"), "utf8"));
    expect(build).toContain(`const TARGET = "${meta.runs.using}"`);
  });

  it("the public README documents every input and output and pins its examples by SHA", async () => {
    const meta = parse(await readFile(path.join(PKG, "publish", "action.yml"), "utf8"));
    const readme = await readFile(path.join(PKG, "publish", "README.md"), "utf8");
    for (const name of [...Object.keys(meta.inputs), ...Object.keys(meta.outputs)]) expect(readme).toContain(`\`${name}\``);
    for (const m of readme.matchAll(/uses:\s*(\S+)@(\S+)/g)) expect(m[2], m[1]).toMatch(/^([0-9a-f]{40}|<full-commit-sha>)$/);
    expect(readme).not.toMatch(/\.github\/workflows/);
  });
});
