import type { Step, StepKind } from "./types.js";

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

/** "+1.2s" offset of a timestamp from the run start. */
export function offset(ts: number, start: number): string {
  return `+${((ts - start) / 1000).toFixed(1)}s`;
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
 * One-line summary of a request's metadata, e.g. `xmlhttprequest · 200 · 42 ms · 1.2 KB sent · page hook`.
 * Empty when there is nothing beyond method and URL.
 * @example requestMeta(step) // "ping · 204 · 3 ms"
 */
export function requestMeta(step: Pick<Step, "request" | "durationMs">): string {
  const r = step.request;
  if (!r) return "";
  const parts: string[] = [];
  if (r.resourceType) parts.push(r.resourceType);
  if (r.status !== undefined) parts.push(String(r.status));
  if (r.error) parts.push(`failed: ${r.error}`);
  if (step.durationMs !== undefined) parts.push(`${step.durationMs} ms`);
  if (r.bodyBytes) parts.push(`${r.bodyBytes < 1024 ? `${r.bodyBytes} B` : `${(r.bodyBytes / 1024).toFixed(1)} KB`} sent`);
  if (r.contentType) parts.push(r.contentType);
  if (r.source === "deep") parts.push("seen by page hook (deep capture)");
  return parts.join(" · ");
}
