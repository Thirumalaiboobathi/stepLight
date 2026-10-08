import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Run } from "../types.js";
import { EncryptedRunError, isEncryptedText } from "./fileCrypto.js";
import { RunWriter, countEncryptedRuns, listRuns, purgeRuns, readRun, readSnapshot, writeRun } from "./runStore.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "steplight-enc-"));
  delete process.env["STEPLIGHT_ENCRYPTION_KEY"];
  delete process.env["STEPLIGHT_PASSPHRASE"];
});
afterEach(async () => {
  delete process.env["STEPLIGHT_ENCRYPTION_KEY"];
  delete process.env["STEPLIGHT_PASSPHRASE"];
  await rm(dir, { recursive: true, force: true });
});

const KEY = randomBytes(32).toString("hex");
const PLAIN = ["PLAIN-TASK", "PLAIN-URL-PATH", "PLAIN-EVIDENCE", "PLAIN-SNAPSHOT-TEXT", "PLAIN-META"];

const sample = (id: string, startedAt = Date.now()): Run => ({
  id,
  task: "PLAIN-TASK",
  startedAt,
  endedAt: startedAt + 5,
  status: "success",
  meta: { note: "PLAIN-META" },
  steps: [
    {
      id: "s0",
      runId: id,
      index: 0,
      kind: "page_read",
      timestamp: startedAt + 1,
      url: "https://private.example/PLAIN-URL-PATH",
      snapshotRef: "snapshots/s0.txt",
      flags: [{ type: "hidden_instruction", severity: "high", message: "m", evidence: "PLAIN-EVIDENCE" }],
    },
  ],
});

async function allFileText(root: string): Promise<string> {
  let out = "";
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else out += `${await readFile(full, "utf8")}\n`;
    }
  };
  await walk(root);
  return out;
}

describe("encrypted run files", () => {
  it("with a key: nothing from the run is readable on disk, and it reads back with the key", async () => {
    await writeRun(dir, sample("r1"), { s0: "PLAIN-SNAPSHOT-TEXT body" }, { key: KEY });
    const disk = await allFileText(dir);
    for (const p of PLAIN) expect(disk, p).not.toContain(p);
    expect(isEncryptedText(await readFile(path.join(dir, "r1", "run.json"), "utf8"))).toBe(true);
    expect(isEncryptedText(await readFile(path.join(dir, "r1", "snapshots", "s0.txt"), "utf8"))).toBe(true);
    const run = await readRun(dir, "r1", { key: KEY });
    expect(run.task).toBe("PLAIN-TASK");
    expect(run.steps[0]!.flags[0]!.evidence).toBe("PLAIN-EVIDENCE");
    expect(await readSnapshot(dir, "r1", run.steps[0]!, { key: KEY })).toBe("PLAIN-SNAPSHOT-TEXT body");
  });

  it("the environment variable turns encryption on for every writer and reader", async () => {
    process.env["STEPLIGHT_ENCRYPTION_KEY"] = KEY;
    await writeRun(dir, sample("r1"), { s0: "PLAIN-SNAPSHOT-TEXT" });
    expect(await allFileText(dir)).not.toContain("PLAIN-TASK");
    expect((await listRuns(dir)).map((r) => r.id)).toEqual(["r1"]);
    delete process.env["STEPLIGHT_ENCRYPTION_KEY"];
    expect(await listRuns(dir)).toEqual([]); // cannot be read without the key
    await expect(readRun(dir, "r1")).rejects.toThrow(EncryptedRunError);
    expect(await countEncryptedRuns(dir)).toBe(1);
  });

  it("a wrong key never yields data", async () => {
    await writeRun(dir, sample("r1"), { s0: "x" }, { key: KEY });
    await expect(readRun(dir, "r1", { key: randomBytes(32).toString("hex") })).rejects.toThrow(/Could not decrypt/);
  });

  it("unique IV for every record, and records cannot be swapped between files", async () => {
    const writer = await RunWriter.create(dir, sample("r1"), { key: KEY });
    for (let i = 0; i < 5; i++) await writer.addStep({ ...sample("r1").steps[0]!, id: `s${i}`, index: i, snapshotRef: undefined }, undefined);
    const lines = (await readFile(path.join(dir, "r1", "steps.jsonl"), "utf8")).trim().split("\n");
    const ivs = lines.map((l) => (JSON.parse(l) as { iv: string }).iv);
    expect(new Set(ivs).size).toBe(5);
    // Copy a step line into another run's steps.jsonl: authenticated data differs, so it is rejected.
    await writeRun(dir, { ...sample("r2"), steps: [] }, {}, { key: KEY });
    await writeFile(path.join(dir, "r2", "steps.jsonl"), lines[0] + "\n");
    expect((await readRun(dir, "r2", { key: KEY }).catch((e: Error) => e.name))).toBe("EncryptedRunError");
  });

  it("a passphrase is stretched with scrypt; the wrong passphrase is reported clearly", async () => {
    await writeRun(dir, sample("r1"), { s0: "PLAIN-SNAPSHOT-TEXT" }, { passphrase: "correct horse battery" });
    expect(await allFileText(dir)).not.toContain("PLAIN-TASK");
    const saltFile = JSON.parse(await readFile(path.join(dir, ".steplight-enc.json"), "utf8")) as Record<string, unknown>;
    expect(saltFile).toMatchObject({ kdf: "scrypt", N: 32768 });
    expect(JSON.stringify(saltFile)).not.toContain("correct horse");
    expect((await readRun(dir, "r1", { passphrase: "correct horse battery" })).task).toBe("PLAIN-TASK");
    await expect(readRun(dir, "r1", { passphrase: "wrong" })).rejects.toThrow("Wrong passphrase");
  });

  it("rejects keys of the wrong size", async () => {
    await expect(writeRun(dir, sample("r1"), {}, { key: "abcd" })).rejects.toThrow("32 bytes");
  });

  it("purge and delete work on encrypted runs without the key", async () => {
    await writeRun(dir, sample("old", Date.now() - 30 * 86_400_000), {}, { key: KEY });
    await writeRun(dir, sample("new"), {}, { key: KEY });
    // Without the key the run's start time is unreadable: its file time (just now) is used, so nothing expires.
    expect(await purgeRuns(dir, { olderThanDays: 7 })).toEqual([]);
    expect(await purgeRuns(dir, { olderThanDays: 7, encryption: { key: KEY } })).toEqual(["old"]);
    expect(await purgeRuns(dir, { all: true })).toEqual(["new"]); // --all needs no key
    expect((await readdir(dir)).filter((n) => !n.startsWith("."))).toEqual([]);
  });

  it("unencrypted writes still work and are private to the owner on POSIX", async () => {
    await writeRun(dir, sample("plain"), { s0: "PLAIN-SNAPSHOT-TEXT" });
    expect(await allFileText(dir)).toContain("PLAIN-TASK");
    if (process.platform !== "win32") {
      for (const f of ["run.json", "steps.jsonl", "snapshots/s0.txt"]) {
        expect((await stat(path.join(dir, "plain", f))).mode & 0o077, f).toBe(0);
      }
      expect((await stat(path.join(dir, "plain"))).mode & 0o077).toBe(0);
    }
  });
});
