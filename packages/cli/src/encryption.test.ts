import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { writeRun, type Run } from "@steplight/core/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "./index.js";
import { createViewerServer, type ViewerServer } from "./server.js";

let dir: string;
let work: string;
const KEY = randomBytes(32).toString("hex");

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "steplight-cli-enc-"));
  work = await mkdtemp(path.join(os.tmpdir(), "steplight-cli-work-"));
  delete process.env["STEPLIGHT_ENCRYPTION_KEY"];
});
afterEach(async () => {
  delete process.env["STEPLIGHT_ENCRYPTION_KEY"];
  delete process.env["STEPLIGHT_PW_TEST"];
  await rm(dir, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

const run: Run = {
  id: "cli-1",
  task: "CLI-PRIVATE-TASK",
  startedAt: 1,
  endedAt: 3,
  status: "success",
  meta: {},
  steps: [
    { id: "s0", runId: "cli-1", index: 0, kind: "page_read", timestamp: 2, url: "http://x.test/CLI-PATH?q=CLI-QUERY", snapshotRef: "snapshots/s0.txt", flags: [] },
  ],
};

async function diskText(root: string): Promise<string> {
  let out = "";
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else out += (await readFile(full, "utf8")) + "\n";
    }
  };
  await walk(root);
  return out;
}

describe("the server encrypts what the extension sends when a key is set", () => {
  let server: ViewerServer;
  let base: string;
  const post = (body: unknown) =>
    fetch(`${base}/api/ingest`, { method: "POST", headers: { authorization: `Bearer ${server.token}` }, body: JSON.stringify(body) });
  const get = (p: string) => fetch(`${base}${p}`, { headers: { authorization: `Bearer ${server.token}` } });

  beforeEach(async () => {
    process.env["STEPLIGHT_ENCRYPTION_KEY"] = KEY;
    server = createViewerServer({ runsDir: dir });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  it("raw files hold no plaintext, and the API still serves the run", async () => {
    await post({ type: "run_start", run: { id: "ext-1", task: "SERVER-PRIVATE-TASK", startedAt: 1 } });
    await post({
      type: "step",
      runId: "ext-1",
      step: { id: "s0", runId: "ext-1", index: 0, kind: "page_read", timestamp: 2, url: "http://x.test/SERVER-PATH", flags: [] },
      snapshot: "SERVER-SNAPSHOT-TEXT",
    });
    await post({ type: "run_end", runId: "ext-1", status: "success", endedAt: 3 });
    const disk = await diskText(dir);
    for (const p of ["SERVER-PRIVATE-TASK", "SERVER-PATH", "SERVER-SNAPSHOT-TEXT"]) expect(disk, p).not.toContain(p);
    expect(((await (await get("/api/runs")).json()) as { task: string }[])[0]!.task).toBe("SERVER-PRIVATE-TASK");
    expect(await (await get("/api/runs/ext-1/snapshot/s0")).text()).toBe("SERVER-SNAPSHOT-TEXT");
  });
});

describe("--encrypt", () => {
  it("refuses to start without a key", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await buildProgram().parseAsync(["node", "steplight", "view", "--encrypt", "--dir", dir, "--port", "0"]);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("--encrypt needs a key"));
    expect(process.exitCode).toBe(2);
  });
});

describe("export flags and decrypt", () => {
  it("report --password-env writes a page with no plaintext; decrypt restores the report", async () => {
    await writeRun(dir, run, { s0: "CLI-SNAPSHOT-TEXT" });
    process.env["STEPLIGHT_PW_TEST"] = "cli-pass";
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const out = path.join(work, "r.locked.html");
    await buildProgram().parseAsync(["node", "steplight", "report", "cli-1", "--dir", dir, "--out", out, "--password-env", "STEPLIGHT_PW_TEST"]);
    const html = await readFile(out, "utf8");
    for (const p of ["CLI-PRIVATE-TASK", "CLI-SNAPSHOT-TEXT"]) expect(html, p).not.toContain(p);
    const plain = path.join(work, "r.html");
    await buildProgram().parseAsync(["node", "steplight", "decrypt", out, "--password-env", "STEPLIGHT_PW_TEST", "--out", plain]);
    expect(await readFile(plain, "utf8")).toContain("CLI-PRIVATE-TASK");
  });

  it("export --bundle with --strip-* flags and a password round-trips through decrypt", async () => {
    await writeRun(dir, run, { s0: "CLI-SNAPSHOT-TEXT" });
    process.env["STEPLIGHT_PW_TEST"] = "cli-pass";
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const plain = path.join(work, "lean.json");
    await buildProgram().parseAsync(["node", "steplight", "export", "cli-1", "--bundle", "--dir", dir, "--out", plain, "--strip-snapshots", "--strip-query"]);
    const lean = await readFile(plain, "utf8");
    expect(lean).not.toContain("CLI-SNAPSHOT-TEXT");
    expect(lean).not.toContain("CLI-QUERY");
    expect(lean).toContain("CLI-PRIVATE-TASK");

    const locked = path.join(work, "x.locked.json");
    await buildProgram().parseAsync(["node", "steplight", "export", "cli-1", "--bundle", "--dir", dir, "--out", locked, "--password-env", "STEPLIGHT_PW_TEST"]);
    expect(await readFile(locked, "utf8")).not.toContain("CLI-PRIVATE-TASK");
    const back = path.join(work, "x.json");
    await buildProgram().parseAsync(["node", "steplight", "decrypt", locked, "--password-env", "STEPLIGHT_PW_TEST", "--out", back]);
    expect(JSON.parse(await readFile(back, "utf8"))).toMatchObject({ format: "steplight-run", run: { task: "CLI-PRIVATE-TASK" } });
  });

  it("a missing password variable or a wrong password is a clear error, not a crash", async () => {
    await writeRun(dir, run, {});
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await buildProgram().parseAsync(["node", "steplight", "report", "cli-1", "--dir", dir, "--out", path.join(work, "a.html"), "--password-env", "NOT_SET_ANYWHERE"]);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("NOT_SET_ANYWHERE"));
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    process.env["STEPLIGHT_PW_TEST"] = "right";
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const locked = path.join(work, "b.locked.json");
    await buildProgram().parseAsync(["node", "steplight", "export", "cli-1", "--bundle", "--dir", dir, "--out", locked, "--password-env", "STEPLIGHT_PW_TEST"]);
    process.env["STEPLIGHT_PW_TEST"] = "wrong";
    await buildProgram().parseAsync(["node", "steplight", "decrypt", locked, "--password-env", "STEPLIGHT_PW_TEST", "--out", path.join(work, "c.json")]);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("Wrong password"));
    expect(process.exitCode).toBe(1);
    await writeFile(path.join(work, "keep"), "");
  });
});
