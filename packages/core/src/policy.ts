import { validatePattern } from "./customPatterns.js";
import { CAPTURE_LEVELS, normalizeDomainList, type CaptureLevel, type Settings } from "./settings.js";

/**
 * An organisation policy: restrictions an administrator enforces. Delivered to the Chrome
 * extension through Chrome Enterprise policy (`chrome.storage.managed`, schema in
 * `managed_schema.json`) and to the CLI/SDK through a policy file (`--policy`), a
 * `steplight.config.json` or `STEPLIGHT_*` environment variables.
 * Every field is optional; a policy can only make Steplight MORE restrictive, never less.
 */
export interface Policy {
  /** Highest capture level anyone may choose. */
  maxCaptureLevel?: CaptureLevel;
  /** Redaction patterns (regular expressions) that are always applied. */
  forceRedactionPatterns?: string[];
  /** If non-empty, only these sites may be recorded (the user's own allow list is ignored). */
  siteAllowlist?: string[];
  /** Sites that are never recorded (added to the user's deny list). */
  siteDenylist?: string[];
  /** Runs are deleted after at most this many days. */
  retentionDays?: number;
  /** Exports and imports are disabled. */
  disableExport?: boolean;
  /** The extension never talks to a local CLI server. */
  disableCliConnection?: boolean;
  /** The page-hook "Deep capture" cannot be enabled. */
  disableDeepCapture?: boolean;
  /** CLI/SDK refuse to write unencrypted runs, and exports must be password-protected. */
  requireEncryption?: boolean;
}

/** Keys of {@link Policy}, in the order the docs list them. */
export const POLICY_KEYS = [
  "maxCaptureLevel",
  "forceRedactionPatterns",
  "siteAllowlist",
  "siteDenylist",
  "retentionDays",
  "disableExport",
  "disableCliConnection",
  "disableDeepCapture",
  "requireEncryption",
] as const satisfies readonly (keyof Policy)[];

/** What `normalizePolicy` could not accept, for the audit log and the admin. */
export interface PolicyProblem {
  key: string;
  reason: string;
}

/**
 * Turn untrusted policy data into a valid {@link Policy}. Unknown keys and malformed values are
 * dropped (and reported); patterns that fail the ReDoS check are dropped. Never throws.
 * @example normalizePolicy({ maxCaptureLevel: "minimal", retentionDays: 3 })
 */
export function normalizePolicy(raw: unknown, problems: PolicyProblem[] = []): Policy {
  const out: Policy = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  const bad = (key: string, reason: string): void => void problems.push({ key, reason });
  for (const key of Object.keys(r)) if (!(POLICY_KEYS as readonly string[]).includes(key)) bad(key, "unknown policy key");

  if (r["maxCaptureLevel"] !== undefined) {
    if (CAPTURE_LEVELS.includes(r["maxCaptureLevel"] as CaptureLevel)) out.maxCaptureLevel = r["maxCaptureLevel"] as CaptureLevel;
    else bad("maxCaptureLevel", "must be minimal, standard or full");
  }
  for (const key of ["siteAllowlist", "siteDenylist"] as const) {
    if (r[key] === undefined) continue;
    if (!Array.isArray(r[key])) bad(key, "must be a list of domains");
    else {
      const clean = normalizeDomainList(r[key]);
      if (clean.length < (r[key] as unknown[]).length) bad(key, "some entries were not valid domains and were ignored");
      if (clean.length > 0) out[key] = clean;
    }
  }
  if (r["forceRedactionPatterns"] !== undefined) {
    if (!Array.isArray(r["forceRedactionPatterns"])) bad("forceRedactionPatterns", "must be a list of regular expressions");
    else {
      const ok: string[] = [];
      for (const p of r["forceRedactionPatterns"] as unknown[]) {
        const check = validatePattern(p);
        if (check.ok) ok.push(p as string);
        else bad("forceRedactionPatterns", `${String(p).slice(0, 40)}: ${check.reason}`);
      }
      if (ok.length > 0) out.forceRedactionPatterns = ok;
    }
  }
  if (r["retentionDays"] !== undefined) {
    const n = r["retentionDays"];
    if (typeof n === "number" && Number.isFinite(n) && n >= 1 && n <= 3650) out.retentionDays = Math.round(n);
    else bad("retentionDays", "must be a number of days between 1 and 3650");
  }
  for (const key of ["disableExport", "disableCliConnection", "disableDeepCapture", "requireEncryption"] as const) {
    if (r[key] === undefined) continue;
    if (typeof r[key] === "boolean") {
      if (r[key]) out[key] = true;
    } else bad(key, "must be true or false");
  }
  return out;
}

const levelRank = (l: CaptureLevel): number => CAPTURE_LEVELS.indexOf(l);

/**
 * Combine policies so the result is at least as strict as each of them: lowest capture level and
 * retention, union of deny lists and patterns, intersection of allow lists, any "disable" or
 * "require" wins.
 */
export function mergePolicies(...policies: Policy[]): Policy {
  const out: Policy = {};
  for (const p of policies) {
    if (p.maxCaptureLevel && (!out.maxCaptureLevel || levelRank(p.maxCaptureLevel) < levelRank(out.maxCaptureLevel))) out.maxCaptureLevel = p.maxCaptureLevel;
    if (p.retentionDays !== undefined) out.retentionDays = out.retentionDays === undefined ? p.retentionDays : Math.min(out.retentionDays, p.retentionDays);
    if (p.forceRedactionPatterns) out.forceRedactionPatterns = [...new Set([...(out.forceRedactionPatterns ?? []), ...p.forceRedactionPatterns])];
    if (p.siteDenylist) out.siteDenylist = [...new Set([...(out.siteDenylist ?? []), ...p.siteDenylist])];
    if (p.siteAllowlist) {
      out.siteAllowlist = out.siteAllowlist ? out.siteAllowlist.filter((d) => p.siteAllowlist!.includes(d)) : [...p.siteAllowlist];
    }
    for (const key of ["disableExport", "disableCliConnection", "disableDeepCapture", "requireEncryption"] as const) if (p[key]) out[key] = true;
  }
  return out;
}

/** Effective settings plus what the administrator has locked, for the UI. */
export interface EffectiveSettings {
  settings: Settings;
  policy: Policy;
  /** True when any policy is in force. */
  managed: boolean;
  /** Settings fields the user cannot change (shown as "Managed by your organization"). */
  lockedKeys: (keyof Settings)[];
  /** Entries in the effective lists that come from the policy and cannot be removed. */
  forcedDenylist: string[];
  forcedPatterns: string[];
}

/**
 * Apply a policy on top of the user's settings. The policy always wins; the user keeps the
 * freedom to be stricter than the policy (lower capture level, shorter retention, more denied sites).
 * @example const eff = applyPolicy(userSettings, { maxCaptureLevel: "standard", disableDeepCapture: true })
 */
export function applyPolicy(user: Settings, policy: Policy): EffectiveSettings {
  const settings: Settings = { ...user };
  const locked = new Set<keyof Settings>();
  if (policy.maxCaptureLevel && levelRank(settings.captureLevel) > levelRank(policy.maxCaptureLevel)) settings.captureLevel = policy.maxCaptureLevel;
  if (policy.disableDeepCapture) {
    settings.deepCapture = false;
    locked.add("deepCapture");
  }
  if (policy.forceRedactionPatterns?.length) settings.customPatterns = [...new Set([...policy.forceRedactionPatterns, ...user.customPatterns])];
  if (policy.siteDenylist?.length) settings.siteDenylist = [...new Set([...policy.siteDenylist, ...user.siteDenylist])];
  if (policy.siteAllowlist?.length) {
    settings.siteAllowlist = [...policy.siteAllowlist];
    locked.add("siteAllowlist");
  }
  if (policy.retentionDays !== undefined) {
    settings.retentionDays = settings.retentionDays === 0 ? policy.retentionDays : Math.min(settings.retentionDays, policy.retentionDays);
  }
  const managed = Object.keys(policy).length > 0;
  return {
    settings,
    policy,
    managed,
    lockedKeys: [...locked],
    forcedDenylist: policy.siteDenylist ?? [],
    forcedPatterns: policy.forceRedactionPatterns ?? [],
  };
}

/**
 * Policy from `STEPLIGHT_*` environment variables, e.g. `STEPLIGHT_MAX_CAPTURE_LEVEL=standard`,
 * `STEPLIGHT_SITE_DENYLIST=a.com,b.com`, `STEPLIGHT_RETENTION_DAYS=7`, `STEPLIGHT_DISABLE_EXPORT=1`.
 * Patterns are separated by newlines (`STEPLIGHT_FORCE_REDACTION_PATTERNS`).
 */
export function policyFromEnv(env: Record<string, string | undefined>, problems: PolicyProblem[] = []): Policy {
  const truthy = (v: string | undefined): boolean | undefined => (v === undefined || v === "" ? undefined : /^(1|true|yes|on)$/i.test(v));
  const list = (v: string | undefined, sep: RegExp): string[] | undefined => (v ? v.split(sep).map((s) => s.trim()).filter(Boolean) : undefined);
  const raw: Record<string, unknown> = {
    maxCaptureLevel: env["STEPLIGHT_MAX_CAPTURE_LEVEL"] || undefined,
    forceRedactionPatterns: list(env["STEPLIGHT_FORCE_REDACTION_PATTERNS"], /\r?\n/),
    siteAllowlist: list(env["STEPLIGHT_SITE_ALLOWLIST"], /[,\s]+/),
    siteDenylist: list(env["STEPLIGHT_SITE_DENYLIST"], /[,\s]+/),
    retentionDays: env["STEPLIGHT_RETENTION_DAYS"] ? Number(env["STEPLIGHT_RETENTION_DAYS"]) : undefined,
    disableExport: truthy(env["STEPLIGHT_DISABLE_EXPORT"]),
    disableCliConnection: truthy(env["STEPLIGHT_DISABLE_CLI_CONNECTION"]),
    disableDeepCapture: truthy(env["STEPLIGHT_DISABLE_DEEP_CAPTURE"]),
    requireEncryption: truthy(env["STEPLIGHT_REQUIRE_ENCRYPTION"]),
  };
  for (const k of Object.keys(raw)) if (raw[k] === undefined) delete raw[k];
  return normalizePolicy(raw, problems);
}
