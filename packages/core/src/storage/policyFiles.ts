import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { nextAuditEntry, verifyAuditLog, type AuditAction, type AuditEntry, type AuditVerification } from "../auditLog.js";
import { mergePolicies, normalizePolicy, policyFromEnv, type Policy, type PolicyProblem } from "../policy.js";

/** Where a policy came from, for messages. */
export interface LoadedPolicy {
  policy: Policy;
  /** Human-readable origins, e.g. `["org policy /etc/steplight/policy.json", "env"]`. */
  sources: string[];
  problems: PolicyProblem[];
}

/** Options for {@link loadPolicy}. */
export interface LoadPolicyOptions {
  /** Organisation policy file (`--policy`, else `$STEPLIGHT_POLICY_FILE`). */
  policyFile?: string;
  /** Config file (else `$STEPLIGHT_CONFIG`, else `./steplight.config.json` when it exists). */
  configFile?: string;
  env?: Record<string, string | undefined>;
  cwd?: string;
}

function readPolicyFile(file: string, label: string, problems: PolicyProblem[]): Policy {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    // A policy that cannot be read must not silently mean "no restrictions".
    throw new Error(`Cannot read ${label} ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return normalizePolicy(raw, problems);
}

/**
 * Load the effective policy for the CLI and SDK: the organisation policy file, the user's
 * `steplight.config.json` and `STEPLIGHT_*` environment variables, merged so the result is never
 * looser than any of them (see `mergePolicies`). An unreadable policy file is an error, not "no policy".
 * @example const { policy } = loadPolicy({ policyFile: "/etc/steplight/policy.json" })
 */
export function loadPolicy(options: LoadPolicyOptions = {}): LoadedPolicy {
  const env = options.env ?? process.env;
  const problems: PolicyProblem[] = [];
  const parts: Policy[] = [];
  const sources: string[] = [];
  const orgFile = options.policyFile ?? env["STEPLIGHT_POLICY_FILE"];
  if (orgFile) {
    parts.push(readPolicyFile(path.resolve(options.cwd ?? ".", orgFile), "organisation policy", problems));
    sources.push(`org policy ${orgFile}`);
  }
  const configFile = options.configFile ?? env["STEPLIGHT_CONFIG"] ?? path.join(options.cwd ?? ".", "steplight.config.json");
  if (options.configFile || env["STEPLIGHT_CONFIG"] || existsSync(configFile)) {
    parts.push(readPolicyFile(path.resolve(options.cwd ?? ".", configFile), "config file", problems));
    sources.push(`config ${configFile}`);
  }
  const fromEnv = policyFromEnv(env, problems);
  if (Object.keys(fromEnv).length > 0) {
    parts.push(fromEnv);
    sources.push("environment");
  }
  return { policy: mergePolicies(...parts), sources, problems };
}

/* ---------------------------------------------------------------- audit log file */

/** Default audit log location: next to the runs folder. `$STEPLIGHT_AUDIT_FILE` overrides it. */
export function auditFilePath(runsDir: string, env: Record<string, string | undefined> = process.env): string {
  return env["STEPLIGHT_AUDIT_FILE"] ?? path.join(path.dirname(path.resolve(runsDir)), "audit.jsonl");
}

/** Read every entry of an audit log file (lines that are not valid entries are skipped and make verification fail). */
export function readAuditFile(file: string): AuditEntry[] {
  if (!existsSync(file)) return [];
  const out: AuditEntry[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as AuditEntry);
    } catch {
      out.push({ seq: -1, ts: 0, action: "decrypt", detail: { corrupt: true }, prev: "", hash: "" });
    }
  }
  return out;
}

/**
 * Append one entry to the audit log file (hash-chained to the previous one). Never throws:
 * auditing must not stop the work it records. Returns the entry, or undefined on failure.
 * @example appendAudit(auditFilePath(runsDir), "purge", { runs: 3 })
 */
export function appendAudit(file: string, action: AuditAction, detail: Record<string, unknown> = {}): AuditEntry | undefined {
  try {
    const last = readAuditFile(file).at(-1);
    const entry = nextAuditEntry(last && last.seq > 0 ? last : undefined, action, detail, Date.now());
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    appendFileSync(file, JSON.stringify(entry) + "\n", { mode: 0o600 });
    return entry;
  } catch {
    return undefined;
  }
}

/** Verify an audit log file. */
export function verifyAuditFile(file: string): AuditVerification {
  return verifyAuditLog(readAuditFile(file));
}
