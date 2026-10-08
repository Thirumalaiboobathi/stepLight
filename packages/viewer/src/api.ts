import type { Run, RunSummary } from "@steplight/core";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return (await res.json()) as T;
}

/** Fetch the list of stored runs, newest first. */
export const fetchRuns = (): Promise<RunSummary[]> => getJson("/api/runs");

/** Fetch one run with all its steps. */
export const fetchRun = (id: string): Promise<Run> =>
  getJson(`/api/runs/${encodeURIComponent(id)}`);

/** Fetch the stored snapshot text of a step, or undefined if there is none. */
export async function fetchSnapshot(runId: string, stepId: string): Promise<string | undefined> {
  const res = await fetch(
    `/api/runs/${encodeURIComponent(runId)}/snapshot/${encodeURIComponent(stepId)}`,
  );
  return res.ok ? res.text() : undefined;
}
