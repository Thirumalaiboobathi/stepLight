import type { Flag } from "@steplight/core";

/** An observation reported by the content script. */
export type PageEventMsg =
  | { kind: "page_read"; url: string; title: string; text: string; flags: Flag[]; timestamp: number }
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
  | { type: "status" };

/** Reply to popup requests. */
export interface StatusReply {
  recording: boolean;
  task?: string;
  runId?: string;
  steps: number;
  error?: string;
}

/** Base URL of the local Steplight server that receives steps. */
export const SERVER_URL = "http://localhost:4777";
