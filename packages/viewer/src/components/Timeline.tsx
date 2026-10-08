import type { Run } from "@steplight/core";
import { KIND_ICON, SEVERITY_STYLE, describeStep, notableSeverity, offset, shortUrl } from "../format";
import { SeverityBadge } from "./SeverityBadge";

/** Vertical timeline of steps. Steps after `revealUpTo` are dimmed during replay. */
export function Timeline(props: {
  run: Run;
  selectedIndex: number;
  revealUpTo: number;
  onSelect: (index: number) => void;
}) {
  return (
    <ol className="space-y-1.5 p-3 sm:p-4">
      {props.run.steps.map((step) => {
        const worst = notableSeverity(step.flags);
        const selected = step.index === props.selectedIndex;
        const dim = step.index > props.revealUpTo;
        return (
          <li key={step.id}>
            <button
              data-testid="step-item"
              data-kind={step.kind}
              data-severity={worst ?? ""}
              onClick={() => props.onSelect(step.index)}
              className={`flex w-full items-start gap-3 rounded-lg border border-l-4 border-slate-200 px-3 py-2 text-left transition dark:border-slate-800 ${
                worst
                  ? SEVERITY_STYLE[worst].row
                  : step.error
                    ? "border-l-red-400 bg-red-50/60 dark:bg-red-950/30"
                    : "border-l-transparent bg-white dark:bg-slate-900"
              } ${
                selected
                  ? "ring-2 ring-indigo-500"
                  : "hover:border-slate-300 dark:hover:border-slate-600"
              } ${dim ? "opacity-35" : ""}`}
            >
              <span className="w-12 shrink-0 pt-0.5 font-mono text-xs text-slate-500 dark:text-slate-400">
                {offset(step.timestamp, props.run.startedAt)}
              </span>
              <span aria-hidden className="shrink-0 text-lg leading-6">
                {KIND_ICON[step.kind]}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block break-words text-sm font-medium">{describeStep(step)}</span>
                <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
                  #{step.index} · {step.kind}
                  {step.url ? ` · ${shortUrl(step.url)}` : ""}
                </span>
              </span>
              {step.error && (
                <span
                  data-testid="failed-badge"
                  className="shrink-0 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium uppercase text-red-800 dark:bg-red-900/50 dark:text-red-200"
                >
                  failed
                </span>
              )}
              <SeverityBadge
                severity={worst}
                label={worst ? `${step.flags.length} · ${worst}` : undefined}
              />
            </button>
          </li>
        );
      })}
    </ol>
  );
}
