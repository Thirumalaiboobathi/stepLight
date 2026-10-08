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
  | { type: "unpair" };

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
  error?: string;
}

/** Base URL of the local Steplight server that receives steps. */
export const SERVER_URL = "http://localhost:4777";
