import type { Run, Step } from "@steplight/core";

/**
 * Message accepted by the local server's `POST /api/ingest`.
 * Mirrors `IngestMessage` in `@steplight/cli` (kept separate so the extension bundle
 * never imports Node code).
 */
export type IngestMessage =
  | { type: "run_start"; run: Pick<Run, "id" | "task" | "startedAt"> & { meta?: Run["meta"] } }
  | { type: "step"; runId: string; step: Step; snapshot?: string }
  | { type: "run_end"; runId: string; status: "success" | "failed"; endedAt?: number };
