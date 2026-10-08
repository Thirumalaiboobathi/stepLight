import { redactText, type Finding, type Run, type Severity } from "@steplight/core";

const ICON: Record<Severity, string> = { low: "🔵", medium: "🟡", high: "🟠", critical: "🔴" };
const MAX_ROWS = 50;

// Control characters plus the Unicode line and paragraph separators. Built from code points so this
// source file holds no raw control or separator characters.
const chr = String.fromCharCode;
const CONTROL_CHARS = new RegExp(`[${chr(0)}-${chr(31)}${chr(127)}${chr(0x2028)}${chr(0x2029)}]+`, "g");

/**
 * Make untrusted text safe to embed in GitHub-flavoured Markdown (job summaries render it, including
 * inline HTML, links and images): redact secrets, drop control characters and newlines, shorten, and
 * backslash-escape every character that could start Markdown or HTML.
 * @example escapeMarkdown("<b>x</b> [a](b)") // "\<b\>x\</b\> \[a\]\(b\)"
 */
export function escapeMarkdown(text: string, maxLength = 200): string {
  let s = redactText(text).replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  if (s.length > maxLength) s = `${s.slice(0, maxLength - 1)}…`;
  // `@` and `:` are escaped too, so @mentions and ":emoji:" shortcodes stay literal text.
  return s.replace(/[\\`*_{}[\]()<>#+!|~&@:$]/g, (c) => `\\${c}`);
}

/** Inputs of {@link renderSummary}. */
export interface SummaryData {
  run: Run;
  passed: boolean;
  findings: readonly Finding[];
  failOn: Severity;
  notes: readonly string[];
}

/**
 * Markdown for the job summary: verdict, task, flags table and findings. All run content is
 * escaped; only fixed strings, numbers and the (validated) run id are written verbatim.
 */
export function renderSummary({ run, passed, findings, failOn, notes }: SummaryData): string {
  const flags = run.steps.flatMap((s) => s.flags.map((f) => ({ step: s.index, ...f })));
  const lines: string[] = [
    `## Steplight Agent Check: ${passed ? "✅ pass" : "❌ fail"}`,
    "",
    `**Task:** ${escapeMarkdown(run.task)}`,
    "",
    `Run \`${run.id}\` · ${run.steps.length} steps · ${flags.length} flag${flags.length === 1 ? "" : "s"} · fails on \`${failOn}\` or worse`,
    "",
  ];
  if (flags.length > 0) {
    lines.push("| Severity | Type | Step | Message |", "|---|---|---|---|");
    for (const f of flags.slice(0, MAX_ROWS)) {
      lines.push(`| ${ICON[f.severity]} ${f.severity} | ${escapeMarkdown(f.type, 60)} | ${f.step} | ${escapeMarkdown(f.message, 240)} |`);
    }
    if (flags.length > MAX_ROWS) lines.push("", `… and ${flags.length - MAX_ROWS} more flags (see the report file or the Steplight viewer).`);
    lines.push("");
  } else {
    lines.push("No flags were raised on this run.", "");
  }
  if (findings.length > 0) {
    lines.push("**Rule violations**", "");
    for (const f of findings.slice(0, MAX_ROWS)) lines.push(`- \`${f.ruleId}\`: ${escapeMarkdown(f.message, 300)}`);
    if (findings.length > MAX_ROWS) lines.push(`- … and ${findings.length - MAX_ROWS} more`);
    lines.push("");
  }
  for (const n of notes) lines.push(`> ${escapeMarkdown(n, 300)}`, "");
  return lines.join("\n");
}
