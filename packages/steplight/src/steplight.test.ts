import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as sdk from "@steplight/sdk";
import ts from "typescript";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import * as entry from "./index.js";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_BIN = path.resolve(PKG, "..", "cli", "dist", "bin.js");
const BIN = path.join(PKG, "dist", "bin.js");
const pkgJson = JSON.parse(readFileSync(path.join(PKG, "package.json"), "utf8")) as { version: string; dependencies: Record<string, string>; peerDependencies: Record<string, string>; peerDependenciesMeta: Record<string, { optional?: boolean }> };

const run = (file: string, ...args: string[]) =>
  spawnSync(process.execPath, [file, ...args], { cwd: PKG, encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", SystemRoot: process.env["SystemRoot"] ?? "" } });

beforeAll(() => {
  // the dist-level tests need this package built (and the SDK and CLI, which `pnpm -r build` provides)
  const tsc = spawnSync(process.execPath, [path.resolve(PKG, "..", "..", "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json"], { cwd: PKG, encoding: "utf8" });
  expect(tsc.status, tsc.stdout + tsc.stderr).toBe(0);
});

describe("API parity with @steplight/sdk", () => {
  it("exports exactly the SDK's runtime API, with the same values", () => {
    expect(Object.keys(entry).sort()).toEqual(Object.keys(sdk).sort());
    expect(Object.keys(entry)).toEqual(expect.arrayContaining(["steplight", "record", "VERSION"]));
    for (const key of Object.keys(sdk)) expect((entry as Record<string, unknown>)[key]).toBe((sdk as Record<string, unknown>)[key]);
  });

  it("the built entry point (what npm users import) is identical too", async () => {
    const built = (await import(path.join(PKG, "dist", "index.js").replace(/\\/g, "/").replace(/^([A-Za-z]):/, "file:///$1:"))) as Record<string, unknown>;
    expect(Object.keys(built).sort()).toEqual(Object.keys(sdk).sort());
    expect(built["steplight"]).toBe(sdk.steplight);
  });
});

describe("the steplight command", () => {
  it("--version prints the version of @steplight/cli, which is this package's version", () => {
    const mine = run(BIN, "--version");
    const cli = run(CLI_BIN, "--version");
    expect(mine.status, mine.stderr).toBe(0);
    expect(mine.stdout.trim()).toBe(cli.stdout.trim());
    expect(mine.stdout.trim()).toBe(pkgJson.version);
  });

  it("--help lists the same commands as @steplight/cli", () => {
    const mine = run(BIN, "--help");
    const cli = run(CLI_BIN, "--help");
    expect(mine.status, mine.stderr).toBe(0);
    expect(mine.stdout).toBe(cli.stdout);
    for (const command of ["view", "check", "report", "diff", "redteam", "purge"]) expect(mine.stdout).toContain(command);
    expect(mine.stdout).toContain("Usage: steplight");
  });

  it("passes arguments through and keeps the exit code (unknown format → 2)", () => {
    const r = run(BIN, "check", "--latest", "--format", "nope");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unknown format "nope"');
  });

  it("the launcher has a node shebang", () => {
    expect(readFileSync(BIN, "utf8").startsWith("#!/usr/bin/env node")).toBe(true);
  });
});

describe("type declarations", () => {
  const dir = path.join(PKG, ".types-check");
  beforeAll(() => mkdirSync(dir, { recursive: true }));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const diagnostics = (name: string, source: string): string[] => {
    const file = path.join(dir, name);
    writeFileSync(file, source);
    const program = ts.createProgram([file], {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2022,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: ["node"],
    });
    return ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
  };

  it('`import { steplight, record, VERSION, type RunHandle, type RecordOptions } from "steplight"` type-checks', () => {
    const problems = diagnostics(
      "ok.mts",
      `import { steplight, record, VERSION, type RunHandle, type RecordOptions } from "steplight";
       const options: RecordOptions = { task: "x" };
       const start: typeof steplight.record = record;
       const v: string = VERSION;
       export type Handle = RunHandle;
       export { options, start, v };`,
    );
    expect(problems).toEqual([]);
  });

  it("the declarations are real: a wrong member is rejected", () => {
    const problems = diagnostics("bad.mts", `import { steplight } from "steplight";\nsteplight.doesNotExist();\n`);
    expect(problems.join("\n")).toMatch(/doesNotExist/);
  });
});

describe("package metadata", () => {
  it("pins the SDK and CLI (exact version after pack), and Playwright is an optional peer", () => {
    expect(pkgJson.dependencies).toEqual({ "@steplight/cli": "workspace:*", "@steplight/sdk": "workspace:*" });
    expect(pkgJson.peerDependencies["playwright"]).toBe(">=1.40");
    expect(pkgJson.peerDependenciesMeta["playwright"]).toEqual({ optional: true });
  });
});
