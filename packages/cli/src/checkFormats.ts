import {
  RULE_DESCRIPTIONS,
  type CheckResult,
  type Finding,
  type Rules,
  type Run,
  type RuleId,
} from "@steplight/core/node";

/** Output formats of `steplight check`. */
export type CheckFormat = "text" | "junit" | "sarif";

/** What a formatter needs to know about the checked run. */
export interface CheckContext {
  run: Run;
  rules: Rules;
  result: CheckResult;
  /** Forward-slash path (relative to the repo root where possible) of the run's `steps.jsonl`. */
  stepsFile: string;
  /** Same for `run.json`. */
  runFile: string;
  version: string;
}

/**
 * Human-readable report.
 * @example console.log(formatText(ctx))
 */
export function formatText(ctx: CheckContext): string {
  const { run, result } = ctx;
  const head = `Steplight check: run ${run.id} ("${run.task}"), ${run.steps.length} steps`;
  if (result.passed) {
    return `${head}\nPASS: ${result.evaluated.length} rule${result.evaluated.length === 1 ? "" : "s"} satisfied (${result.evaluated.join(", ") || "none configured"})`;
  }
  const lines = [head, `FAIL: ${result.findings.length} finding${result.findings.length === 1 ? "" : "s"}`];
  for (const f of result.findings) lines.push(`  ✗ ${f.ruleId}: ${f.message}`);
  const failedRules = new Set(result.findings.map((f) => f.ruleId));
  for (const id of result.evaluated) if (!failedRules.has(id)) lines.push(`  ✓ ${id}`);
  return lines.join("\n");
}

const xml = (s: string): string =>
  s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c] ?? c);

/**
 * JUnit XML: one test case per configured rule, so passing rules show up too.
 * @example await writeFile("steplight-junit.xml", formatJunit(ctx))
 */
export function formatJunit(ctx: CheckContext): string {
  const { run, result } = ctx;
  const rules: RuleId[] = result.evaluated.length ? result.evaluated : [];
  const failures = rules.filter((id) => result.findings.some((f) => f.ruleId === id)).length;
  const cases = rules.map((id) => {
    const fs = result.findings.filter((f) => f.ruleId === id);
    const body = fs.length
      ? `\n      <failure message="${xml(fs[0]!.message)}" type="${id}">${xml(fs.map((f) => f.message).join("\n"))}</failure>\n    `
      : "";
    return `    <testcase classname="steplight.${xml(run.id)}" name="${id}">${body}</testcase>`;
  });
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<testsuites name="steplight" tests="${rules.length}" failures="${failures}">`,
    `  <testsuite name="steplight: ${xml(run.task)}" tests="${rules.length}" failures="${failures}" errors="0" skipped="0">`,
    ...cases,
    `  </testsuite>`,
    `</testsuites>`,
    ``,
  ].join("\n");
}

function sarifLevel(f: Finding): "error" | "warning" | "note" {
  if (f.severity === "medium") return "warning";
  if (f.severity === "low") return "note";
  return "error";
}

/**
 * SARIF 2.1.0 so findings appear in GitHub code scanning. Step-level findings point at the
 * step's line in `steps.jsonl` (line = step index + 1); run-level findings point at `run.json`.
 * @example await writeFile("steplight.sarif", formatSarif(ctx))
 */
export function formatSarif(ctx: CheckContext): string {
  const { run, result } = ctx;
  const usedRules = [...new Set([...result.evaluated, ...result.findings.map((f) => f.ruleId)])];
  const sarif = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "Steplight",
            version: ctx.version,
            rules: usedRules.map((id) => ({
              id,
              name: id,
              shortDescription: { text: RULE_DESCRIPTIONS[id] },
              helpUri: "https://github.com/steplight-dev/steplight#agent-ci-checks",
              defaultConfiguration: { level: "error" },
            })),
          },
        },
        automationDetails: { id: `steplight/${run.id}` },
        results: result.findings.map((f) => ({
          ruleId: f.ruleId,
          level: sarifLevel(f),
          message: { text: f.message },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: f.stepIndex !== undefined ? ctx.stepsFile : ctx.runFile },
                region: { startLine: f.stepIndex !== undefined ? f.stepIndex + 1 : 1 },
              },
            },
          ],
        })),
      },
    ],
  };
  return JSON.stringify(sarif, null, 2);
}

/**
 * Format a check result.
 * @example const out = formatCheck("sarif", ctx)
 */
export function formatCheck(format: CheckFormat, ctx: CheckContext): string {
  switch (format) {
    case "junit":
      return formatJunit(ctx);
    case "sarif":
      return formatSarif(ctx);
    default:
      return formatText(ctx);
  }
}
