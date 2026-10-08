import { decryptText, encryptText, isEnvelope } from "./crypto.js";
import type { KeyValueStore } from "./localStore.js";

/** Supplies the AES-GCM key (created on first use, then kept; in the extension: non-extractable, in IndexedDB). */
export interface KeyProvider {
  getKey(): Promise<CryptoKey>;
}

/**
 * Wraps a key/value store (chrome.storage.local) and encrypts every value whose key starts with
 * `prefix` using AES-256-GCM with a fresh random IV per record. The storage key name is bound to
 * the ciphertext as additional authenticated data, so a value cannot be moved to another key.
 * Key NAMES stay readable (run ids, step numbers); everything stored under them is encrypted.
 * Values that fail to decrypt (wrong key, tampering) are left out of results, never returned raw.
 * Plain values written before encryption existed are still readable and `migrate()` encrypts them.
 * @example const kv = new EncryptedKeyValueStore(chromeStorageAdapter, indexedDbKeyProvider)
 */
export class EncryptedKeyValueStore implements KeyValueStore {
  constructor(
    private readonly inner: KeyValueStore,
    private readonly keys_: KeyProvider,
    private readonly prefix = "sl:",
  ) {}

  private covers(key: string): boolean {
    return key.startsWith(this.prefix);
  }

  async get(keys: string | string[] | null): Promise<Record<string, unknown>> {
    const raw = await this.inner.get(keys);
    const key = await this.keys_.getKey();
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!this.covers(k) || !isEnvelope(v)) {
        out[k] = v; // not ours, or a legacy plain value
        continue;
      }
      try {
        out[k] = JSON.parse(await decryptText(key, v, k));
      } catch {
        /* wrong key or tampered: leave it out */
      }
    }
    return out;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    const key = await this.keys_.getKey();
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(items)) {
      out[k] = this.covers(k) ? await encryptText(key, JSON.stringify(v), k) : v;
    }
    await this.inner.set(out);
  }

  remove(keys: string | string[]): Promise<void> {
    return this.inner.remove(keys);
  }

  /** Every stored key name, including entries that can no longer be decrypted (so they can still be deleted). */
  async keys(): Promise<string[]> {
    return Object.keys(await this.inner.get(null));
  }

  /** Encrypt in place any covered value that is still stored as plain data. Returns how many were converted. */
  async migrate(): Promise<number> {
    const raw = await this.inner.get(null);
    const plain = Object.entries(raw).filter(([k, v]) => this.covers(k) && !isEnvelope(v));
    if (plain.length > 0) await this.set(Object.fromEntries(plain));
    return plain.length;
  }
}
