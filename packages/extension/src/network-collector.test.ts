import { DEFAULT_SETTINGS, LocalRunStore, type KeyValueStore } from "@steplight/core";
import { describe, expect, it } from "vitest";
import { createMessageHandler, flushHeld, recordEvent, type BackgroundDeps, type Session } from "./background-logic.js";
import type { IngestMessage } from "./ingest-types.js";
import { NetworkCollector, type NetworkEvent, type WebRequestDetails } from "./network-collector.js";

const details = (over: Partial<WebRequestDetails> = {}): WebRequestDetails => ({
  requestId: "1",
  url: "https://api.shop.test/cart",
  method: "GET",
  type: "xmlhttprequest",
  tabId: 7,
  timeStamp: 1000,
  documentUrl: "https://shop.test/",
  ...over,
});

function collect(tab: number | null = 7): { events: NetworkEvent[]; c: NetworkCollector } {
  const events: NetworkEvent[] = [];
  return { events, c: new NetworkCollector(() => tab ?? undefined, (e) => events.push(e)) };
}

describe("NetworkCollector", () => {
  it("combines the request, its body and the response into one event", () => {
    const { c, events } = collect();
    const bytes = new TextEncoder().encode('{"a":1}').buffer;
    c.onBeforeRequest(details({ method: "POST", requestBody: { raw: [{ bytes }] } }));
    expect(events).toHaveLength(0); // waits for the response
    c.onCompleted(
      details({
        timeStamp: 1042,
        statusCode: 200,
        responseHeaders: [
          { name: "Content-Type", value: "application/json; charset=utf-8" },
          { name: "Content-Length", value: "12" },
          { name: "Set-Cookie", value: "sid=SECRET" },
          { name: "Authorization", value: "Bearer SECRET" },
          { name: "X-Api-Key", value: "SECRET" },
        ],
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "network",
      method: "POST",
      url: "https://api.shop.test/cart",
      pageUrl: "https://shop.test/",
      resourceType: "xmlhttprequest",
      status: 200,
      durationMs: 42,
      bodyText: '{"a":1}',
      bodyBytes: 7,
      contentType: "application/json",
      contentLength: 12,
      source: "webRequest",
    });
    expect(JSON.stringify(events)).not.toContain("SECRET"); // headers other than the allowlist never get in
  });

  it("ignores other tabs, main-frame navigations and static files without a query", () => {
    const { c, events } = collect();
    for (const d of [
      details({ tabId: 8 }),
      details({ type: "main_frame" }),
      details({ type: "script", url: "https://cdn.test/app.js" }),
      details({ type: "stylesheet", url: "https://cdn.test/app.css" }),
    ]) {
      c.onBeforeRequest(d);
      c.onCompleted(d);
    }
    expect(events).toEqual([]);
    const none = collect(null);
    none.c.onBeforeRequest(details());
    none.c.onCompleted(details());
    expect(none.events).toEqual([]);
  });

  it("looks at static files that carry a query string (script / css exfiltration)", () => {
    const { c, events } = collect();
    const d = details({ type: "script", url: "https://evil.test/x.js?d=abc" });
    c.onBeforeRequest(d);
    c.onCompleted({ ...d, statusCode: 200 });
    expect(events).toHaveLength(1);
  });

  it("reports WebSocket handshakes immediately and failed requests with their error", () => {
    const { c, events } = collect();
    c.onBeforeRequest(details({ type: "websocket", url: "wss://rt.evil.test/s", requestId: "ws" }));
    expect(events).toHaveLength(1);
    expect(events[0]!.resourceType).toBe("websocket");
    c.onBeforeRequest(details({ requestId: "2" }));
    c.onError(details({ requestId: "2", error: "net::ERR_BLOCKED_BY_CLIENT" }));
    expect(events[1]).toMatchObject({ error: "net::ERR_BLOCKED_BY_CLIENT" });
  });

  it("never throws into the browser, whatever it is given", () => {
    const { c } = collect();
    expect(() => c.onBeforeRequest(null as never)).not.toThrow();
    expect(() => c.onCompleted(undefined as never)).not.toThrow();
    expect(() => c.onError({ requestId: "x" } as never)).not.toThrow();
    const throwing = new NetworkCollector(() => 7, () => {
      throw new Error("boom");
    });
    throwing.onBeforeRequest(details({ type: "websocket" }));
    throwing.onBeforeRequest(details());
    expect(() => throwing.onCompleted(details())).not.toThrow();
  });

  it("does not keep unbounded pending requests", () => {
    const { c } = collect();
    for (let i = 0; i < 2000; i++) c.onBeforeRequest(details({ requestId: String(i) }));
    expect(() => c.onCompleted(details({ requestId: "1999" }))).not.toThrow();
  });
});

/* ---------- recording policy ---------- */

const newSession = (): Session => ({ runId: "r", task: "t", startedAt: 0, steps: [], pages: [], mode: "connected", tabId: 7, tabUrl: "https://shop.test/" });
const net = (over: Partial<NetworkEvent> = {}): NetworkEvent => ({
  kind: "network",
  url: "https://api.shop.test/cart",
  pageUrl: "https://shop.test/",
  method: "GET",
  resourceType: "xmlhttprequest",
  source: "webRequest",
  timestamp: 1000,
  ...over,
});

describe("which requests become steps", () => {
  it("records fetch/XHR, but only third-party images; drops repeats beyond three and caps the run", () => {
    const s = newSession();
    recordEvent(s, { kind: "page_read", url: "https://shop.test/", title: "t", text: "x", flags: [], timestamp: 900 });
    expect(recordEvent(s, net()).messages).toHaveLength(1);
    expect(recordEvent(s, net({ resourceType: "image", url: "https://shop.test/logo.png" })).messages).toHaveLength(0);
    expect(recordEvent(s, net({ resourceType: "image", url: "https://img.other.test/p.gif" })).messages).toHaveLength(1);
    for (let i = 0; i < 6; i++) recordEvent(s, net({ url: "https://api.shop.test/poll" }));
    expect(s.steps.filter((x) => x.request?.url.endsWith("/poll"))).toHaveLength(3);
  });

  it("keeps a flagged request even after the cap", () => {
    const s = newSession();
    s.netTotal = 500;
    expect(recordEvent(s, net({ url: "https://api.shop.test/x" })).messages).toHaveLength(0);
    const leak = recordEvent(s, net({ url: "https://evil.test/c?e=jane%40example.com", method: "GET" }));
    expect(leak.messages).toHaveLength(1);
    expect((leak.messages[0] as Extract<IngestMessage, { type: "step" }>).step.flags[0]?.severity).toBe("critical");
  });

  it("holds a page-load beacon until its page is read, then flags it against the hidden instruction", () => {
    const s = newSession();
    const beacon = recordEvent(s, net({ resourceType: "ping", url: "https://pixel.evil.test/pv", method: "POST", timestamp: 1000 }));
    expect(beacon.messages).toHaveLength(0);
    expect(s.heldNet).toHaveLength(1);
    const read = recordEvent(s, {
      kind: "page_read",
      url: "https://shop.test/",
      title: "t",
      text: "x",
      flags: [{ type: "hidden_instruction", severity: "high", message: "m", evidence: "e" }],
      timestamp: 1100,
    });
    const steps = read.messages.map((m) => (m as Extract<IngestMessage, { type: "step" }>).step);
    expect(steps.map((x) => x.kind)).toEqual(["navigate", "page_read", "network_request"]);
    expect(steps[2]!.flags.map((f) => `${f.type}:${f.severity}`)).toContain("cross_domain_data:high");
    expect(s.heldNet).toEqual([]);
  });

  it("flushes held beacons on stop and releases stale ones", () => {
    const s = newSession();
    recordEvent(s, net({ resourceType: "ping", url: "https://pixel.evil.test/pv", timestamp: 1000 }));
    expect(flushHeld(s)).toHaveLength(1);
    expect(flushHeld(s)).toEqual([]);
    const t = newSession();
    recordEvent(t, net({ resourceType: "ping", url: "https://pixel.evil.test/pv", timestamp: 1000 }));
    const later = recordEvent(t, net({ url: "https://api.shop.test/other", timestamp: 9000 }));
    expect(later.messages.length).toBe(2); // the stale beacon and the new request
  });

  it("respects the site deny list: nothing from a denied page is recorded", () => {
    const s = newSession();
    const out = recordEvent(s, net(), { ...DEFAULT_SETTINGS, siteDenylist: ["shop.test"] });
    expect(out.messages).toEqual([]);
    expect(out.blocked).toContain("paused");
  });
});

/* ---------- performance ---------- */

function memoryKv(): KeyValueStore {
  const data = new Map<string, unknown>();
  return {
    async get(keys) {
      const list = keys === null ? [...data.keys()] : Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((k) => data.has(k)).map((k) => [k, data.get(k)]));
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) data.set(k, v);
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
    },
  };
}

describe("performance", () => {
  it("capture adds well under 5 ms per request on average (webRequest event → stored step)", async () => {
    let session: Session | undefined = newSession();
    const deps: BackgroundDeps = {
      load: async () => session,
      save: async (s) => void (session = s),
      post: async () => undefined,
      probe: async () => false,
      local: new LocalRunStore(memoryKv()),
      enableRecorder: async () => undefined,
      disableRecorder: async () => undefined,
      now: () => 1000,
    };
    session.mode = "standalone";
    await deps.local.startRun({ id: "r", task: "t", startedAt: 0, meta: {} });
    const handle = createMessageHandler(deps);
    const collector = new NetworkCollector(() => 7, (event) => void handle({ type: "event", event }));
    const body = new TextEncoder().encode(JSON.stringify({ q: "x".repeat(2000), items: Array.from({ length: 50 }, (_, i) => `item ${i}`) })).buffer;
    const N = 1500;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      const d = details({ requestId: String(i), url: `https://api.shop.test/items/${i % 400}?page=${i}`, method: "POST", requestBody: { raw: [{ bytes: body }] } });
      collector.onBeforeRequest(d);
      collector.onCompleted({ ...d, statusCode: 200, timeStamp: 1010 });
    }
    await handle({ type: "status" }); // wait for the queue to drain
    const perRequest = (performance.now() - t0) / N;
    expect(session!.steps.length).toBeGreaterThan(100);
    expect(perRequest).toBeLessThan(5);
  }, 60_000);
});
