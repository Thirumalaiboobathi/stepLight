import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  createBundle,
  readRun,
  readSnapshot,
  renderHtmlReport,
  type RunBundle,
} from "@steplight/core/node";

/**
 * Load a stored run and all its snapshots as a portable bundle.
 * @example const bundle = await loadBundle(".steplight/runs", "20261008-101500-a1b2c3")
 */
export async function loadBundle(root: string, runId: string): Promise<RunBundle> {
  const run = await readRun(root, runId);
  const snapshots: Record<string, string> = {};
  for (const step of run.steps) {
    const text = await readSnapshot(root, runId, step);
    if (text !== undefined) snapshots[step.id] = text;
  }
  return createBundle(run, snapshots);
}

/**
 * Render the single-file HTML report for a stored run (optionally compared with another run).
 * @example const html = await renderStoredReport(dir, runId, otherRunId)
 */
export async function renderStoredReport(root: string, runId: string, compareId?: string): Promise<string> {
  const bundle = await loadBundle(path.resolve(root), runId);
  const compare = compareId ? await loadBundle(path.resolve(root), compareId) : undefined;
  return renderHtmlReport(bundle, { compare });
}

/** Read a previously exported run file (JSON) from disk. Exposed for tests. */
export async function readBundleFile(file: string): Promise<string> {
  return readFile(file, "utf8");
}
