import {
  analyzeStep,
  inferCausedBy,
  newRunId,
  newStepId,
  redactText,
  sanitizeBody,
  sanitizeSnapshot,
  type Step,
  type StepKind,
} from "@steplight/core";
import type { IngestMessage } from "./ingest-types.js";
import type { ExtensionMessage, PageEventMsg, StatusReply } from "./messages.js";

/** Recording state kept in extension storage so it survives service-worker restarts. */
export interface Session {
  runId: string;
  task: string;
  startedAt: number;
  steps: Step[];
  /** Recent page texts used by the cross-domain detector (kept small). */
  pages: { url?: string; text: string }[];
  lastNavUrl?: string;
}

/** Everything the service worker needs from the outside world (injected for testing). */
export interface BackgroundDeps {
  load(): Promise<Session | undefined>;
  save(session: Session | undefined): Promise<void>;
  /** Deliver a message to the local Steplight server. May reject. */
  post(message: IngestMessage): Promise<void>;
  /** Make the content script run on all pages (after permission is granted). */
  enableRecorder(): Promise<void>;
  disableRecorder(): Promise<void>;
  now(): number;
}

const MAX_PAGES = 5;
const MAX_PAGE_TEXT = 20_000;

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function stepFromEvent(
  session: Session,
  event: PageEventMsg,
): { step: Step; snapshot?: string; navigate?: Step } {
  const base = (kind: StepKind, fields: Partial<Step>): Step => ({
    id: newStepId(session.steps.length),
    runId: session.runId,
    index: session.steps.length,
    kind,
    timestamp: event.timestamp,
    flags: [],
    ...fields,
  });
  switch (event.kind) {
    case "page_read":
      return {
        step: base("page_read", { url: event.url, targetText: event.title, flags: [...event.flags] }),
        snapshot: event.text,
      };
    case "click":
      return { step: base("click", { url: event.url, targetSelector: event.selector, targetText: event.text }) };
    case "type":
      return {
        step: base("type", {
          url: event.url,
          targetSelector: event.selector,
          targetText: `${event.text} (value not recorded)`,
        }),
      };
    case "form_submit":
      return {
        step: base("form_submit", {
          url: event.url,
          targetSelector: event.selector,
          targetText: "form",
          request: { method: event.method, url: event.action, bodyPreview: event.body },
        }),
      };
  }
}

/**
 * Turn a content-script event into zero or more ingest messages, updating the session.
 * Detectors run on raw data; everything is redacted before it leaves this function.
 * @example const out = recordEvent(session, event)
 */
export function recordEvent(session: Session, event: PageEventMsg): IngestMessage[] {
  const out: IngestMessage[] = [];
  const emit = (built: { step: Step; snapshot?: string }) => {
    const { step } = built;
    step.flags.push(...analyzeStep(step, session.steps, session.pages));
    const cause = inferCausedBy(step, session.steps);
    if (cause) step.causedBy = cause;
    session.steps.push(step);
    const safe: Step = { ...step };
    if (safe.request?.bodyPreview !== undefined) {
      safe.request = { ...safe.request, bodyPreview: sanitizeBody(safe.request.bodyPreview) };
    }
    out.push({
      type: "step",
      runId: session.runId,
      step: safe,
      ...(built.snapshot !== undefined ? { snapshot: sanitizeSnapshot(built.snapshot) } : {}),
    });
  };

  if (event.kind === "page_read" && event.url !== session.lastNavUrl) {
    session.lastNavUrl = event.url;
    emit({
      step: {
        id: newStepId(session.steps.length),
        runId: session.runId,
        index: session.steps.length,
        kind: "navigate",
        timestamp: event.timestamp,
        url: event.url,
        flags: [],
      },
    });
  }
  if (event.kind === "page_read") {
    session.pages.push({ url: event.url, text: event.text.slice(0, MAX_PAGE_TEXT) });
    if (session.pages.length > MAX_PAGES) session.pages.shift();
  }
  emit(stepFromEvent(session, event));
  return out;
}

/**
 * Handle one message sent to the service worker. Never throws: failures are reported in
 * the reply (`error`) so a missing local server cannot break the browsing session.
 * @example const reply = await handleMessage({ type: "status" }, deps)
 */
export async function handleMessage(
  message: ExtensionMessage,
  deps: BackgroundDeps,
): Promise<StatusReply> {
  let session: Session | undefined;
  try {
    session = await deps.load();
    switch (message.type) {
      case "start": {
        if (session) return reply(session);
        const next: Session = {
          runId: newRunId(new Date(deps.now())),
          task: redactText(message.task.trim() || "Untitled browsing session"),
          startedAt: deps.now(),
          steps: [],
          pages: [],
        };
        await deps.post({
          type: "run_start",
          run: { id: next.runId, task: next.task, startedAt: next.startedAt, meta: { source: "chrome-extension" } },
        });
        await deps.enableRecorder();
        await deps.save(next);
        return reply(next);
      }
      case "stop": {
        if (!session) return reply(undefined);
        await deps.disableRecorder();
        await deps.save(undefined);
        await deps.post({ type: "run_end", runId: session.runId, status: "success", endedAt: deps.now() });
        return { recording: false, steps: session.steps.length };
      }
      case "event": {
        if (!session) return reply(undefined);
        const messages = recordEvent(session, message.event);
        await deps.save(session);
        for (const m of messages) await deps.post(m);
        return reply(session);
      }
      case "status":
        return reply(session);
    }
  } catch (err) {
    return { ...reply(session), error: describe(err) };
  }
}

function reply(session: Session | undefined): StatusReply {
  return session
    ? { recording: true, task: session.task, runId: session.runId, steps: session.steps.length }
    : { recording: false, steps: 0 };
}

/**
 * Build a message handler that processes messages strictly one at a time, so rapid events
 * from a page cannot interleave their load/save of the session.
 * @example const handle = createMessageHandler(deps); chrome.runtime.onMessage.addListener((m, _s, r) => { handle(m).then(r); return true; });
 */
export function createMessageHandler(deps: BackgroundDeps): (message: ExtensionMessage) => Promise<StatusReply> {
  let chain: Promise<unknown> = Promise.resolve();
  return (message) => {
    const run = chain.then(() => handleMessage(message, deps));
    chain = run.catch(() => undefined);
    return run;
  };
}
