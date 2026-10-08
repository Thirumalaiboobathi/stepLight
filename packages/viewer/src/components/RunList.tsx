import type { RunSummary } from "@steplight/core";
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
            <div className="flex items-center gap-2">
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[run.status]}`}
                title={run.status}
              />
              <span className="truncate text-sm font-medium">{run.task}</span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
              <span>{new Date(run.startedAt).toLocaleString()}</span>
              <span>· {run.stepCount} steps</span>
              <SeverityBadge severity={run.maxSeverity} />
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}
