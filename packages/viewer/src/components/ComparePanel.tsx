import { useEffect, useState } from "react";
import { diffRuns, type AlignedPair, type Run, type RunDiff, type RunSummary, type Step } from "@steplight/core";
import { fetchRun, fetchSnapshot } from "../api";
import { KIND_ICON, describeStep } from "../format";

const STATUS_STYLE: Record<AlignedPair["status"], string> = {
  same: "border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900",
  changed: "border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/30",
  onlyA: "border-rose-300 bg-rose-50 dark:border-rose-800 dark:bg-rose-950/30",
  onlyB: "border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/30",
};

function Cell({ step, status, side }: { step?: Step; status: AlignedPair["status"]; side: "A" | "B" }) {
  const empty = !step || (status === "onlyA" && side === "B") || (status === "onlyB" && side === "A");
  if (empty) return <div className="rounded-lg border border-dashed border-slate-200 p-2 dark:border-slate-800" />;
  return (
    <div className={`min-w-0 rounded-lg border p-2 text-xs sm:text-sm ${STATUS_STYLE[status]}`}>
      <span aria-hidden>{KIND_ICON[step.kind]}</span>{" "}
      <span className="break-words font-medium">{describeStep(step)}</span>
      <div className="font-mono text-[11px] text-slate-500 dark:text-slate-400">
        #{step.index} · {step.kind}
        {step.flags.length > 0 ? ` · ${step.flags.length} flag${step.flags.length > 1 ? "s" : ""}` : ""}
      </div>
    </div>
  );
}

/** Compare the selected run (A) with another run (B): summary, aligned steps, text diff. */
export function ComparePanel(props: {
  runA: Run;
  runs: RunSummary[];
  /** Selected run B (controlled by the parent so exports can include the comparison). */
  bId?: string;
  onBChange: (id: string) => void;
}) {
  const { runA, runs, bId, onBChange } = props;
  const others = runs.filter((r) => r.id !== runA.id);
  const effectiveB = bId && others.some((r) => r.id === bId) ? bId : others[0]?.id;
  useEffect(() => {
    if (effectiveB && effectiveB !== bId) onBChange(effectiveB);
  }, [effectiveB, bId, onBChange]);
  const [runB, setRunB] = useState<Run | undefined>();
  const [diff, setDiff] = useState<RunDiff | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    setRunB(undefined);
    setDiff(undefined);
    setError(undefined);
    if (!effectiveB) return;
    let live = true;
    (async () => {
      const b = await fetchRun(effectiveB);
      const first = diffRuns(runA, b);
      const d = first.divergence;
      if (!d) return live && (setRunB(b), setDiff(first));
      const load = async (id: string, step: Step | undefined) => {
        const text = step ? await fetchSnapshot(id, step.id) : undefined;
        return step && text !== undefined ? { [step.id]: text } : {};
      };
      const snaps = { a: await load(runA.id, d.contextA), b: await load(b.id, d.contextB) };
      if (live) {
        setRunB(b);
        setDiff(diffRuns(runA, b, snaps));
      }
    })().catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [runA, effectiveB]);

  if (others.length === 0) {
    return <p className="p-6 text-sm text-slate-500 dark:text-slate-400">Record another run to compare against.</p>;
  }

  return (
    <div data-testid="compare-panel" className="p-3 sm:p-4">
      <label className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">Compare with (B):</span>
        <select
          data-testid="compare-select"
          value={effectiveB}
          onChange={(e) => onBChange(e.target.value)}
          className="min-w-0 max-w-full rounded-lg border border-slate-300 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
        >
          {others.map((r) => (
            <option key={r.id} value={r.id}>
              {r.task} · {new Date(r.startedAt).toLocaleTimeString()}
            </option>
          ))}
        </select>
      </label>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      {diff && runB && (
        <>
          <div
            data-testid="diff-summary"
            className={`mt-3 rounded-lg border p-3 text-sm ${
              diff.identical
                ? "border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/30"
                : "border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/30"
            }`}
          >
            <p className="font-semibold">{diff.summary}</p>
            <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">{diff.outcome}</p>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
            <div className="truncate">A · {runA.task}</div>
            <div className="truncate">B · {runB.task}</div>
          </div>
          <ol className="mt-2 space-y-1.5" data-testid="compare-rows">
            {diff.pairs.map((p, i) => (
              <li
                key={i}
                data-testid={i === diff.divergence?.pairIndex ? "diverge-row" : "compare-row"}
                data-status={p.status}
                className={`grid grid-cols-2 gap-2 rounded-lg ${
                  i === diff.divergence?.pairIndex ? "ring-2 ring-indigo-500" : ""
                }`}
              >
                <Cell step={p.a} status={p.status} side="A" />
                <Cell step={p.b} status={p.status} side="B" />
              </li>
            ))}
          </ol>

          {diff.divergence?.textDiff && (diff.divergence.textDiff.onlyA.length > 0 || diff.divergence.textDiff.onlyB.length > 0) && (
            <section className="mt-5" data-testid="diff-text">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                What each run saw at the divergence (page text only one of them had)
              </h3>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <TextColumn title="Only in A" lines={diff.divergence.textDiff.onlyA} tone="rose" />
                <TextColumn title="Only in B" lines={diff.divergence.textDiff.onlyB} tone="emerald" />
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function TextColumn({ title, lines, tone }: { title: string; lines: string[]; tone: "rose" | "emerald" }) {
  const cls =
    tone === "rose"
      ? "border-rose-300 bg-rose-50 dark:border-rose-800 dark:bg-rose-950/30"
      : "border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/30";
  return (
    <div className={`min-w-0 rounded-lg border p-2 ${cls}`}>
      <p className="mb-1 text-xs font-semibold">{title}</p>
      {lines.length === 0 ? (
        <p className="text-xs text-slate-500">(nothing)</p>
      ) : (
        <ul className="space-y-1 font-mono text-xs">
          {lines.map((l, i) => (
            <li key={i} className="break-words">
              {l}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
