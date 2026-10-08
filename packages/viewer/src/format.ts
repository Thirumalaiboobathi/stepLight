import { maxSeverity, severityRank, type Flag, type Severity, type Step } from "@steplight/core";

export { KIND_ICON, describeStep, offset, shortUrl } from "@steplight/core";

/** Tailwind classes per severity: badge and row highlight. */
export const SEVERITY_STYLE: Record<Severity, { badge: string; row: string }> = {
  low: {
    badge: "bg-sky-100 text-sky-800 dark:bg-sky-900/50 dark:text-sky-200",
    row: "border-l-sky-400 bg-sky-50/60 dark:bg-sky-950/30",
  },
  medium: {
    badge: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200",
    row: "border-l-amber-400 bg-amber-50/70 dark:bg-amber-950/30",
  },
  high: {
    badge: "bg-orange-100 text-orange-800 dark:bg-orange-900/50 dark:text-orange-200",
    row: "border-l-orange-500 bg-orange-50/80 dark:bg-orange-950/40",
  },
  critical: {
    badge: "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-200",
    row: "border-l-red-500 bg-red-50/80 dark:bg-red-950/40",
  },
};

/** Local clock time such as "10:22:54". */
export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

/**
 * Highest severity among flags that deserve attention in lists (medium and above).
 * Low flags (for example visible instruction-like text) only appear in step details.
 */
export function notableSeverity(flags: readonly Pick<Flag, "severity">[]): Severity | undefined {
  const worst = maxSeverity(flags);
  return worst && severityRank(worst) >= severityRank("medium") ? worst : undefined;
}

/** Index of the first step with a medium-or-above flag, or 0 when there is none. */
export function firstFlaggedIndex(
  steps: readonly { flags: readonly Pick<Flag, "severity">[] }[],
): number {
  const i = steps.findIndex((s) => notableSeverity(s.flags) !== undefined);
  return i < 0 ? 0 : i;
}
