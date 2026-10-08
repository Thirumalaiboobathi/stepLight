import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";

/** Environment the runner provides; injectable so tests need not touch `process.env`. */
export type Env = Record<string, string | undefined>;

/**
 * Read an action input the way the runner exposes it (`INPUT_<NAME>`, upper-cased, spaces to `_`).
 * @example getInput(process.env, "runs-dir") // reads INPUT_RUNS-DIR
 */
export function getInput(env: Env, name: string): string {
  return (env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();
}

const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

/**
 * Make untrusted text safe to print to the job log: the runner interprets any line that starts with
 * `::` as a workflow command (`::set-env`, `::add-mask`, `::stop-commands`, …), so a page-controlled
 * string must never be able to start a line that way. Control characters are replaced too.
 * A zero-width space is put in front of the colons (not a plain space, which some parsers trim).
 * @example neutralizeLog("::error::x") // zero-width space + "::error::x"
 */
export function neutralizeLog(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "?")
    .split(/\r\n|\r|\n/)
    .map((line) => line.replace(/^(\s*)::/, (_m, ws: string) => `${ws}${ZERO_WIDTH_SPACE}::`))
    .join("\n");
}

/** Escape a message for a workflow command (`::error::message`). */
export function escapeCommandData(text: string): string {
  return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/** Write a line (or lines) to the job log, neutralised. */
export function info(text: string): void {
  process.stdout.write(`${neutralizeLog(text)}\n`);
}

/** Emit an error annotation. The text is a fixed or validated message, never page content. */
export function error(text: string): void {
  process.stdout.write(`::error::${escapeCommandData(text)}\n`);
}

/** Emit a notice annotation. */
export function notice(text: string): void {
  process.stdout.write(`::notice::${escapeCommandData(text)}\n`);
}

/**
 * Set a step output through the `GITHUB_OUTPUT` file, using a random delimiter so a value can never
 * terminate its own entry and inject another output.
 * @example setOutput(env, "result", "pass")
 */
export function setOutput(env: Env, name: string, value: string): void {
  const file = env["GITHUB_OUTPUT"];
  if (!file) return;
  let delimiter = `ghadelim_${randomBytes(16).toString("hex")}`;
  while (value.includes(delimiter) || name.includes(delimiter)) delimiter = `ghadelim_${randomBytes(16).toString("hex")}`;
  appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

/** Append Markdown to the job summary. */
export function appendSummary(env: Env, markdown: string): void {
  const file = env["GITHUB_STEP_SUMMARY"];
  if (!file) return;
  appendFileSync(file, `${markdown}\n`);
}
