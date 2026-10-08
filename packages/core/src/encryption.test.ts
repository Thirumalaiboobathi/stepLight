import { describe, expect, it } from "vitest";
import {
  decryptText,
  decryptWithPassword,
  encryptText,
  encryptWithPassword,
  fromB64,
  generateStorageKey,
  isEnvelope,
  isPasswordProtected,
  toB64,
} from "./crypto.js";
import { EncryptedKeyValueStore, type KeyProvider } from "./encryptedStore.js";
import { LocalRunStore, type KeyValueStore } from "./localStore.js";

function memoryKv(): KeyValueStore & { dump(): string } {
  const data = new Map<string, unknown>();
  return {
    async get(keys) {
      const list = keys === null ? [...data.keys()] : Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))]));
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v));
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
    },
    dump: () => JSON.stringify([...data.entries()]),
  };
}

const provider = async (): Promise<KeyProvider> => {
  const key = await generateStorageKey();
  return { getKey: async () => key };
};

describe("AES-GCM helpers", () => {
  it("round-trips, with a fresh IV every time", async () => {
    const key = await generateStorageKey();
    const a = await encryptText(key, "hello ✓", "k");
    const b = await encryptText(key, "hello ✓", "k");
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
    expect(a.ct).not.toContain("hello");
    expect(await decryptText(key, a, "k")).toBe("hello ✓");
    expect(isEnvelope(a)).toBe(true);
    expect(isEnvelope({})).toBe(false);
  });
  it("fails on a wrong key, a changed ciphertext or a different record name", async () => {
    const key = await generateStorageKey();
    const other = await generateStorageKey();
    const env = await encryptText(key, "secret", "sl:meta:a");
    await expect(decryptText(other, env, "sl:meta:a")).rejects.toThrow();
    await expect(decryptText(key, env, "sl:meta:b")).rejects.toThrow();
    const bytes = fromB64(env.ct);
    bytes[0] = bytes[0]! ^ 1;
    await expect(decryptText(key, { ...env, ct: toB64(bytes) }, "sl:meta:a")).rejects.toThrow();
  });
  it("the generated key cannot be exported", async () => {
    const key = await generateStorageKey();
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
  });
});

describe("password-protected exports", () => {
  it("round-trips and does not contain the plaintext", async () => {
    const file = await encryptWithPassword("TOP-SECRET {run}", "correct horse", "run-json", 2000);
    expect(isPasswordProtected(file)).toBe(true);
    expect(JSON.stringify(file)).not.toContain("TOP-SECRET");
    expect(await decryptWithPassword(file, "correct horse")).toBe("TOP-SECRET {run}");
  });
  it("rejects a wrong password with a plain message, and never accepts weak settings", async () => {
    const file = await encryptWithPassword("x", "pw", "report-html", 2000);
    await expect(decryptWithPassword(file, "nope")).rejects.toThrow("Wrong password or damaged file");
    await expect(decryptWithPassword({ ...file, iterations: 1 }, "pw")).rejects.toThrow("Unsupported");
    await expect(encryptWithPassword("x", "", "run-json")).rejects.toThrow("password");
  });
  it("binds the kind: a report cannot be opened as a run file", async () => {
    const file = await encryptWithPassword("x", "pw", "report-html", 2000);
    await expect(decryptWithPassword({ ...file, kind: "run-json" }, "pw")).rejects.toThrow();
  });
});

describe("EncryptedKeyValueStore", () => {
  it("stores nothing readable under covered keys, and reads it back", async () => {
    const raw = memoryKv();
    const kv = new EncryptedKeyValueStore(raw, await provider());
    await kv.set({ "sl:meta:r1": { task: "Book a flight to PRIVATE-CITY" }, other: "plain" });
    expect(raw.dump()).not.toContain("PRIVATE-CITY");
    expect(raw.dump()).toContain("plain"); // keys outside the prefix are untouched
    expect(await kv.get("sl:meta:r1")).toEqual({ "sl:meta:r1": { task: "Book a flight to PRIVATE-CITY" } });
  });

  it("a whole recorded run is unreadable on disk but fully usable through the store", async () => {
    const raw = memoryKv();
    const kv = new EncryptedKeyValueStore(raw, await provider());
    const store = new LocalRunStore(kv);
    await store.startRun({ id: "run1", task: "PLAINTEXT-TASK", startedAt: 5, meta: { note: "PLAINTEXT-META" } });
    await store.addStep(
      "run1",
      {
        id: "s0",
        runId: "run1",
        index: 0,
        kind: "page_read",
        timestamp: 6,
        url: "https://private.example/PLAINTEXT-PATH",
        flags: [{ type: "hidden_instruction", severity: "high", message: "PLAINTEXT-MESSAGE", evidence: "PLAINTEXT-EVIDENCE" }],
      },
      "PLAINTEXT-SNAPSHOT page text",
    );
    await store.finishRun("run1", "success", 9);
    for (const needle of ["PLAINTEXT-TASK", "PLAINTEXT-META", "PLAINTEXT-PATH", "PLAINTEXT-MESSAGE", "PLAINTEXT-EVIDENCE", "PLAINTEXT-SNAPSHOT"]) {
      expect(raw.dump(), needle).not.toContain(needle);
    }
    const run = await store.getRun("run1");
    expect(run?.task).toBe("PLAINTEXT-TASK");
    expect(run?.steps[0]?.flags[0]?.evidence).toBe("PLAINTEXT-EVIDENCE");
    expect(await store.getSnapshot("run1", "s0")).toBe("PLAINTEXT-SNAPSHOT page text");
    expect((await store.listRuns())[0]).toMatchObject({ id: "run1", status: "success", maxSeverity: "high" });
  });

  it("with another key the data is simply gone (never returned raw); clear() still deletes it", async () => {
    const raw = memoryKv();
    const store = new LocalRunStore(new EncryptedKeyValueStore(raw, await provider()));
    await store.startRun({ id: "r", task: "t", startedAt: 1 });
    const stranger = new LocalRunStore(new EncryptedKeyValueStore(raw, await provider())); // different key
    expect(await stranger.listRuns()).toEqual([]);
    await stranger.clear();
    expect(JSON.parse(raw.dump())).toEqual([]);
  });

  it("refuses a value moved to another key (tamper check)", async () => {
    const raw = memoryKv();
    const kv = new EncryptedKeyValueStore(raw, await provider());
    await kv.set({ "sl:meta:a": { n: 1 } });
    const moved = (await raw.get("sl:meta:a"))["sl:meta:a"];
    await raw.set({ "sl:meta:b": moved });
    expect(await kv.get("sl:meta:b")).toEqual({});
  });

  it("migrate() encrypts values stored before encryption existed", async () => {
    const raw = memoryKv();
    await raw.set({ "sl:meta:old": { task: "LEGACY-PLAINTEXT" }, "sl-settings": { captureLevel: "full" } });
    const kv = new EncryptedKeyValueStore(raw, await provider());
    expect(await kv.get("sl:meta:old")).toEqual({ "sl:meta:old": { task: "LEGACY-PLAINTEXT" } }); // still readable
    expect(await kv.migrate()).toBe(1);
    expect(raw.dump()).not.toContain("LEGACY-PLAINTEXT");
    expect(raw.dump()).toContain("captureLevel"); // settings are not run data
    expect(await kv.migrate()).toBe(0);
    expect(await kv.get("sl:meta:old")).toEqual({ "sl:meta:old": { task: "LEGACY-PLAINTEXT" } });
  });

  it("retention still works on encrypted data", async () => {
    const raw = memoryKv();
    const store = new LocalRunStore(new EncryptedKeyValueStore(raw, await provider()));
    await store.startRun({ id: "old", task: "OLD-TASK", startedAt: 1 });
    await store.startRun({ id: "new", task: "NEW", startedAt: 10_000 });
    expect(await store.deleteOlderThan(5000)).toEqual(["old"]);
    expect((await store.listRuns()).map((r) => r.id)).toEqual(["new"]);
  });
});
