import {
  DEFAULT_SETTINGS,
  analyzeStep,
  inferCausedBy,
  newRunId,
  newStepId,
  recordingBlockedReason,
  redactText,
  sanitizeBody,
  sanitizeSnapshot,
  siteOf,
  stripQuery,
  type LocalRunStore,
  type Settings,
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
  /** The browser tab being recorded; network and navigation events from other tabs are ignored. */
  tabId?: number;
  /** URL of the recorded page, used as the origin of its background requests. */
  tabUrl?: string;
  /** How often each request (method + URL) has been recorded, to keep polling out of the timeline. */
  netCounts?: Record<string, number>;
  /** Network steps recorded in this run (capped). */
  netTotal?: number;
  /** Requests already reported by the page hooks, so the browser's own log does not repeat them. */
  deepKeys?: string[];
  /** Page-load beacons waiting for their page to be read, so the "after a hidden instruction" check can see both. */
  heldNet?: Extract<PageEventMsg, { kind: "network" }>[];
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
  /** Current user settings (capture level, deep capture, allowlists). Defaults when omitted. */
  settings?(): Promise<Settings>;
  /** The tab to record (the active tab at start). */
  activeTab?(): Promise<{ id?: number; url?: string } | undefined>;
  /** CLI session token store (optional; tests that do not pair can omit it). */
  getToken?(): Promise<string | undefined>;
  setToken?(token: string | undefined): Promise<void>;
}

const MAX_PAGES = 5;
const MAX_PAGE_TEXT = 20_000;
/** Most network steps kept per run, and per identical request; flagged requests are always kept. */
export const MAX_NETWORK_STEPS = 500;
export const MAX_SAME_REQUEST = 3;
/** Resource types that are always worth a timeline entry. Others only when third-party or flagged. */
const ALWAYS_TYPES = new Set(["xmlhttprequest", "ping", "websocket", "beacon", "fetch"]);
const THIRD_PARTY_TYPES = new Set(["image", "sub_frame", "other", "object", "media"]);
/** Beacon-like requests are held briefly until the page they came from has been read. */
const HOLD_TYPES = new Set(["ping", "image", "websocket"]);
const HOLD_MS = 4_000;
const MAX_HELD = 40;

const withoutHash = (url: string | undefined): string | undefined => url?.split("#")[0];

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
    case "network": {
      const request: NonNullable<Step["request"]> = {
        method: event.method,
        url: event.url,
        resourceType: event.resourceType,
        source: event.source,
        ...(event.bodyText !== undefined ? { bodyPreview: event.bodyText } : {}),
        ...(event.status !== undefined ? { status: event.status } : {}),
        ...(event.bodyBytes !== undefined ? { bodyBytes: event.bodyBytes } : {}),
        ...(event.contentType !== undefined ? { contentType: event.contentType } : {}),
        ...(event.contentLength !== undefined ? { contentLength: event.contentLength } : {}),
        ...(event.error !== undefined ? { error: event.error } : {}),
      };
      return {
        step: base("network_request", {
          url: event.pageUrl ?? session.tabUrl ?? session.lastNavUrl,
          request,
          ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
        }),
      };
    }
    case "navigate":
      return { step: base("navigate", { url: event.url, targetText: event.via === "history" ? "client-side route change" : "#fragment change" }) };
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

/** Result of {@link recordEvent}. */
export interface RecordResult {
  messages: IngestMessage[];
  /** Why the event was not recorded (site rules), if so. */
  blocked?: string;
}

function networkKey(event: Extract<PageEventMsg, { kind: "network" }>): string {
  return `${event.method.toUpperCase()} ${event.url}`;
}

/** Shape a step for storage according to the capture level (data minimisation). */
function shapeForLevel(step: Step, snapshot: string | undefined, settings: Settings): { step: Step; snapshot?: string } {
  const out: Step = { ...step };
  if (settings.captureLevel === "minimal") {
    if (out.url) out.url = stripQuery(out.url);
    delete out.targetText;
    delete out.diagnosis;
    delete out.error;
    if (out.request) out.request = { method: out.request.method, url: stripQuery(out.request.url) };
    return { step: out };
  }
  if (out.request) {
    const req = { ...out.request };
    if (settings.captureLevel === "full" && req.bodyPreview !== undefined) req.bodyPreview = sanitizeBody(req.bodyPreview);
    else delete req.bodyPreview; // "standard": the body was analysed in memory and is not kept
    out.request = req;
  }
  return { step: out, ...(snapshot !== undefined ? { snapshot: sanitizeSnapshot(snapshot) } : {}) };
}

/**
 * Turn a content-script (or browser network) event into zero or more ingest messages, updating
 * the session. Detectors run on the raw data in memory; what is stored depends on the capture
 * level and is redacted before it leaves this function. Anything that fails to redact is dropped.
 * @example const { messages } = recordEvent(session, event, settings)
 */
export function recordEvent(
  session: Session,
  event: PageEventMsg,
  settings: Settings = DEFAULT_SETTINGS,
  forceNetwork = false,
): RecordResult {
  const out: IngestMessage[] = [];
  const pageUrl = event.kind === "network" ? (event.pageUrl ?? session.tabUrl ?? session.lastNavUrl) : event.url;
  const blocked = recordingBlockedReason(pageUrl, settings);
  if (blocked) return { messages: [], blocked };

  const emit = (built: { step: Step; snapshot?: string }): void => {
    const { step } = built;
    step.flags.push(
      ...analyzeStep(step, session.steps, session.pages, { allowlist: settings.networkAllowlist }),
    );
    const cause = inferCausedBy(step, session.steps);
    if (cause) step.causedBy = cause;
    // The in-memory history keeps the shaped step (no bodies), like the stored copy.
    const shaped = shapeForLevel(step, built.snapshot, settings);
    session.steps.push(shaped.step);
    out.push({
      type: "step",
      runId: session.runId,
      step: shaped.step,
      ...(shaped.snapshot !== undefined ? { snapshot: shaped.snapshot } : {}),
    });
  };

  const handleNetwork = (ev: Extract<PageEventMsg, { kind: "network" }>, force: boolean): void => {
    const key = networkKey(ev);
    if (ev.source === "webRequest") {
      const deep = session.deepKeys ?? [];
      const at = deep.indexOf(key);
      if (at >= 0) {
        // The page hooks already reported this request (with its payload): do not repeat it.
        deep.splice(at, 1);
        session.deepKeys = deep;
        return;
      }
    } else if (!force) {
      session.deepKeys = [...(session.deepKeys ?? []), key].slice(-50);
    }
    const built = stepFromEvent(session, ev);
    const target = siteOf(ev.url);
    const third = target !== undefined && siteOf(built.step.url) !== target;
    const page = withoutHash(built.step.url);
    if (!force && third && HOLD_TYPES.has(ev.resourceType) && !session.steps.some((s) => s.kind === "page_read" && withoutHash(s.url) === page)) {
      (session.heldNet ??= []).push(ev);
      if (session.heldNet.length > MAX_HELD) session.heldNet.shift();
      return;
    }
    const flags = analyzeStep(built.step, session.steps, session.pages, { allowlist: settings.networkAllowlist });
    const interesting = ALWAYS_TYPES.has(ev.resourceType) || (third && THIRD_PARTY_TYPES.has(ev.resourceType));
    const counts = (session.netCounts ??= {});
    counts[key] = (counts[key] ?? 0) + 1;
    const repeated = counts[key]! > MAX_SAME_REQUEST;
    const over = (session.netTotal ?? 0) >= MAX_NETWORK_STEPS;
    if (flags.length === 0 && (!interesting || repeated || over)) return;
    session.netTotal = (session.netTotal ?? 0) + 1;
    emit(built);
  };
  /** Process held beacons: those of `pageUrl` (its page was just read) and any that waited too long. */
  const releaseHeld = (pageUrl?: string): void => {
    const held = session.heldNet ?? [];
    if (held.length === 0) return;
    session.heldNet = [];
    for (const h of held) {
      const stale = event.timestamp - h.timestamp > HOLD_MS;
      if (stale || (pageUrl !== undefined && withoutHash(h.pageUrl ?? session.tabUrl) === withoutHash(pageUrl))) handleNetwork(h, true);
      else (session.heldNet ??= []).push(h);
    }
  };

  if (event.kind === "network") {
    handleNetwork(event, forceNetwork);
    releaseHeld();
    return { messages: out };
  }

  if (event.kind === "navigate") {
    if (event.url === session.lastNavUrl) return { messages: [] };
    session.lastNavUrl = event.url;
    session.tabUrl = event.url;
    emit(stepFromEvent(session, event));
    return { messages: out };
  }

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
    session.tabUrl = event.url;
    session.pages.push({ url: event.url, text: event.text.slice(0, MAX_PAGE_TEXT) });
    if (session.pages.length > MAX_PAGES) session.pages.shift();
  }
  emit(stepFromEvent(session, event));
  if (event.kind === "page_read") releaseHeld(event.url);
  else releaseHeld();
  return { messages: out };
}

/** Process every held beacon now (used when recording stops). */
export function flushHeld(session: Session, settings: Settings = DEFAULT_SETTINGS): IngestMessage[] {
  const held = session.heldNet ?? [];
  if (held.length === 0) return [];
  session.heldNet = [];
  const out: IngestMessage[] = [];
  for (const ev of held) {
    out.push(...recordEvent(session, ev, settings, true).messages);
  }
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
        const tab = await deps.activeTab?.();
        if (tab?.id !== undefined) next.tabId = tab.id;
        if (tab?.url) next.tabUrl = tab.url;
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
        const leftovers = flushHeld(session, await settingsOf(deps));
        if (leftovers.length > 0) {
          if (session.mode === "standalone") await storeLocally(session.runId, leftovers, deps);
          else for (const m of leftovers) await deps.post(m).catch(() => undefined);
        }
        if (session.mode === "standalone") {
          await deps.local.finishRun(session.runId, "success", endedAt);
        } else {
          await deps.post({ type: "run_end", runId: session.runId, status: "success", endedAt }).catch(() => undefined);
        }
        return { recording: false, steps: session.steps.length, mode: session.mode };
      }
      case "event": {
        if (!session) return reply(undefined, await mode(deps));
        const { messages } = recordEvent(session, message.event, await settingsOf(deps));
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

async function settingsOf(deps: BackgroundDeps): Promise<Settings> {
  return (await deps.settings?.()) ?? DEFAULT_SETTINGS;
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
