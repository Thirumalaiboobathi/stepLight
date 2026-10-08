import { maxSeverity } from "./severity.js";
import type { Run, Severity, Step } from "./types.js";

/** Alignment result for one position when comparing two runs. */
export type PairStatus = "same" | "changed" | "onlyA" | "onlyB";

/** One row of the aligned comparison. */
export interface AlignedPair {
  a?: Step;
  b?: Step;
  status: PairStatus;
}

/** Quick facts about one side of a comparison. */
export interface RunStats {
  id: string;
  status: Run["status"];
  steps: number;
  flags: number;
  maxSeverity?: Severity;
}

/** Lines of page text seen by one run but not the other, at the divergence point. */
export interface TextDiff {
  onlyA: string[];
  onlyB: string[];
}

/** Where two runs first stop agreeing. */
export interface Divergence {
  /** Index into {@link RunDiff.pairs}. */
  pairIndex: number;
  a?: Step;
  b?: Step;
  /** Last page read before the divergence in each run: what that run was looking at. */
  contextA?: Step;
  contextB?: Step;
  /** Present when snapshots were supplied. */
  textDiff?: TextDiff;
}

/** Result of {@link diffRuns}. */
export interface RunDiff {
  identical: boolean;
  pairs: AlignedPair[];
  divergence?: Divergence;
  summary: string;
  outcome: string;
  statsA: RunStats;
  statsB: RunStats;
}

/** Optional snapshot text by step id, for each side. */
export interface DiffSnapshots {
  a?: Record<string, string>;
  b?: Record<string, string>;
}

function pathOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).pathname.replace(/\/+$/, "") || "/";
  } catch {
    return url;
  }
}

/**
 * Normalised identity of a step for alignment: kind plus page path plus target. Hosts and ports
 * are ignored (runs usually come from different servers), as are timestamps and ids.
 * @example stepKey(clickStep) // "click|/flights.html|a#select-premium"
 */
export function stepKey(s: Step): string {
  const failed = s.error ? "|failed" : "";
  switch (s.kind) {
    case "navigate":
      return `navigate|${pathOf(s.url)}`;
    case "page_read":
      return `page_read|${pathOf(s.url)}`;
    case "click":
    case "type":
      return `${s.kind}|${pathOf(s.url)}|${s.targetSelector ?? s.targetText ?? ""}${failed}`;
    case "form_submit":
      return `form_submit|${pathOf(s.url)}|${s.targetSelector ?? ""}|${pathOf(s.request?.url)}`;
    case "network_request":
      return `network_request|${s.request?.method ?? ""}|${pathOf(s.request?.url)}`;
    default:
      return `${s.kind}|${pathOf(s.url)}|${s.targetText ?? ""}`;
  }
}

const MAX_CELLS = 4_000_000;

/** Longest-common-subsequence alignment of two key lists; returns matched index pairs. */
function lcs(a: string[], b: string[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  if (n * m > MAX_CELLS) {
    // Too large for the quadratic table: fall back to position-wise matching.
    const out: [number, number][] = [];
    for (let i = 0; i < Math.min(n, m); i++) if (a[i] === b[i]) out.push([i, i]);
    return out;
  }
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const out: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push([i++, j++]);
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) i++;
    else j++;
  }
  return out;
}

function statsOf(run: Run): RunStats {
  const flags = run.steps.flatMap((s) => s.flags);
  return {
    id: run.id,
    status: run.status,
    steps: run.steps.length,
    flags: flags.length,
    maxSeverity: maxSeverity(flags),
  };
}

function linesOf(text: string | undefined): string[] {
  return (text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Lines present in one page snapshot but not the other (order-insensitive, long lines clipped).
 * @example diffSnapshotText("a\nb", "a\nc") // { onlyA: ["b"], onlyB: ["c"] }
 */
export function diffSnapshotText(a: string | undefined, b: string | undefined, limit = 40): TextDiff {
  const la = linesOf(a);
  const lb = linesOf(b);
  const sa = new Set(la);
  const sb = new Set(lb);
  const clip = (l: string) => (l.length > 300 ? `${l.slice(0, 300)}…` : l);
  return {
    onlyA: la.filter((l) => !sb.has(l)).slice(0, limit).map(clip),
    onlyB: lb.filter((l) => !sa.has(l)).slice(0, limit).map(clip),
  };
}

/** Short past-tense description of a step for the summary line. */
export function describeAction(s: Step | undefined): string {
  if (!s) return "had no more steps";
  const fail = s.error ? " (failed)" : "";
  switch (s.kind) {
    case "click":
      return `clicked '${s.targetText ?? s.targetSelector ?? "an element"}'${fail}`;
    case "type":
      return `edited '${(s.targetText ?? s.targetSelector ?? "a field").replace(/ \(value not recorded\)$/, "")}'${fail}`;
    case "navigate":
      return `navigated to ${pathOf(s.url)}`;
    case "page_read":
      return `read ${pathOf(s.url)}`;
    case "form_submit":
      return `submitted a form to ${pathOf(s.request?.url)}`;
    case "network_request":
      return `sent ${s.request?.method ?? "a"} request to ${pathOf(s.request?.url)}`;
    case "download":
      return `downloaded ${s.targetText ?? "a file"}`;
    case "error":
      return `hit an error: ${(s.targetText ?? s.error ?? "").slice(0, 80)}`;
    default:
      return s.kind;
  }
}

function lastReadBefore(run: Run, step: Step | undefined): Step | undefined {
  const end = step ? step.index : run.steps.length;
  for (let i = Math.min(end, run.steps.length) - 1; i >= 0; i--) {
    if (run.steps[i]!.kind === "page_read") return run.steps[i];
  }
  return undefined;
}

const hasHidden = (s: Step | undefined): boolean =>
  !!s?.flags.some((f) => f.type === "hidden_instruction" && f.severity !== "low");

/**
 * Compare two runs. Steps are aligned by kind + normalised URL path + target (agent notes are
 * left out of the alignment), the first point where they disagree is located, and a one-line
 * summary explains it. Pass snapshots to also get a text diff of what each run was looking at.
 * @example
 * const d = diffRuns(runA, runB);
 * console.log(d.summary); // "Runs diverged at step 4: A clicked 'Select Economy', B clicked …"
 */
export function diffRuns(runA: Run, runB: Run, snapshots: DiffSnapshots = {}): RunDiff {
  const stepsA = runA.steps.filter((s) => s.kind !== "agent_note");
  const stepsB = runB.steps.filter((s) => s.kind !== "agent_note");
  const matches = lcs(stepsA.map(stepKey), stepsB.map(stepKey));

  const pairs: AlignedPair[] = [];
  let i = 0;
  let j = 0;
  const flushGap = (toI: number, toJ: number) => {
    const gapA = stepsA.slice(i, toI);
    const gapB = stepsB.slice(j, toJ);
    const common = Math.min(gapA.length, gapB.length);
    for (let k = 0; k < common; k++) pairs.push({ a: gapA[k], b: gapB[k], status: "changed" });
    for (const a of gapA.slice(common)) pairs.push({ a, status: "onlyA" });
    for (const b of gapB.slice(common)) pairs.push({ b, status: "onlyB" });
  };
  for (const [mi, mj] of matches) {
    flushGap(mi, mj);
    pairs.push({ a: stepsA[mi], b: stepsB[mj], status: "same" });
    i = mi + 1;
    j = mj + 1;
  }
  flushGap(stepsA.length, stepsB.length);

  const statsA = statsOf(runA);
  const statsB = statsOf(runB);
  const describeSide = (s: RunStats) =>
    `${s.status} with ${s.flags} flag${s.flags === 1 ? "" : "s"}${s.maxSeverity ? ` (max ${s.maxSeverity})` : ""}`;
  const outcome = `Outcome: A ${describeSide(statsA)}; B ${describeSide(statsB)}.`;

  const pairIndex = pairs.findIndex((p) => p.status !== "same");
  if (pairIndex < 0) {
    return {
      identical: true,
      pairs,
      summary: `Runs are identical (${pairs.length} aligned steps).`,
      outcome,
      statsA,
      statsB,
    };
  }

  const first = pairs[pairIndex]!;
  const contextA = lastReadBefore(runA, first.a);
  const contextB = lastReadBefore(runB, first.b);
  const divergence: Divergence = { pairIndex, a: first.a, b: first.b, contextA, contextB };
  if (snapshots.a || snapshots.b) {
    divergence.textDiff = diffSnapshotText(
      contextA ? snapshots.a?.[contextA.id] : undefined,
      contextB ? snapshots.b?.[contextB.id] : undefined,
    );
  }

  const stepNo =
    first.a && first.b && first.a.index !== first.b.index
      ? `step ${first.a.index} (A) / ${first.b.index} (B)`
      : `step ${(first.a ?? first.b)!.index}`;
  const hiddenA = hasHidden(contextA);
  const hiddenB = hasHidden(contextB);
  const noteFor = (hidden: boolean, otherHidden: boolean, ctx: Step | undefined) =>
    hidden && !otherHidden ? ` after reading hidden text on ${pathOf(ctx?.url)}` : "";
  const summary = `Runs diverged at ${stepNo}: A ${describeAction(first.a)}${noteFor(hiddenA, hiddenB, contextA)}, B ${describeAction(first.b)}${noteFor(hiddenB, hiddenA, contextB)}.`;

  return { identical: false, pairs, divergence, summary, outcome, statsA, statsB };
}
