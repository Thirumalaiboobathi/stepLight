/** Result of {@link validatePattern}. */
export type PatternCheck = { ok: true; regex: RegExp } | { ok: false; reason: string };

const MAX_PATTERN_LENGTH = 200;
/** One regex execution may take at most this long during the timing test (milliseconds). */
const SLOW_MS = 30;
/** Input sizes tried in turn. Exponential and high-degree polynomial patterns blow up well before the end. */
const SIZES = [8, 12, 16, 20, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512];

const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());
const isRepeat = (ch: string | undefined): boolean => ch === "+" || ch === "*";
const isBoundedRepeat = (rest: string): boolean => /^\{\d+,\d*\}/.test(rest);

/**
 * Structural check for the classic catastrophic shapes:
 * - a repeated group that itself contains a repeat: `(a+)+`, `(.*)*`, `(\w+\s?)*`;
 * - a repeated group of alternatives that are not clearly distinct: `(a|aa)+`, `(\w|\d)+`, `(.|x)*`;
 * - two adjacent repeats over the same kind of character: `\d+\d+`, `.*.*`, `a*a*`.
 */
export function hasCatastrophicShape(source: string): boolean {
  const stack: { repeats: boolean; alts: string[]; current: string }[] = [];
  let inClass = false;
  let previousAtom = ""; // the last atom followed by a repeat, for the adjacent-repeat check
  let lastWasRepeat = false;
  const repeatAfter = (i: number): boolean => isRepeat(source[i]) || (source[i] === "{" && isBoundedRepeat(source.slice(i)));
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    let atom = "";
    if (ch === "\\") {
      atom = source.slice(i, i + 2);
      i++;
    } else if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    } else if (ch === "[") {
      const close = source.indexOf("]", i + 2);
      atom = close < 0 ? "[" : source.slice(i, close + 1);
      inClass = false;
      if (close >= 0) i = close;
    } else if (ch === "(") {
      stack.push({ repeats: false, alts: [], current: "" });
      if (source[i + 1] === "?") {
        i++; // group modifier: (?: (?= (?! (?<= (?<! (?<name>
        while (":=!<".includes(source[i + 1] ?? "x")) i++;
      }
      lastWasRepeat = false;
      continue;
    } else if (ch === "|") {
      const g = stack[stack.length - 1];
      if (g) {
        g.alts.push(g.current);
        g.current = "";
      }
      lastWasRepeat = false;
      continue;
    } else if (ch === ")") {
      const g = stack.pop();
      const repeated = repeatAfter(i + 1);
      if (g) {
        g.alts.push(g.current);
        if (g.repeats && repeated) return true;
        if (repeated && g.alts.length > 1) {
          // Alternatives must start with different plain literal characters to be safe.
          const firsts = g.alts.map((a) => a[0] ?? "");
          const plain = firsts.every((f) => f !== "" && /[A-Za-z0-9_-]/.test(f));
          if (!plain || new Set(firsts).size !== firsts.length) return true;
        }
        if (g.repeats && stack.length > 0) stack[stack.length - 1]!.repeats = true;
      }
      lastWasRepeat = repeated;
      continue;
    } else if (isRepeat(ch) || ch === "?" || (ch === "{" && isBoundedRepeat(source.slice(i)))) {
      if (ch !== "?" && stack.length > 0) stack[stack.length - 1]!.repeats = true;
      continue;
    } else if (ch === "^" || ch === "$") {
      continue;
    } else {
      atom = ch;
    }
    const top = stack[stack.length - 1];
    if (top) top.current += atom;
    const repeated = repeatAfter(i + 1);
    if (repeated) {
      const broad = atom === "." || /^\\[wds]/i.test(atom) || atom.startsWith("[");
      if (lastWasRepeat && (atom === previousAtom || (broad && (previousAtom === "." || /^\\[wds]/i.test(previousAtom) || previousAtom.startsWith("["))))) {
        return true;
      }
      previousAtom = atom;
    }
    lastWasRepeat = repeated;
  }
  return false;
}

/** Adversarial inputs of one size; slow regexes show up as a sudden jump in time. */
function probes(n: number): string[] {
  return [
    "a".repeat(n) + "!",
    "1".repeat(n) + "x",
    "ab".repeat(Math.ceil(n / 2)) + "c",
    " ".repeat(n) + "x",
    "a@".repeat(Math.ceil(n / 2)) + "!",
    "x".repeat(n * 2),
    "-".repeat(n) + "\n",
    "a1 ".repeat(Math.ceil(n / 3)) + "!",
  ];
}

function time(source: string, probe: string): number {
  const re = new RegExp(source, "gi");
  const start = now();
  re.test(probe);
  return now() - start;
}

/**
 * Validate a user-supplied redaction pattern before it is ever used on page data.
 * Rejects: invalid syntax, over 200 characters, patterns that match the empty string (they would
 * redact everything), known catastrophic shapes (nested or ambiguous repetition), and patterns
 * that fail a timing test on adversarial inputs of growing size. Escalation stops at the first
 * slow size, so even a bad pattern costs at most a few tens of milliseconds to reject.
 * The compiled regex is case-insensitive and global. This is a safety net, not a proof: very
 * unusual patterns can still be slow on very long text.
 * @example validatePattern("EMP-\\d{6}") // { ok: true, regex: /EMP-\d{6}/gi }
 */
export function validatePattern(source: unknown): PatternCheck {
  if (typeof source !== "string" || source.length === 0) return { ok: false, reason: "Pattern is empty." };
  if (source.length > MAX_PATTERN_LENGTH) return { ok: false, reason: `Pattern is longer than ${MAX_PATTERN_LENGTH} characters.` };
  let regex: RegExp;
  try {
    regex = new RegExp(source, "gi");
  } catch (err) {
    return { ok: false, reason: `Not a valid regular expression (${err instanceof Error ? err.message : "syntax error"}).` };
  }
  if (new RegExp(source, "i").test("")) return { ok: false, reason: "Pattern matches empty text, which would redact everything." };
  if (hasCatastrophicShape(source)) {
    return { ok: false, reason: "Nested or ambiguous repetition such as (a+)+ or (a|aa)* can hang the browser. Simplify the pattern." };
  }
  for (const n of SIZES) {
    let slowest = 0;
    for (const probe of probes(n)) {
      // Best of two runs, so a garbage-collection pause is not mistaken for backtracking.
      const best = Math.min(time(source, probe), time(source, probe));
      slowest = Math.max(slowest, best);
      if (slowest > SLOW_MS) return { ok: false, reason: "Pattern is too slow on adversarial input (possible catastrophic backtracking)." };
    }
    if (slowest > 5) return { ok: false, reason: "Pattern gets slower very quickly as input grows (possible catastrophic backtracking)." };
  }
  return { ok: true, regex };
}

/** Compile the valid patterns of a list; invalid ones are skipped silently. */
export function compileCustomPatterns(sources: readonly string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const source of sources.slice(0, 50)) {
    const check = validatePattern(source);
    if (check.ok) out.push(check.regex);
  }
  return out;
}
