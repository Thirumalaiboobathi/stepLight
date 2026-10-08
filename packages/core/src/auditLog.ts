import { sha256Hex } from "./hash.js";

/** Things Steplight records about its own behaviour. */
export type AuditAction =
  | "recording_started"
  | "recording_stopped"
  | "export"
  | "import"
  | "delete_all"
  | "retention_delete"
  | "settings_changed"
  | "policy_applied"
  | "paired"
  | "unpaired"
  | "server_started"
  | "purge"
  | "decrypt";

/** All actions, for validation. */
export const AUDIT_ACTIONS: readonly AuditAction[] = [
  "recording_started", "recording_stopped", "export", "import", "delete_all", "retention_delete",
  "settings_changed", "policy_applied", "paired", "unpaired", "server_started", "purge", "decrypt",
];

/** Small, flat, non-sensitive details of an action (never page content, task titles or secrets). */
export type AuditDetail = Record<string, string | number | boolean>;

/** One link of the hash chain. */
export interface AuditEntry {
  /** 1-based position since the log began. */
  seq: number;
  /** Epoch milliseconds. */
  ts: number;
  action: AuditAction;
  detail: AuditDetail;
  /** Hash of the previous entry (`GENESIS` for the first). */
  prev: string;
  /** SHA-256 over `prev` and this entry's other fields. */
  hash: string;
}

/** `prev` of the very first entry. */
export const GENESIS = "0".repeat(64);

const canonical = (e: Omit<AuditEntry, "hash">): string =>
  JSON.stringify([e.seq, e.ts, e.action, Object.entries(e.detail).sort(([a], [b]) => (a < b ? -1 : 1)), e.prev]);

/** Keep details small and flat. Strings are cut to 120 characters; at most 12 keys. */
export function cleanDetail(detail: Record<string, unknown> | undefined): AuditDetail {
  const out: AuditDetail = {};
  for (const [k, v] of Object.entries(detail ?? {}).slice(0, 12)) {
    if (typeof v === "string") out[k.slice(0, 40)] = v.slice(0, 120);
    else if (typeof v === "number" && Number.isFinite(v)) out[k.slice(0, 40)] = v;
    else if (typeof v === "boolean") out[k.slice(0, 40)] = v;
  }
  return out;
}

/**
 * Build the next entry of a tamper-evident log. Each entry's hash covers the previous entry's
 * hash, so changing, removing or reordering any earlier entry breaks every later one.
 * @example const entry = nextAuditEntry(lastEntry, "export", { kind: "json", encrypted: true }, Date.now())
 */
export function nextAuditEntry(last: AuditEntry | undefined, action: AuditAction, detail: Record<string, unknown>, ts: number): AuditEntry {
  const base = { seq: (last?.seq ?? 0) + 1, ts, action, detail: cleanDetail(detail), prev: last?.hash ?? GENESIS };
  return { ...base, hash: sha256Hex(canonical(base)) };
}

/** Result of {@link verifyAuditLog}. */
export interface AuditVerification {
  ok: boolean;
  entries: number;
  /** `seq` of the first entry that does not fit the chain. */
  brokenAt?: number;
  reason?: string;
}

/**
 * Check a whole log. A log that was trimmed from the front is checked from its first entry's
 * `prev` (pass `anchor` to also require that start, e.g. the hash that was stored when trimming).
 */
export function verifyAuditLog(entries: readonly AuditEntry[], anchor?: string): AuditVerification {
  let prev = anchor ?? entries[0]?.prev ?? GENESIS;
  let seq = (entries[0]?.seq ?? 1) - 1;
  for (const e of entries) {
    if (e.prev !== prev) return { ok: false, entries: entries.length, brokenAt: e.seq, reason: "an earlier entry was changed or removed" };
    if (e.seq !== seq + 1) return { ok: false, entries: entries.length, brokenAt: e.seq, reason: "entries are missing or out of order" };
    if (sha256Hex(canonical(e)) !== e.hash) return { ok: false, entries: entries.length, brokenAt: e.seq, reason: "this entry was modified" };
    prev = e.hash;
    seq = e.seq;
  }
  return { ok: true, entries: entries.length };
}

/** Keep the newest `max` entries; returns the kept entries and the hash that precedes them (the anchor). */
export function trimAuditLog(entries: readonly AuditEntry[], max: number): { entries: AuditEntry[]; anchor: string } {
  if (entries.length <= max) return { entries: [...entries], anchor: entries[0]?.prev ?? GENESIS };
  const kept = entries.slice(entries.length - max);
  return { entries: kept, anchor: kept[0]!.prev };
}
