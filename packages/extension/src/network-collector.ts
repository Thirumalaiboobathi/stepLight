import { pickHeaders, requestBodyText, type RawHeader, type RawRequestBody } from "@steplight/core";
import type { PageEventMsg } from "./messages.js";

/** The parts of `chrome.webRequest` details we read. Headers are never requested, only content-type/length from the response. */
export interface WebRequestDetails {
  requestId: string;
  url: string;
  method: string;
  type: string;
  tabId: number;
  timeStamp: number;
  documentUrl?: string;
  requestBody?: RawRequestBody;
  statusCode?: number;
  responseHeaders?: RawHeader[];
  error?: string;
}

/** A network observation, ready for the recorder. */
export type NetworkEvent = Extract<PageEventMsg, { kind: "network" }>;

/** Resource types that can carry or trigger a transfer worth looking at. */
const OBSERVED = new Set(["xmlhttprequest", "ping", "websocket", "image", "sub_frame", "other", "object", "media", "script", "stylesheet", "font", "webbundle"]);
/** Static resources are only examined when their URL has a query string (query-string exfiltration). */
const STATIC = new Set(["script", "stylesheet", "font", "media", "webbundle"]);
const MAX_PENDING = 500;
const MAX_BODY_CHARS = 20_000;

/**
 * Turns `chrome.webRequest` callbacks into {@link NetworkEvent}s for the tab being recorded.
 * Purely observational: it never blocks or modifies a request, and it never throws into the browser.
 * Request headers are not requested at all; of the response only `content-type` and
 * `content-length` are read (see `pickHeaders`).
 * @example
 * const c = new NetworkCollector(() => session.tabId, (ev) => handle({ type: "event", event: ev }));
 * chrome.webRequest.onBeforeRequest.addListener((d) => c.onBeforeRequest(d), filter, ["requestBody"]);
 */
export class NetworkCollector {
  private readonly pending = new Map<string, NetworkEvent & { startedAt: number }>();

  constructor(
    private readonly recordedTab: () => number | undefined,
    private readonly emit: (event: NetworkEvent) => void,
    private readonly pageUrl: () => string | undefined = () => undefined,
  ) {}

  private build(d: WebRequestDetails): (NetworkEvent & { startedAt: number }) | undefined {
    const tab = this.recordedTab();
    if (tab === undefined || d.tabId !== tab || !OBSERVED.has(d.type)) return undefined;
    if (STATIC.has(d.type) && !d.url.includes("?")) return undefined;
    const body = requestBodyText(d.requestBody, MAX_BODY_CHARS);
    const page = d.documentUrl ?? this.pageUrl();
    return {
      kind: "network",
      url: d.url,
      ...(page ? { pageUrl: page } : {}),
      method: d.method,
      resourceType: d.type,
      ...(body.text ? { bodyText: body.text } : {}),
      ...(body.bytes > 0 ? { bodyBytes: body.bytes } : {}),
      source: "webRequest",
      timestamp: Date.now(),
      startedAt: d.timeStamp,
    };
  }

  /** `webRequest.onBeforeRequest` (with `requestBody`). */
  onBeforeRequest(d: WebRequestDetails): void {
    try {
      const ev = this.build(d);
      if (!ev) return;
      if (d.type === "websocket") {
        // A WebSocket stays open: report the handshake right away.
        this.emit(strip(ev));
        return;
      }
      if (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value as string);
      this.pending.set(d.requestId, ev);
    } catch (err) {
      console.warn("[steplight] network capture:", err);
    }
  }

  /** `webRequest.onCompleted` (with `responseHeaders`). */
  onCompleted(d: WebRequestDetails): void {
    this.finish(d, (ev) => {
      if (d.statusCode !== undefined) ev.status = d.statusCode;
      ev.durationMs = Math.max(0, Math.round(d.timeStamp - ev.startedAt));
      const h = pickHeaders(d.responseHeaders);
      if (h.contentType) ev.contentType = h.contentType;
      if (h.contentLength !== undefined) ev.contentLength = h.contentLength;
    });
  }

  /** `webRequest.onErrorOccurred`. */
  onError(d: WebRequestDetails): void {
    this.finish(d, (ev) => {
      ev.error = (d.error ?? "failed").slice(0, 100);
      ev.durationMs = Math.max(0, Math.round(d.timeStamp - ev.startedAt));
    });
  }

  private finish(d: WebRequestDetails, fill: (ev: NetworkEvent & { startedAt: number }) => void): void {
    try {
      const ev = this.pending.get(d.requestId);
      if (!ev) return;
      this.pending.delete(d.requestId);
      fill(ev);
      this.emit(strip(ev));
    } catch (err) {
      console.warn("[steplight] network capture:", err);
    }
  }
}

function strip(ev: NetworkEvent & { startedAt?: number }): NetworkEvent {
  const copy = { ...ev };
  delete copy.startedAt;
  return copy;
}
