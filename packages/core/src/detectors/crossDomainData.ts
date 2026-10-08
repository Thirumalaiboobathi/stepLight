import { isCrossSite, registrableDomain } from "../domain.js";
import type { Flag, Step } from "../types.js";

/** An earlier page the agent has read: its URL and visible text. */
export interface HistoryPage {
  url?: string;
  text: string;
}

/** Values that are too generic to prove data was copied from a page. */
const GENERIC = new Set(["submit", "true", "false", "null", "undefined", "continue", "search"]);

/**
 * Pull candidate values out of a form-encoded, JSON or plain body.
 * @example bodyValues("a=hello+world&b=1") // ["hello world"]
 */
export function bodyValues(body: string): string[] {
  const values: string[] = [];
  try {
    const parsed: unknown = JSON.parse(body);
    const walk = (v: unknown) => {
      if (typeof v === "string" || typeof v === "number") values.push(String(v));
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(parsed);
  } catch {
    for (const pair of body.split(/[&\n]/)) {
      const eq = pair.indexOf("=");
      const raw = eq >= 0 ? pair.slice(eq + 1) : pair;
      try {
        values.push(decodeURIComponent(raw.replace(/\+/g, " ")));
      } catch {
        values.push(raw);
      }
    }
  }
  return values.map((v) => v.trim()).filter((v) => v.length >= 5 && !GENERIC.has(v.toLowerCase()));
}

/**
 * Flag a `form_submit` or POST/PUT/PATCH to a different registrable domain than the
 * current page when the payload contains values copied from an earlier page.
 * Pages that belong to the destination site itself are ignored as sources.
 * @example crossDomainData(submitStep, [{ url: "https://a.test/", text: "Premium 42000" }])
 */
export function crossDomainData(step: Step, history: readonly HistoryPage[]): Flag[] {
  const req = step.request;
  if (!req?.bodyPreview) return [];
  const isWrite = ["POST", "PUT", "PATCH"].includes(req.method.toUpperCase());
  if (!isWrite && step.kind !== "form_submit") return [];
  if (!isCrossSite(step.url, req.url)) return [];

  const target = registrableDomain(req.url);
  const sources = history.filter((p) => registrableDomain(p.url) !== target && p.text);
  if (sources.length === 0) return [];

  const leaked = bodyValues(req.bodyPreview).filter((value) => {
    const needle = value.toLowerCase();
    return sources.some((p) => p.text.toLowerCase().includes(needle));
  });
  if (leaked.length === 0) return [];

  const shown = leaked.slice(0, 3).map((v) => (v.length > 40 ? `${v.slice(0, 40)}…` : v));
  return [
    {
      type: "cross_domain_data",
      severity: "high",
      message: `Data from an earlier page was sent to a different domain (${target ?? req.url})`,
      evidence: shown.join(" | "),
    },
  ];
}
