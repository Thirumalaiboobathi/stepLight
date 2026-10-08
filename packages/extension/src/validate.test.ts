import { describe, expect, it } from "vitest";
import type { PageEventMsg } from "./messages.js";
import { parseMessage, parsePairingToken, senderAllowed } from "./validate.js";

const ID = "abcdefghijklmnopabcdefghijklmnop";
const click = { kind: "click", url: "https://x.test/", selector: "a#b", text: "Go", timestamp: 1 } as PageEventMsg;

describe("parseMessage drops malformed messages", () => {
  it("accepts well-formed messages", () => {
    expect(parseMessage({ type: "status" })).toEqual({ type: "status" });
    expect(parseMessage({ type: "start", task: "t" })).toEqual({ type: "start", task: "t" });
    expect(parseMessage({ type: "event", event: click })).toEqual({ type: "event", event: click });
  });

  it("rejects everything else", () => {
    const bad: unknown[] = [
      undefined,
      null,
      "start",
      42,
      [],
      {},
      { type: "unknown" },
      { type: "start" },
      { type: "start", task: 5 },
      { type: "start", task: "x".repeat(501) },
      { type: "event" },
      { type: "event", event: null },
      { type: "event", event: { ...click, kind: "eval" } },
      { type: "event", event: { ...click, url: 5 } },
      { type: "event", event: { ...click, timestamp: "now" } },
      { type: "event", event: { ...click, timestamp: Infinity } },
      { type: "event", event: { ...click, selector: "x".repeat(2_000) } },
      { type: "event", event: { kind: "page_read", url: "u", title: "t", text: 1, flags: [], timestamp: 1 } },
      { type: "event", event: { kind: "page_read", url: "u", title: "t", text: "x", flags: [{ type: "a", severity: "boom", message: "", evidence: "" }], timestamp: 1 } },
      { type: "event", event: { kind: "page_read", url: "u", title: "t", text: "x".repeat(2_000_001), flags: [], timestamp: 1 } },
      { type: "event", event: { kind: "form_submit", url: "u", selector: "f", method: "POST", action: "a", body: 5, timestamp: 1 } },
      { type: "pair" },
      { type: "pair", link: 5 },
    ];
    for (const m of bad) expect(parseMessage(m), JSON.stringify(m)?.slice(0, 80)).toBeUndefined();
  });

  it("does not pass unknown properties through", () => {
    const m = parseMessage({ type: "event", event: { ...click, evil: "x", __proto__: { polluted: true } } });
    expect(m).toEqual({ type: "event", event: click });
  });
});

describe("senderAllowed", () => {
  const status = { type: "status" } as const;
  const event = { type: "event", event: click } as const;

  it("rejects other extensions and anything without our id", () => {
    expect(senderAllowed(status, { id: "someone-else" }, ID)).toBe(false);
    expect(senderAllowed(status, {}, ID)).toBe(false);
    expect(senderAllowed(event, { id: "someone-else", tab: {} }, ID)).toBe(false);
    expect(senderAllowed(status, { id: ID }, "")).toBe(false);
  });

  it("popup may send control messages; content scripts may only send events", () => {
    expect(senderAllowed(status, { id: ID, url: `chrome-extension://${ID}/popup.html` }, ID)).toBe(true);
    expect(senderAllowed(event, { id: ID, tab: { id: 1 }, url: "https://page.test/" }, ID)).toBe(true);
    // a content script (in a page the agent reads) cannot start/stop/pair
    expect(senderAllowed({ type: "stop" }, { id: ID, tab: { id: 1 }, url: "https://page.test/" }, ID)).toBe(false);
    expect(senderAllowed({ type: "pair", link: "x" }, { id: ID, tab: { id: 1 }, url: "https://page.test/" }, ID)).toBe(false);
    // an extension page cannot forge page events
    expect(senderAllowed(event, { id: ID, url: `chrome-extension://${ID}/popup.html` }, ID)).toBe(false);
    // the bundled viewer lives in a tab but is still an extension page
    expect(senderAllowed(status, { id: ID, tab: { id: 2 }, url: `chrome-extension://${ID}/viewer.html` }, ID)).toBe(true);
  });
});

describe("parsePairingToken", () => {
  const hex = "0123456789abcdef".repeat(4);
  it("reads the token from the printed link or a bare token", () => {
    expect(parsePairingToken(`http://127.0.0.1:4777/#token=${hex}`)).toBe(hex);
    expect(parsePairingToken(`  ${hex}\n`)).toBe(hex);
  });
  it("rejects junk", () => {
    for (const bad of ["", "hello", "token=zz", "0123", `${hex}!`, `http://x/#token=${hex}/evil`]) {
      expect(parsePairingToken(bad), bad).toBeUndefined();
    }
  });
});
