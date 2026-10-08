function randomHex(length: number): string {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, length);
}

/**
 * Create a sortable, filesystem-safe run id such as `20261008-101500-a1b2c3`.
 * @example const id = newRunId();
 */
export function newRunId(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}-${randomHex(6)}`;
}

/**
 * Create a step id unique within a run, e.g. `s0007-9f3a`.
 * @example const id = newStepId(7);
 */
export function newStepId(index: number): string {
  return `s${String(index).padStart(4, "0")}-${randomHex(4)}`;
}

/**
 * True when the id is safe to use as a folder name (letters, digits, `-`, `_`).
 * @example isSafeId("20261008-101500-a1b2c3") // true
 */
export function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(id);
}
