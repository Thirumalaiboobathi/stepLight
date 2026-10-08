import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import type { Run, RunSummary } from "@steplight/core";
import { buildBundle, downloadText, fetchRun, fetchRuns, importRunFile } from "./api";
import { Logo } from "./components/Logo";
import { firstFlaggedIndex } from "./format";
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
  const [notice, setNotice] = useState<string | undefined>();
  const fileRef = useRef<HTMLInputElement>(null);
  const autoIndexFor = useRef<string | undefined>(undefined);
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
        // On first load, open the newest run.
        setRunId((current) => {
          if (current || !r[0]) return current;
          autoIndexFor.current = r[0].id;
          return r[0].id;
        });
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
        .then((r) => {
          if (!live) return;
          setRun(r);
          if (autoIndexFor.current === runId) {
            autoIndexFor.current = undefined;
            setIndex(firstFlaggedIndex(r.steps));
          }
        })
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
    autoIndexFor.current = id;
    setRunId(id);
  };
  const toggleReplay = () => {
    if (!run || run.steps.length === 0) return; // aria-disabled: ignore clicks
    if (!replaying && index >= run.steps.length - 1) setIndex(0);
    setReplaying((r) => !r);
  };
  const jump = (i: number) => {
    setReplaying(false);
    setIndex(i);
  };

  const exportJson = async () => {
    if (!run) return;
    try {
      const bundle = await buildBundle(run);
      downloadText(`steplight-${run.id}.json`, JSON.stringify(bundle, null, 2));
    } catch (e) {
      setNotice(`Export failed: ${(e as Error).message}`);
    }
  };
  const onImport = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const id = await importRunFile(await file.text());
      loadRuns();
      select(id);
      setNotice(`Imported ${file.name}`);
    } catch (err) {
      setNotice((err as Error).message);
    }
  };

  const step = run?.steps[index];

  return (
    <div className="flex min-h-full flex-col bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-200 bg-white/90 px-4 py-3 backdrop-blur dark:border-slate-800 dark:bg-slate-900/90">
        <h1 className="flex items-center gap-2 text-lg font-bold tracking-tight">
          <Logo size={26} /> Steplight
        </h1>
        <span className="hidden text-sm text-slate-500 sm:inline dark:text-slate-400">
          Replay and trace every step your AI agent takes
        </span>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <input
            ref={fileRef}
            data-testid="import-input"
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => void onImport(e)}
          />
          <button
            data-testid="import"
            onClick={() => fileRef.current?.click()}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700"
          >
            Import
          </button>
          <button
            data-testid="export"
            onClick={() => void exportJson()}
            disabled={!run}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-40 dark:border-slate-700"
          >
            Export JSON
          </button>
          <button
            data-testid="replay"
            onClick={toggleReplay}
            aria-disabled={!run || run.steps.length === 0}
            title={run ? "Replay the steps one by one" : "Select a run first"}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium text-white ${
              run && run.steps.length > 0
                ? "bg-indigo-600 hover:bg-indigo-500"
                : "cursor-not-allowed bg-slate-400 opacity-60 dark:bg-slate-600"
            }`}
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

      {notice && (
        <p
          data-testid="notice"
          onClick={() => setNotice(undefined)}
          className="cursor-pointer bg-indigo-100 px-4 py-2 text-sm text-indigo-900 dark:bg-indigo-950 dark:text-indigo-200"
        >
          {notice}
        </p>
      )}
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
