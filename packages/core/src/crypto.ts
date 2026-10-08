/// <reference lib="dom" />
/*
 * Browser-safe encryption helpers (WebCrypto: AES-256-GCM, PBKDF2). Works in the extension,
 * the viewer and Node 20+. No dependencies. Every encryption uses a fresh random 96-bit IV.
 */

/** An AES-GCM encrypted value as stored (base64 fields). */
export interface EncryptedEnvelope {
  v: 1;
  alg: "AES-GCM";
  /** Random 96-bit nonce, unique per record. */
  iv: string;
  /** Ciphertext followed by the 128-bit authentication tag. */
  ct: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Bytes to base64. */
export function toB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Base64 to bytes. @throws on invalid input */
export function fromB64(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const subtle = (): SubtleCrypto => {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c?.subtle) throw new Error("WebCrypto is not available in this environment");
  return c.subtle;
};

/** True for the `{ v: 1, alg: "AES-GCM", iv, ct }` shape. */
export function isEnvelope(value: unknown): value is EncryptedEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return e["v"] === 1 && e["alg"] === "AES-GCM" && typeof e["iv"] === "string" && typeof e["ct"] === "string";
}

/**
 * Generate a fresh non-extractable AES-256-GCM key: it can encrypt and decrypt but its bytes can
 * never be read back by script.
 */
export function generateStorageKey(): Promise<CryptoKey> {
  return subtle().generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

/** Import raw 32-byte key material as a non-extractable AES-GCM key. */
export function importRawKey(raw: Uint8Array): Promise<CryptoKey> {
  return subtle().importKey("raw", raw as BufferSource, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/**
 * Encrypt text with a new random IV. `aad` (additional authenticated data, e.g. the storage key
 * name) is bound to the ciphertext: moving it to another record makes decryption fail.
 * @example const env = await encryptText(key, JSON.stringify(value), "sl:meta:run1")
 */
export async function encryptText(key: CryptoKey, plaintext: string, aad = ""): Promise<EncryptedEnvelope> {
  const iv = (globalThis.crypto as Crypto).getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await subtle().encrypt({ name: "AES-GCM", iv: iv as BufferSource, additionalData: enc.encode(aad) as BufferSource }, key, enc.encode(plaintext) as BufferSource),
  );
  return { v: 1, alg: "AES-GCM", iv: toB64(iv), ct: toB64(ct) };
}

/** Decrypt an envelope. @throws if the key is wrong or the data or `aad` was changed. */
export async function decryptText(key: CryptoKey, envelope: EncryptedEnvelope, aad = ""): Promise<string> {
  const plain = await subtle().decrypt(
    { name: "AES-GCM", iv: fromB64(envelope.iv) as BufferSource, additionalData: enc.encode(aad) as BufferSource },
    key,
    fromB64(envelope.ct) as BufferSource,
  );
  return dec.decode(plain);
}

/* ---------------------------------------------------------------- password-protected exports */

/** What a password-protected export file contains (JSON). */
export interface PasswordProtectedExport {
  steplight: "encrypted-export";
  v: 1;
  /** What is inside: a run bundle (JSON) or a self-contained HTML report. */
  kind: "run-json" | "report-html";
  kdf: "PBKDF2-SHA256";
  iterations: number;
  salt: string;
  iv: string;
  ct: string;
}

/** PBKDF2 work factor for exports (OWASP guidance for PBKDF2-HMAC-SHA256). */
export const EXPORT_PBKDF2_ITERATIONS = 600_000;

async function passwordKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await subtle().importKey("raw", enc.encode(password) as BufferSource, "PBKDF2", false, ["deriveKey"]);
  return subtle().deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Encrypt an export with a password (PBKDF2-SHA256 → AES-256-GCM, random salt and IV).
 * @example const file = await encryptWithPassword(json, "correct horse", "run-json")
 */
export async function encryptWithPassword(
  text: string,
  password: string,
  kind: PasswordProtectedExport["kind"],
  iterations = EXPORT_PBKDF2_ITERATIONS,
): Promise<PasswordProtectedExport> {
  if (password.length === 0) throw new Error("A password is required");
  const salt = (globalThis.crypto as Crypto).getRandomValues(new Uint8Array(16));
  const key = await passwordKey(password, salt, iterations);
  const env = await encryptText(key, text, `steplight:${kind}`);
  return { steplight: "encrypted-export", v: 1, kind, kdf: "PBKDF2-SHA256", iterations, salt: toB64(salt), iv: env.iv, ct: env.ct };
}

/** True when parsed JSON is a password-protected export. */
export function isPasswordProtected(value: unknown): value is PasswordProtectedExport {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    e["steplight"] === "encrypted-export" &&
    e["v"] === 1 &&
    (e["kind"] === "run-json" || e["kind"] === "report-html") &&
    typeof e["salt"] === "string" &&
    typeof e["iv"] === "string" &&
    typeof e["ct"] === "string" &&
    typeof e["iterations"] === "number"
  );
}

/** Decrypt a password-protected export. @throws "Wrong password or damaged file" */
export async function decryptWithPassword(file: PasswordProtectedExport, password: string): Promise<string> {
  if (file.iterations < 1000 || file.iterations > 10_000_000) throw new Error("Unsupported key derivation settings");
  try {
    const key = await passwordKey(password, fromB64(file.salt), file.iterations);
    return await decryptText(key, { v: 1, alg: "AES-GCM", iv: file.iv, ct: file.ct }, `steplight:${file.kind}`);
  } catch {
    throw new Error("Wrong password or damaged file");
  }
}
