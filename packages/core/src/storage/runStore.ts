import { promises as fs } from "node:fs";
import path from "node:path";
import { isSafeId } from "../ids.js";
import { redactText, sanitizeSnapshot } from "../redact.js";
import { sanitizeStep } from "../sanitize.js";
import { maxSeverity } from "../severity.js";
import type { Run, RunSummary, Step } from "../types.js";

/** Default location of run output, relative to the working directory. */
export const DEFAULT_RUNS_DIR = path.join(".steplight", "runs");

function runDir(root: string, runId: string): string {
  if (!isSafeId(runId)) throw new Error(`Unsafe run id: ${runId}`);
  return path.join(root, runId);
}

/** Incrementally writes one run to `<root>/<runId>/`. All data is redacted before writing. */
export class RunWriter {
  readonly dir: string;
  private run: Run;
  private queue: Promise<void> = Promise.resolve();

  private constructor(root: string, run: Run) {
    this.dir = runDir(root, run.id);
    this.run = run;
  }

  /**
   * Create the run folder and write the initial `run.json`.
   * @example const w = await RunWriter.create(".steplight/runs", run)
   */
  static async create(root: string, run: Run): Promise<RunWriter> {
    const writer = new RunWriter(root, { ...run, steps: [] });
    await fs.mkdir(path.join(writer.dir, "snapshots"), { recursive: true });
    await fs.writeFile(path.join(writer.dir, "steps.jsonl"), "");
    await writer.writeMeta();
    return writer;
  }

  private async writeMeta(): Promise<void> {
    const meta = { ...this.run, steps: undefined, task: redactText(this.run.task) };
    await fs.writeFile(path.join(this.dir, "run.json"), JSON.stringify(meta, null, 2));
  }

  private enqueue(job: () => Promise<void>): Promise<void> {
    const next = this.queue.then(job);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * Append a step (and optionally its snapshot text). Sets `snapshotRef` when given text.
   * @example await writer.addStep(step, pageText)
   */
  addStep(step: Step, snapshotText?: string): Promise<void> {
    return this.enqueue(async () => {
      const toWrite: Step = { ...step };
      if (snapshotText !== undefined) {
        toWrite.snapshotRef = `snapshots/${step.id}.txt`;
        await fs.writeFile(path.join(this.dir, toWrite.snapshotRef), sanitizeSnapshot(snapshotText));
      }
      await fs.appendFile(
        path.join(this.dir, "steps.jsonl"),
        JSON.stringify(sanitizeStep(toWrite)) + "\n",
      );
    });
  }

  /**
   * Update the run status / end time and rewrite `run.json`.
   * @example await writer.finish("success", Date.now())
   */
  finish(status: Run["status"], endedAt: number): Promise<void> {
    return this.enqueue(async () => {
      this.run = { ...this.run, status, endedAt };
      await this.writeMeta();
    });
  }
}

/**
 * Write a complete run in one call (used by tests and importers).
 * @example await writeRun(".steplight/runs", run)
 */
export async function writeRun(
  root: string,
  run: Run,
  snapshots: Record<string, string> = {},
): Promise<void> {
  const writer = await RunWriter.create(root, run);
  for (const step of run.steps) await writer.addStep(step, snapshots[step.id]);
  if (run.endedAt !== undefined) await writer.finish(run.status, run.endedAt);
}

/**
 * Read a stored run (metadata + steps).
 * @example const run = await readRun(".steplight/runs", "20261008-101500-a1b2c3")
 */
export async function readRun(root: string, runId: string): Promise<Run> {
  const dir = runDir(root, runId);
  const meta = JSON.parse(await fs.readFile(path.join(dir, "run.json"), "utf8")) as Run;
  const raw = await fs.readFile(path.join(dir, "steps.jsonl"), "utf8").catch(() => "");
  const steps: Step[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      steps.push(JSON.parse(line) as Step);
    } catch {
      /* skip a partially written line */
    }
  }
  steps.sort((a, b) => a.index - b.index);
  return { ...meta, steps };
}

/**
 * Read the snapshot text of a step, or undefined if none was stored.
 * @example const text = await readSnapshot(root, runId, step)
 */
export async function readSnapshot(
  root: string,
  runId: string,
  step: Pick<Step, "snapshotRef">,
): Promise<string | undefined> {
  if (!step.snapshotRef) return undefined;
  const dir = runDir(root, runId);
  const file = path.resolve(dir, step.snapshotRef);
  if (!file.startsWith(path.resolve(dir) + path.sep)) return undefined;
  return fs.readFile(file, "utf8").catch(() => undefined);
}

/**
 * Summarise a run for listings.
 * @example summarizeRun(run).maxSeverity
 */
export function summarizeRun(run: Run): RunSummary {
  const flags = run.steps.flatMap((s) => s.flags);
  return {
    id: run.id,
    task: run.task,
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    stepCount: run.steps.length,
    flagCount: flags.length,
    maxSeverity: maxSeverity(flags),
  };
}

/**
 * List all runs under a root, newest first. Unreadable folders are skipped.
 * @example const runs = await listRuns(".steplight/runs")
 */
export async function listRuns(root: string): Promise<RunSummary[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const out: RunSummary[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || !isSafeId(e.name)) continue;
    try {
      out.push(summarizeRun(await readRun(root, e.name)));
    } catch {
      /* not a run folder */
    }
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * Delete one stored run folder. Returns false if it did not exist.
 * @example await deleteRun(".steplight/runs", "20261008-101500-a1b2c3")
 */
export async function deleteRun(root: string, runId: string): Promise<boolean> {
  const dir = runDir(root, runId);
  const exists = await fs.stat(dir).then(() => true, () => false);
  if (exists) await fs.rm(dir, { recursive: true, force: true });
  return exists;
}

/** Options for {@link clearRuns}. */
export interface ClearOptions {
  /** Keep the newest N runs (by start time) that match. Default 0. */
  keep?: number;
  /** Only consider runs for which this returns true (e.g. demo runs). */
  filter?: (run: RunSummary & { meta: Run["meta"] }) => boolean;
}

/**
 * Delete stored runs, optionally keeping the newest N. Only valid run folders inside `root`
 * are touched. Returns the deleted run ids.
 * @example await clearRuns(".steplight/runs", { keep: 5 })
 */
export async function clearRuns(root: string, options: ClearOptions = {}): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const candidates: (RunSummary & { meta: Run["meta"] })[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || !isSafeId(e.name)) continue;
    try {
      const run = await readRun(root, e.name);
      const summary = { ...summarizeRun(run), meta: run.meta };
      if (!options.filter || options.filter(summary)) candidates.push(summary);
    } catch {
      /* not a run folder: leave it alone */
    }
  }
  candidates.sort((a, b) => b.startedAt - a.startedAt);
  const doomed = candidates.slice(Math.max(0, options.keep ?? 0));
  for (const r of doomed) await deleteRun(root, r.id);
  return doomed.map((r) => r.id);
}

/** Options for {@link purgeRuns}. */
export interface PurgeOptions {
  /** Delete runs that started more than this many days ago. */
  olderThanDays?: number;
  /** Delete every run. */
  all?: boolean;
  /** Clock override for tests. */
  now?: number;
}

/**
 * Retention for run folders: delete runs older than N days (or all of them). The whole run
 * folder goes, including every snapshot file. Returns the deleted run ids. Only valid run
 * folders inside `root` are touched. Note: removing a file does not overwrite its bytes on disk;
 * on a shared or unencrypted disk, use the encryption options as well.
 * @example await purgeRuns(".steplight/runs", { olderThanDays: 7 })
 */
export async function purgeRuns(root: string, options: PurgeOptions): Promise<string[]> {
  if (!options.all && (options.olderThanDays === undefined || !(options.olderThanDays >= 0))) return [];
  const cutoff = (options.now ?? Date.now()) - (options.olderThanDays ?? 0) * 86_400_000;
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const deleted: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || !isSafeId(e.name)) continue;
    try {
      const run = await readRun(root, e.name);
      if (options.all || run.startedAt < cutoff) {
        await deleteRun(root, e.name);
        deleted.push(e.name);
      }
    } catch {
      /* not a run folder: leave it alone */
    }
  }
  return deleted;
}
