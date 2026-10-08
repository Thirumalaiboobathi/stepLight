import type { Flag, Severity } from "./types.js";

const RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3, critical: 4 };

/**
 * Numeric rank of a severity (low = 1 … critical = 4).
 * @example severityRank("high") // 3
 */
export function severityRank(severity: Severity): number {
  return RANK[severity];
}

/**
 * Highest severity among the given flags, or undefined if there are none.
 * @example maxSeverity([{ severity: "low" }, { severity: "high" }] as Flag[]) // "high"
 */
export function maxSeverity(flags: readonly Pick<Flag, "severity">[]): Severity | undefined {
  let best: Severity | undefined;
  for (const flag of flags) {
    if (!best || RANK[flag.severity] > RANK[best]) best = flag.severity;
  }
  return best;
}
