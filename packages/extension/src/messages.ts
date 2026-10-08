import type { Flag, PageTokens } from "@steplight/core";

/** An observation reported by the content script. */
export type PageEventMsg =
  | {
      kind: "page_read";
      url: string;
      title: string;
      text: string;
      flags: Flag[];
      /** Token cost estimate of the page. */
      tokens?: PageTokens;
      timestamp: number;
    }
  | { kind: "click"; url: string; selector: string; text: string; timestamp: number }
  | { kind: "type"; url: string; selector: string; text: string; timestamp: number }
  | {
      /** A background request (fetch, XHR, beacon, pixel, WebSocket) seen by the browser or the opt-in page hooks. */
      kind: "network";
      /** Request URL. */
      url: string;
      /** URL of the page that made the request, when known. */
      pageUrl?: string;
      method: string;
      /** webRequest resource type: xmlhttprequest, ping, websocket, image, sub_frame, … */
      resourceType: string;
      status?: number;
      /** Time from request start to completion, in ms. */
      durationMs?: number;
      /** Request body text for analysis in the service worker; kept on disk only at the "full" capture level. */
      bodyText?: string;
      bodyBytes?: number;
      contentType?: string;
      contentLength?: number;
      error?: string;
      source: "webRequest" | "deep";
      timestamp: number;
    }
  | {
      /** A client-side (SPA) route change: history.pushState / replaceState or a #fragment change. */
      kind: "navigate";
      url: string;
      via: "history" | "fragment";
      timestamp: number;
    }
  | {
      kind: "form_submit";
      url: string;
      selector: string;
      method: string;
      action: string;
      body: string;
      timestamp: number;
    };

/** Messages the service worker understands. */
export type ExtensionMessage =
  | { type: "event"; event: PageEventMsg }
  | { type: "start"; task: string }
  | { type: "stop" }
  | { type: "status" }
  /** Store the CLI session token from the pairing link printed by `steplight view`. */
  | { type: "pair"; link: string }
  | { type: "unpair" }
  /** Delete every stored run, the pairing token and any recording in progress. */
  | { type: "delete_all" }
  /** An extension page reports something it did that belongs in the audit log (export / import). */
  | { type: "audit"; action: "export" | "import"; detail?: Record<string, string | number | boolean> };

/** Where recorded steps go. */
export type ConnectionMode = "standalone" | "connected";

/** Reply to popup requests. */
export interface StatusReply {
  recording: boolean;
  task?: string;
  runId?: string;
  steps: number;
  /** "connected" = sending to the CLI server, "standalone" = storing in the extension. */
  mode: ConnectionMode;
  /** True when a CLI session token is stored (connected mode needs it). */
  paired?: boolean;
  /** Why recording is paused on the current tab (site rules), if it is. */
  paused?: string;
  /** True when an organisation policy is in force. */
  managed?: boolean;
  /** Capture level in effect. */
  captureLevel?: "minimal" | "standard" | "full";
  error?: string;
}

/** Base URL of the local Steplight server that receives steps. */
export const SERVER_URL = "http://localhost:4777";
