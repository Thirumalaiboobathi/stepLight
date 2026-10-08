import type { RunSummary } from "@steplight/core";
import { notableSeverity } from "../format";
import { SeverityBadge } from "./SeverityBadge";

const STATUS_DOT: Record<RunSummary["status"], string> = {
  running: "bg-blue-500 animate-pulse",
  success: "bg-emerald-500",
  failed: "bg-red-500",
};

/** List of recorded runs; clicking one selects it. */
export function RunList(props: {
  runs: RunSummary[];
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  if (props.runs.length === 0) {
    return (
      <p className="p-4 text-sm text-slate-500 dark:text-slate-400">
        No runs yet. Try <code>pnpm demo</code>, then refresh.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-slate-200 dark:divide-slate-800">
      {props.runs.map((run) => (
        <li key={run.id}>
          <button
            data-testid="run-item"
            onClick={() => props.onSelect(run.id)}
            className={`w-full px-4 py-3 text-left hover:bg-slate-100 dark:hover:bg-slate-800/60 ${
              run.id === props.selectedId ? "bg-slate-100 dark:bg-slate-800" : ""
            }`}
          >
            <div className="flex items-start gap-2">
              <span
                className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[run.status]}`}
                title={run.status}
              />
              <span
                title={run.task}
                data-testid="run-task"
                className="line-clamp-2 break-words text-sm font-medium"
              >
                {run.task}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
              <span>{new Date(run.startedAt).toLocaleString()}</span>
              <span>· {run.stepCount} steps</span>
              {notableSeverity(run.maxSeverity ? [{ severity: run.maxSeverity }] : []) ? (
                <SeverityBadge severity={run.maxSeverity} />
              ) : (
                <span
                  data-testid="clean-badge"
                  className="inline-block shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200"
                >
                  Clean
                </span>
              )}
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}
