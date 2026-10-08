import { severityRank } from "./severity.js";
import type { Run, Severity, Step } from "./types.js";

/** CI rules evaluated against a recorded run (`steplight.rules.yml`). */
export interface Rules {
  /** Fail if the run has more than this many steps (agent notes are not counted). */
  max_steps?: number;
  /** Fail on any flag more severe than this. */
  max_severity?: Severity;
  /** Each entry must appear in the path or query of at least one visited URL. */
  must_visit?: string[];
  /** Fail if the agent visited (or sent data to) any of these domains or their subdomains. */
  must_not_visit_domains?: string[];
  /** Fail if a stuck-loop flag was raised. */
  no_stuck_loops?: boolean;
}

/** Identifier of each rule. */
export type RuleId = keyof Rules;

/** One violation of a rule. */
export interface Finding {
  ruleId: RuleId;
  message: string;
  /** Severity of the offending flag, when the finding comes from one. */
  severity?: Severity;
  stepId?: string;
  stepIndex?: number;
}

/** Outcome of {@link checkRun}. */
export interface CheckResult {
  passed: boolean;
  /** Rules that were evaluated, in a stable order. */
  evaluated: RuleId[];
  findings: Finding[];
}

/** Human-readable description of each rule (used in reports). */
export const RULE_DESCRIPTIONS: Record<RuleId, string> = {
  max_steps: "The run must not exceed the maximum number of steps",
  max_severity: "No flag may be more severe than the allowed maximum",
  must_visit: "The agent must visit each required page",
  must_not_visit_domains: "The agent must not visit or send data to forbidden domains",
  no_stuck_loops: "The agent must not get stuck repeating the same action",
};

const SEVERITIES: readonly Severity[] = ["low", "medium", "high", "critical"];
const RULE_IDS = Object.keys(RULE_DESCRIPTIONS) as RuleId[];

/**
 * Validate parsed YAML/JSON into {@link Rules}. Unknown keys are rejected so typos in a rules
 * file fail loudly instead of silently disabling a check.
 * @throws Error naming the offending key.
 * @example const rules = parseRules({ max_steps: 20, max_severity: "medium" })
 */
export function parseRules(input: unknown): Rules {
  if (input === null || input === undefined) return {};
  if (typeof input !== "object" || Array.isArray(input)) throw new Error("Rules must be a mapping of rule names to values");
  const raw = input as Record<string, unknown>;
  const rules: Rules = {};
  for (const key of Object.keys(raw)) {
    if (!(RULE_IDS as string[]).includes(key)) {
      throw new Error(`Unknown rule "${key}". Known rules: ${RULE_IDS.join(", ")}`);
    }
  }
  const strings = (key: string): string[] => {
    const v = raw[key];
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || x.length === 0)) {
      throw new Error(`Rule "${key}" must be a list of non-empty strings`);
    }
    return v as string[];
  };
  if ("max_steps" in raw) {
    const v = raw["max_steps"];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new Error('Rule "max_steps" must be a non-negative integer');
    rules.max_steps = v;
  }
  if ("max_severity" in raw) {
    const v = raw["max_severity"];
    if (typeof v !== "string" || !SEVERITIES.includes(v as Severity)) {
      throw new Error(`Rule "max_severity" must be one of: ${SEVERITIES.join(", ")}`);
    }
    rules.max_severity = v as Severity;
  }
  if ("must_visit" in raw) rules.must_visit = strings("must_visit");
  if ("must_not_visit_domains" in raw) rules.must_not_visit_domains = strings("must_not_visit_domains");
  if ("no_stuck_loops" in raw) {
    if (typeof raw["no_stuck_loops"] !== "boolean") throw new Error('Rule "no_stuck_loops" must be true or false');
    rules.no_stuck_loops = raw["no_stuck_loops"];
  }
  return rules;
}

function hostOf(url: string | undefined): string | undefined {
  try {
    return url ? new URL(url).hostname.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

function visitedUrls(step: Step): string[] {
  const urls: string[] = [];
  if (step.url) urls.push(step.url);
  if (step.request?.url) urls.push(step.request.url);
  return urls;
}

const matchesDomain = (host: string, domain: string): boolean => {
  const d = domain.toLowerCase().replace(/^\.+/, "");
  return host === d || host.endsWith(`.${d}`);
};

/**
 * Evaluate a run against CI rules.
 * @example
 * const { passed, findings } = checkRun(run, { max_severity: "medium", no_stuck_loops: true });
 */
export function checkRun(run: Run, rules: Rules): CheckResult {
  const findings: Finding[] = [];
  const evaluated = RULE_IDS.filter((id) => rules[id] !== undefined);

  if (rules.max_steps !== undefined) {
    const count = run.steps.filter((s) => s.kind !== "agent_note").length;
    if (count > rules.max_steps) {
      findings.push({ ruleId: "max_steps", message: `Run has ${count} steps (maximum ${rules.max_steps})` });
    }
  }

  if (rules.max_severity !== undefined) {
    const limit = severityRank(rules.max_severity);
    for (const step of run.steps) {
      for (const flag of step.flags) {
        if (severityRank(flag.severity) > limit) {
          findings.push({
            ruleId: "max_severity",
            severity: flag.severity,
            message: `[${flag.severity}] ${flag.type}: ${flag.message} (step #${step.index})`,
            stepId: step.id,
            stepIndex: step.index,
          });
        }
      }
    }
  }

  if (rules.must_visit) {
    const targets = run.steps
      .filter((s) => s.kind === "navigate" || s.kind === "page_read")
      .map((s) => {
        try {
          const u = new URL(s.url ?? "");
          return `${u.pathname}${u.search}`;
        } catch {
          return s.url ?? "";
        }
      });
    for (const needle of rules.must_visit) {
      if (!targets.some((t) => t.includes(needle))) {
        findings.push({ ruleId: "must_visit", message: `Required page "${needle}" was never visited` });
      }
    }
  }

  if (rules.must_not_visit_domains) {
    const seen = new Set<string>();
    for (const step of run.steps) {
      for (const url of visitedUrls(step)) {
        const host = hostOf(url);
        if (!host) continue;
        const bad = rules.must_not_visit_domains.find((d) => matchesDomain(host, d));
        const key = host; // report each forbidden host once, at its first step
        if (bad && !seen.has(key)) {
          seen.add(key);
          findings.push({
            ruleId: "must_not_visit_domains",
            message: `Forbidden domain "${bad}" was contacted (${host}) at step #${step.index}`,
            stepId: step.id,
            stepIndex: step.index,
          });
        }
      }
    }
  }

  if (rules.no_stuck_loops) {
    for (const step of run.steps) {
      for (const flag of step.flags) {
        if (flag.type === "stuck_loop") {
          findings.push({
            ruleId: "no_stuck_loops",
            severity: flag.severity,
            message: `${flag.message} (step #${step.index})`,
            stepId: step.id,
            stepIndex: step.index,
          });
        }
      }
    }
  }

  return { passed: findings.length === 0, evaluated, findings };
}
