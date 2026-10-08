import { maxSeverity, severityRank, type Flag, type Severity, type Step, type StepKind } from "@steplight/core";

/** Icon shown for each kind of step. */
export const KIND_ICON: Record<StepKind, string> = {
  navigate: "🧭",
  page_read: "📄",
  click: "👆",
  type: "⌨️",
  form_submit: "📨",
  network_request: "🌐",
  download: "⬇️",
  agent_note: "💭",
  error: "⚠️",
};

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

/** "+1.2s" offset of a timestamp from the run start. */
export function offset(ts: number, start: number): string {
  return `+${((ts - start) / 1000).toFixed(1)}s`;
}

/** Local clock time such as "10:22:54". */
export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

/** Host + path of a URL, without the query string. */
export function shortUrl(url: string | undefined): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url;
  }
}

/** One-line human description of a step. */
export function describeStep(step: Step): string {
  if (step.error && (step.kind === "click" || step.kind === "type")) {
    return `Failed ${step.kind === "click" ? "click" : "input"} on ${step.targetSelector ?? "element"}`;
  }
  switch (step.kind) {
    case "navigate":
      return `Navigated to ${shortUrl(step.url)}`;
    case "page_read":
      return `Read page${step.targetText ? `: ${step.targetText}` : ""}`;
    case "click":
      return `Clicked "${step.targetText ?? step.targetSelector ?? "element"}"`;
    case "type":
      return `Edited ${step.targetText ?? step.targetSelector ?? "field"}`;
    case "form_submit":
      return `Submitted form → ${shortUrl(step.request?.url)}`;
    case "network_request":
      return `${step.request?.method ?? "GET"} ${shortUrl(step.request?.url)}`;
    case "download":
      return `Downloaded ${step.targetText ?? shortUrl(step.url)}`;
    case "agent_note":
      return step.targetText ?? "Agent note";
    case "error":
      return step.targetText ?? "Error";
  }
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
