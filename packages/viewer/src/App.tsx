import { useCallback, useEffect, useRef, useState } from "react";
import type { Run, RunSummary } from "@steplight/core";
import { fetchRun, fetchRuns } from "./api";
import { RunList } from "./components/RunList";
import { StepDetail } from "./components/StepDetail";
import { Timeline } from "./components/Timeline";

const REPLAY_INTERVAL_MS = 800;

function initialDark(): boolean {
  try {
    const saved = localStorage.getItem("steplight-theme");
    if (saved) return saved === "dark";
  } catch {
    /* storage unavailable */
  }
  return true;
}

/** Root component: run list, timeline, step details and replay controls. */
export default function App() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [runId, setRunId] = useState<string | undefined>();
  const [run, setRun] = useState<Run | undefined>();
  const [index, setIndex] = useState(0);
  const [replaying, setReplaying] = useState(false);
  const [dark, setDark] = useState(initialDark);
  const [error, setError] = useState<string | undefined>();
  const stepsRef = useRef(0);
  stepsRef.current = run?.steps.length ?? 0;

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    try {
      localStorage.setItem("steplight-theme", dark ? "dark" : "light");
    } catch {
      /* storage unavailable */
    }
  }, [dark]);

  const loadRuns = useCallback(() => {
    fetchRuns()
      .then((r) => {
        setRuns(r);
        setError(undefined);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    loadRuns();
    const t = setInterval(loadRuns, 3000);
    return () => clearInterval(t);
  }, [loadRuns]);

  useEffect(() => {
    if (!runId) return;
    let live = true;
    const load = () =>
      fetchRun(runId)
        .then((r) => live && setRun(r))
        .catch(() => undefined);
    void load();
    const t = run?.status === "running" ? setInterval(load, 2000) : undefined;
    return () => {
      live = false;
      if (t) clearInterval(t);
    };
  }, [runId, run?.status]);

  useEffect(() => {
    if (!replaying) return;
    const t = setInterval(() => {
      setIndex((i) => {
        if (i + 1 >= stepsRef.current) {
          setReplaying(false);
          return i;
        }
        return i + 1;
      });
    }, REPLAY_INTERVAL_MS);
    return () => clearInterval(t);
  }, [replaying]);

  const select = (id: string) => {
    setReplaying(false);
    setRun(undefined);
    setIndex(0);
    setRunId(id);
  };
  const toggleReplay = () => {
    if (!run || run.steps.length === 0) return;
    if (!replaying && index >= run.steps.length - 1) setIndex(0);
    setReplaying((r) => !r);
  };
  const jump = (i: number) => {
    setReplaying(false);
    setIndex(i);
  };

  const step = run?.steps[index];

  return (
    <div className="flex min-h-full flex-col bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-slate-200 bg-white/90 px-4 py-3 backdrop-blur dark:border-slate-800 dark:bg-slate-900/90">
        <h1 className="text-lg font-bold tracking-tight">
          <span aria-hidden>🔦</span> Steplight
        </h1>
        <span className="hidden text-sm text-slate-500 sm:inline dark:text-slate-400">
          Replay and trace every step your AI agent takes
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            data-testid="replay"
            onClick={toggleReplay}
            disabled={!run || run.steps.length === 0}
            className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
          >
            {replaying ? "⏸ Pause" : "▶ Replay"}
          </button>
          <button
            aria-label="Toggle dark mode"
            onClick={() => setDark((d) => !d)}
            className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm dark:border-slate-700"
          >
            {dark ? "☀️" : "🌙"}
          </button>
        </div>
      </header>

      {error && (
        <p className="bg-red-100 px-4 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
          Cannot reach the Steplight server: {error}
        </p>
      )}

      <div className="grid flex-1 grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)_400px]">
        <aside className="max-h-56 overflow-auto border-b border-slate-200 bg-white lg:max-h-none lg:border-b-0 lg:border-r dark:border-slate-800 dark:bg-slate-900">
          <RunList runs={runs} selectedId={runId} onSelect={select} />
        </aside>

        <main className="min-w-0">
          {run ? (
            <>
              <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
                <h2 className="font-semibold">{run.task}</h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {run.steps.length} steps · {run.status}
                </p>
              </div>
              <Timeline
                run={run}
                selectedIndex={index}
                revealUpTo={replaying ? index : Number.MAX_SAFE_INTEGER}
                onSelect={jump}
              />
            </>
          ) : (
            <p className="p-6 text-sm text-slate-500 dark:text-slate-400">
              {runId ? "Loading…" : "Select a run to see its timeline."}
            </p>
          )}
        </main>

        <aside className="min-w-0 border-t border-slate-200 bg-white lg:border-l lg:border-t-0 dark:border-slate-800 dark:bg-slate-900">
          {run && step ? (
            <StepDetail run={run} step={step} onJump={jump} />
          ) : (
            <p className="p-6 text-sm text-slate-500 dark:text-slate-400">Select a step for details.</p>
          )}
        </aside>
      </div>
    </div>
  );
}
