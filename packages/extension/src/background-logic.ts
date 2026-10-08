import {
  analyzeStep,
  inferCausedBy,
  newRunId,
  newStepId,
  redactText,
  sanitizeBody,
  sanitizeSnapshot,
  type LocalRunStore,
  type Step,
  type StepKind,
} from "@steplight/core";
import type { IngestMessage } from "./ingest-types.js";
import { parsePairingToken } from "./validate.js";
import type { ConnectionMode, ExtensionMessage, PageEventMsg, StatusReply } from "./messages.js";

/** Recording state kept in extension storage so it survives service-worker restarts. */
export interface Session {
  runId: string;
  task: string;
  startedAt: number;
  steps: Step[];
  /** Recent page texts used by the cross-domain detector (kept small). */
  pages: { url?: string; text: string }[];
  lastNavUrl?: string;
  /** Where steps go: the CLI server, or the extension's own storage. */
  mode: ConnectionMode;
}

/** Everything the service worker needs from the outside world (injected for testing). */
export interface BackgroundDeps {
  load(): Promise<Session | undefined>;
  save(session: Session | undefined): Promise<void>;
  /** Deliver a message to the local Steplight server. May reject (server not running). */
  post(message: IngestMessage): Promise<void>;
  /** True when the local Steplight server answers. Never rejects. */
  probe(): Promise<boolean>;
  /** Extension-local run storage used in standalone mode. */
  local: LocalRunStore;
  /** Make the content script run on all pages (after permission is granted). */
  enableRecorder(): Promise<void>;
  disableRecorder(): Promise<void>;
  now(): number;
  /** CLI session token store (optional; tests that do not pair can omit it). */
  getToken?(): Promise<string | undefined>;
  setToken?(token: string | undefined): Promise<void>;
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
        step: base("page_read", {
          url: event.url,
          targetText: event.title,
          flags: [...event.flags],
          ...(event.tokens ? { tokens: event.tokens } : {}),
        }),
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
          mode: "connected",
        };
        const meta = { source: "chrome-extension" };
        try {
          await deps.post({
            type: "run_start",
            run: { id: next.runId, task: next.task, startedAt: next.startedAt, meta },
          });
        } catch {
          next.mode = "standalone"; // CLI server not running: keep the run in the extension
          await deps.local.startRun({ id: next.runId, task: next.task, startedAt: next.startedAt, meta });
        }
        await deps.enableRecorder();
        await deps.save(next);
        return reply(next);
      }
      case "stop": {
        if (!session) return reply(undefined, await mode(deps));
        await deps.disableRecorder();
        await deps.save(undefined);
        const endedAt = deps.now();
        if (session.mode === "standalone") {
          await deps.local.finishRun(session.runId, "success", endedAt);
        } else {
          await deps.post({ type: "run_end", runId: session.runId, status: "success", endedAt }).catch(() => undefined);
        }
        return { recording: false, steps: session.steps.length, mode: session.mode };
      }
      case "event": {
        if (!session) return reply(undefined, await mode(deps));
        const messages = recordEvent(session, message.event);
        if (session.mode === "connected") {
          try {
            for (const m of messages) await deps.post(m);
          } catch {
            await fallBackToLocal(session, messages, deps);
          }
        } else {
          await storeLocally(session.runId, messages, deps);
        }
        await deps.save(session);
        return reply(session);
      }
      case "status":
        return reply(session, session ? undefined : await mode(deps), deps.getToken ? await paired(deps) : undefined);
      case "pair": {
        const token = parsePairingToken(message.link);
        if (!token) return { ...reply(session), error: "That does not look like a Steplight pairing link." };
        await deps.setToken?.(token);
        if (!session && !(await deps.probe())) {
          await deps.setToken?.(undefined);
          return { ...reply(session), error: "Could not reach the CLI with that token (is `steplight view` running? is the link current?)." };
        }
        return reply(session, session ? undefined : "connected", true);
      }
      case "unpair":
        await deps.setToken?.(undefined);
        return reply(session, session ? undefined : "standalone", false);
    }
  } catch (err) {
    return { ...reply(session), error: describe(err) };
  }
}

async function paired(deps: BackgroundDeps): Promise<boolean> {
  return (await deps.getToken?.()) !== undefined;
}

async function mode(deps: BackgroundDeps): Promise<ConnectionMode> {
  return (await deps.probe()) ? "connected" : "standalone";
}

async function storeLocally(runId: string, messages: IngestMessage[], deps: BackgroundDeps): Promise<void> {
  for (const m of messages) {
    if (m.type === "step") await deps.local.addStep(runId, m.step, m.snapshot);
  }
}

/** The server disappeared mid-run: continue in extension storage, keeping steps seen so far. */
async function fallBackToLocal(session: Session, pending: IngestMessage[], deps: BackgroundDeps): Promise<void> {
  session.mode = "standalone";
  await deps.local.startRun({
    id: session.runId,
    task: session.task,
    startedAt: session.startedAt,
    meta: { source: "chrome-extension", note: "server connection lost; earlier snapshots not kept" },
  });
  const pendingIds = new Set(pending.flatMap((m) => (m.type === "step" ? [m.step.id] : [])));
  for (const step of session.steps) {
    if (!pendingIds.has(step.id)) await deps.local.addStep(session.runId, step);
  }
  await storeLocally(session.runId, pending, deps);
}

function reply(session: Session | undefined, idleMode: ConnectionMode = "standalone", paired?: boolean): StatusReply {
  const extra = paired === undefined ? {} : { paired };
  return session
    ? { recording: true, task: session.task, runId: session.runId, steps: session.steps.length, mode: session.mode, ...extra }
    : { recording: false, steps: 0, mode: idleMode, ...extra };
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
