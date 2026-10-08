import type { Flag, PageTokens } from "@steplight/core";
import type { ExtensionMessage, PageEventMsg } from "./messages.js";

/** Longest page text the service worker accepts from a content script. */
const MAX_TEXT = 2_000_000;
const SEVERITIES = new Set(["low", "medium", "high", "critical"]);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function validFlags(v: unknown): boolean {
  return (
    Array.isArray(v) &&
    v.length <= 100 &&
    v.every(
      (f) =>
        isObj(f) &&
        str(f["type"], 40) &&
        typeof f["severity"] === "string" &&
        SEVERITIES.has(f["severity"]) &&
        str(f["message"], 2_000) &&
        str(f["evidence"], 2_000),
    )
  );
}

function validTokens(v: unknown): boolean {
  return (
    isObj(v) &&
    ["total", "visibleChars", "hiddenChars", "boilerplateChars", "boilerplateShare"].every((k) => num(v[k])) &&
    v["estimated"] === true
  );
}

/** Validate a page event coming from a content script. Returns a clean copy, or undefined. */
export function parsePageEvent(raw: unknown): PageEventMsg | undefined {
  if (!isObj(raw) || !num(raw["timestamp"]) || !str(raw["url"], 4_000)) return undefined;
  const base = { url: raw["url"], timestamp: raw["timestamp"] };
  switch (raw["kind"]) {
    case "page_read":
      if (!str(raw["title"], 2_000) || !str(raw["text"], MAX_TEXT) || !validFlags(raw["flags"])) return undefined;
      if (raw["tokens"] !== undefined && !validTokens(raw["tokens"])) return undefined;
      return {
        kind: "page_read",
        ...base,
        title: raw["title"],
        text: raw["text"],
        flags: raw["flags"] as Flag[],
        ...(raw["tokens"] ? { tokens: raw["tokens"] as PageTokens } : {}),
      };
    case "click":
    case "type":
      if (!str(raw["selector"], 1_000) || !str(raw["text"], 2_000)) return undefined;
      return { kind: raw["kind"], ...base, selector: raw["selector"], text: raw["text"] };
    case "network": {
      const optNum = (k: string): boolean => raw[k] === undefined || num(raw[k]);
      const optStr = (k: string, max: number): boolean => raw[k] === undefined || str(raw[k], max);
      if (
        !str(raw["method"], 16) ||
        !str(raw["resourceType"], 32) ||
        !(raw["source"] === "webRequest" || raw["source"] === "deep") ||
        !optStr("pageUrl", 4_000) ||
        !optStr("bodyText", 100_000) ||
        !optStr("contentType", 100) ||
        !optStr("error", 200) ||
        !optNum("status") ||
        !optNum("durationMs") ||
        !optNum("bodyBytes") ||
        !optNum("contentLength")
      ) {
        return undefined;
      }
      const copy = <K extends string>(k: K): Record<string, unknown> => (raw[k] === undefined ? {} : { [k]: raw[k] });
      return {
        kind: "network",
        ...base,
        method: raw["method"],
        resourceType: raw["resourceType"],
        source: raw["source"],
        ...copy("pageUrl"),
        ...copy("status"),
        ...copy("durationMs"),
        ...copy("bodyText"),
        ...copy("bodyBytes"),
        ...copy("contentType"),
        ...copy("contentLength"),
        ...copy("error"),
      } as PageEventMsg;
    }
    case "navigate":
      if (raw["via"] !== "history" && raw["via"] !== "fragment") return undefined;
      return { kind: "navigate", ...base, via: raw["via"] };
    case "form_submit":
      if (
        !str(raw["selector"], 1_000) ||
        !str(raw["method"], 16) ||
        !str(raw["action"], 4_000) ||
        !str(raw["body"], 200_000)
      ) {
        return undefined;
      }
      return {
        kind: "form_submit",
        ...base,
        selector: raw["selector"],
        method: raw["method"],
        action: raw["action"],
        body: raw["body"],
      };
    default:
      return undefined;
  }
}

/** Accepts the pairing link printed by the CLI (`…#token=<hex>`) or the bare token. */
export function parsePairingToken(input: string): string | undefined {
  const text = input.trim();
  const match = /(?:[#&?]token=)?([0-9a-f]{32,128})$/i.exec(text);
  return match ? match[1]!.toLowerCase() : undefined;
}

/**
 * Parse an untrusted runtime message. Anything malformed (wrong type, wrong shape, oversized)
 * is dropped by returning undefined.
 * @example parseMessage({ type: "stop" }) // { type: "stop" }
 */
export function parseMessage(raw: unknown): ExtensionMessage | undefined {
  if (!isObj(raw)) return undefined;
  switch (raw["type"]) {
    case "status":
    case "stop":
    case "unpair":
    case "delete_all":
      return { type: raw["type"] };
    case "start":
      return str(raw["task"], 500) ? { type: "start", task: raw["task"] } : undefined;
    case "pair": {
      if (!str(raw["link"], 500)) return undefined;
      return { type: "pair", link: raw["link"] };
    }
    case "event": {
      const event = parsePageEvent(raw["event"]);
      return event ? { type: "event", event } : undefined;
    }
    default:
      return undefined;
  }
}

/** The slice of `chrome.runtime.MessageSender` we check. */
export interface SenderInfo {
  id?: string;
  tab?: unknown;
  frameId?: number;
  url?: string;
}

/**
 * Decide whether a message may be handled, given who sent it.
 * - Only this extension's own contexts (`sender.id === runtimeId`); web pages and other extensions never qualify.
 * - Page events must come from a content script (it has a tab); control messages (start, stop,
 *   pair…) must come from an extension page (popup or viewer), never from a content script that
 *   runs inside a page the agent is reading.
 */
export function senderAllowed(message: ExtensionMessage, sender: SenderInfo, runtimeId: string): boolean {
  if (!runtimeId || sender.id !== runtimeId) return false;
  const fromContentScript = sender.tab !== undefined && !sender.url?.startsWith("chrome-extension://");
  return message.type === "event" ? fromContentScript : !fromContentScript;
}
