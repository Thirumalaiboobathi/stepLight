/// <reference lib="dom" />
import { generateStorageKey } from "./crypto.js";
import type { KeyProvider } from "./encryptedStore.js";
import type { KeyValueStore } from "./localStore.js";

const DB = "steplight-keys";
const STORE = "keys";
const ID = "storage-v1";

const request = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Key provider for the extension: one AES-256-GCM key, created on first use as a NON-EXTRACTABLE
 * CryptoKey and stored in IndexedDB (the structured clone keeps the key opaque: scripts can use it
 * to encrypt and decrypt but can never read its bytes). The service worker, the settings page and
 * the bundled viewer share it because they share the extension's origin. Creation is race-safe:
 * the first writer wins and everyone else reads that key.
 * If the key is lost (site data cleared) encrypted runs can no longer be read; that is by design.
 */
export function indexedDbKeyProvider(): KeyProvider {
  let cached: Promise<CryptoKey> | undefined;
  return {
    getKey() {
      cached ??= (async () => {
        const db = await open();
        try {
          const existing = await request(db.transaction(STORE, "readonly").objectStore(STORE).get(ID));
          if (existing) return existing as CryptoKey;
          const fresh = await generateStorageKey();
          try {
            await request(db.transaction(STORE, "readwrite").objectStore(STORE).add(fresh, ID));
            return fresh;
          } catch {
            // Someone else created it first (ConstraintError): use theirs.
            return (await request(db.transaction(STORE, "readonly").objectStore(STORE).get(ID))) as CryptoKey;
          }
        } finally {
          db.close();
        }
      })();
      return cached;
    },
  };
}

/** Adapt `chrome.storage.local` (or any compatible area) to a {@link KeyValueStore} that can also list its keys. */
export function chromeKeyValueStore(area: Omit<KeyValueStore, "keys">): KeyValueStore {
  return {
    get: (keys) => area.get(keys),
    set: (items) => area.set(items),
    remove: (keys) => area.remove(keys),
    async keys() {
      return Object.keys(await area.get(null));
    },
  };
}
