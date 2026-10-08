import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Encryption at rest for run files written by the CLI and the SDK (AES-256-GCM, Node only).
 *
 * Key sources, first match wins:
 *  1. `options.key` (32 bytes, hex or base64) or `options.passphrase`
 *  2. `$STEPLIGHT_ENCRYPTION_KEY` (32 bytes as 64 hex characters or base64)
 *  3. `$STEPLIGHT_PASSPHRASE`
 * A passphrase is stretched with scrypt (N=32768, r=8, p=1) using a random salt stored in
 * `<runs>/.steplight-enc.json` together with an encrypted check value, so a wrong passphrase is
 * reported clearly. With no key, nothing is encrypted and encrypted runs cannot be read.
 *
 * Each file is encrypted separately: `run.json` and snapshots as one envelope, `steps.jsonl` as
 * one envelope per line (so it can still be appended to). Every envelope has its own random IV,
 * and the file's identity (`<runId>/<file>`) is bound in as additional authenticated data.
 */
export interface EncryptionOptions {
  /** 32-byte key as a Buffer / Uint8Array, or as 64 hex characters / base64. */
  key?: Uint8Array | string;
  passphrase?: string;
}

/** Marker every encrypted file starts with. */
export const ENC_MARKER = '{"steplight":"enc-v1"';

/** Thrown when a run is encrypted and no (or the wrong) key is available. */
export class EncryptedRunError extends Error {
  constructor(message = "This run is encrypted. Set STEPLIGHT_ENCRYPTION_KEY (or STEPLIGHT_PASSPHRASE) to read it.") {
    super(message);
    this.name = "EncryptedRunError";
  }
}

/** True when the text is one of our encrypted envelopes. */
export const isEncryptedText = (text: string): boolean => text.startsWith(ENC_MARKER);

function parseKey(value: Uint8Array | string): Buffer {
  const buf = typeof value === "string" ? (/^[0-9a-f]{64}$/i.test(value.trim()) ? Buffer.from(value.trim(), "hex") : Buffer.from(value.trim(), "base64")) : Buffer.from(value);
  if (buf.length !== 32) throw new Error("The encryption key must be 32 bytes (64 hex characters or base64).");
  return buf;
}

/** Effective options: explicit ones, else the environment. Undefined when no key source is set. */
export function effectiveEncryption(options?: EncryptionOptions): EncryptionOptions | undefined {
  if (options?.key !== undefined || options?.passphrase !== undefined) return options;
  const env = process.env;
  if (env["STEPLIGHT_ENCRYPTION_KEY"]) return { key: env["STEPLIGHT_ENCRYPTION_KEY"] };
  if (env["STEPLIGHT_PASSPHRASE"]) return { passphrase: env["STEPLIGHT_PASSPHRASE"] };
  return undefined;
}

const SALT_FILE = ".steplight-enc.json";
const derived = new Map<string, Buffer>();

interface SaltFile {
  v: 1;
  kdf: "scrypt";
  N: number;
  r: number;
  p: number;
  salt: string;
  /** An encrypted constant, so a wrong passphrase is detected before touching any run. */
  check: string;
}

/**
 * Resolve the 32-byte key for a runs folder, or undefined when no key source is set. A passphrase
 * creates the salt file on first use when `create` is true.
 */
export async function resolveKey(root: string, options?: EncryptionOptions, create = false): Promise<Buffer | undefined> {
  const eff = effectiveEncryption(options);
  if (!eff) return undefined;
  if (eff.key !== undefined) return parseKey(eff.key);
  const passphrase = eff.passphrase!;
  const cacheKey = `${path.resolve(root)}\0${passphrase}`;
  const hit = derived.get(cacheKey);
  if (hit) return hit;
  const file = path.join(root, SALT_FILE);
  let meta: SaltFile | undefined;
  try {
    meta = JSON.parse(await fs.readFile(file, "utf8")) as SaltFile;
  } catch {
    meta = undefined;
  }
  if (!meta) {
    if (!create) throw new EncryptedRunError("No passphrase salt found for this folder, so nothing here was encrypted with a passphrase.");
    const salt = randomBytes(16);
    const key = scryptSync(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
    meta = { v: 1, kdf: "scrypt", N: 32768, r: 8, p: 1, salt: salt.toString("base64"), check: encryptFile("steplight-ok", key, "check") };
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    await fs.writeFile(file, JSON.stringify(meta), { mode: 0o600 });
    derived.set(cacheKey, key);
    return key;
  }
  const key = scryptSync(passphrase, Buffer.from(meta.salt, "base64"), 32, { N: meta.N, r: meta.r, p: meta.p, maxmem: 128 * 1024 * 1024 });
  try {
    if (decryptFile(meta.check, key, "check") !== "steplight-ok") throw new Error("mismatch");
  } catch {
    throw new EncryptedRunError("Wrong passphrase for this folder.");
  }
  derived.set(cacheKey, key);
  return key;
}

/** Encrypt text into a one-line JSON envelope. */
export function encryptFile(plain: string, key: Buffer, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return JSON.stringify({ steplight: "enc-v1", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ct: ct.toString("base64") });
}

/**
 * Decrypt an envelope produced by {@link encryptFile}. Plain (unencrypted) text is returned as is.
 * @throws {EncryptedRunError} when the text is encrypted and `key` is missing or wrong, or the data was changed.
 */
export function decryptFile(text: string, key: Buffer | undefined, aad: string): string {
  if (!isEncryptedText(text)) return text;
  if (!key) throw new EncryptedRunError();
  try {
    const env = JSON.parse(text) as { iv: string; tag: string; ct: string };
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(env.iv, "base64"));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(env.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(env.ct, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new EncryptedRunError("Could not decrypt: wrong key, or the file was modified.");
  }
}

/**
 * Write a file readable only by its owner. On POSIX this is mode 0600 (directories 0700). On
 * Windows the mode bits have no effect: the file inherits the folder's ACL, so keep the runs
 * folder inside your user profile or tighten it with `icacls`.
 */
export async function writePrivate(file: string, data: string): Promise<void> {
  await fs.writeFile(file, data, { mode: 0o600 });
  if (process.platform !== "win32") await fs.chmod(file, 0o600);
}
