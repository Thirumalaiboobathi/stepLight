/** Kinds of step a recorded agent can take. */
export type StepKind =
  | "navigate"
  | "page_read"
  | "click"
  | "type"
  | "form_submit"
  | "network_request"
  | "download"
  | "agent_note"
  | "error";

/** All step kinds, in display order. */
export const STEP_KINDS: readonly StepKind[] = [
  "navigate",
  "page_read",
  "click",
  "type",
  "form_submit",
  "network_request",
  "download",
  "agent_note",
  "error",
];

/** Kinds of suspicious moment a detector can flag. */
export type FlagType =
  | "hidden_instruction"
  | "cross_domain_data"
  | "sensitive_data_outbound"
  | "suspicious_redirect";

/** Flag severity, ordered low → critical. */
export type Severity = "low" | "medium" | "high" | "critical";

/** A suspicious moment attached to a step. */
export interface Flag {
  type: FlagType;
  severity: Severity;
  message: string;
  evidence: string;
}

/** Summary of an outbound HTTP request. */
export interface StepRequest {
  method: string;
  url: string;
  bodyPreview?: string;
}

/** One action or observation inside a run. */
export interface Step {
  id: string;
  runId: string;
  index: number;
  kind: StepKind;
  timestamp: number;
  durationMs?: number;
  url?: string;
  targetSelector?: string;
  targetText?: string;
  request?: StepRequest;
  /** Path (relative to the run folder) of the stored DOM/text snapshot. */
  snapshotRef?: string;
  flags: Flag[];
  /** Id of the step that most likely caused this step. */
  causedBy?: string;
}

/** Final or current state of a run. */
export type RunStatus = "running" | "success" | "failed";

/** One agent task and all of its steps. */
export interface Run {
  id: string;
  task: string;
  startedAt: number;
  endedAt?: number;
  status: RunStatus;
  steps: Step[];
  meta: Record<string, string>;
}

/** Lightweight listing entry for a stored run. */
export interface RunSummary {
  id: string;
  task: string;
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  stepCount: number;
  flagCount: number;
  maxSeverity?: Severity;
}
