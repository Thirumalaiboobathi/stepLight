import { describe, expect, it } from "vitest";
import { analyzeStep } from "./analyze.js";
import { isBenignDomain, networkExfil, pickHeaders, requestBodyText, stripQuery } from "./network.js";
import type { Flag, Step } from "./types.js";

const PAGE = "https://shop.test/product";
let n = 0;
const net = (url: string, extra: Partial<Step> = {}, req: Partial<NonNullable<Step["request"]>> = {}): Step => ({
  id: `n${n++}`,
  runId: "r",
  index: n,
  kind: "network_request",
  timestamp: 10_000,
  url: PAGE,
  flags: [],
  request: { method: "GET", url, resourceType: "xmlhttprequest", ...req },
  ...extra,
});
const hiddenRead = (ts: number, severity: Flag["severity"] = "high"): Step => ({
  id: "pr",
  runId: "r",
  index: 0,
  kind: "page_read",
  timestamp: ts,
  url: PAGE,
  flags: [{ type: "hidden_instruction", severity, message: "m", evidence: "e" }],
});
const pageText = [{ url: PAGE, text: "Customer: Jane Q. Traveler, member code LAMP-7731-XQ, ships to 12 Hill Road" }];

describe("pickHeaders", () => {
  it("keeps only content-type and content-length", () => {
    const out = pickHeaders([
      { name: "Content-Type", value: "Text/HTML; charset=utf-8" },
      { name: "Content-Length", value: "1234" },
      { name: "Set-Cookie", value: "sid=abc" },
      { name: "Authorization", value: "Bearer abc" },
      { name: "X-API-Key", value: "k" },
      { name: "X-Auth-Token", value: "t" },
      { name: "X-Session-Id", value: "s" },
      { name: "Cookie", value: "a=b" },
      { name: "Server", value: "nginx" },
    ]);
    expect(out).toEqual({ contentType: "text/html", contentLength: 1234 });
  });
  it("ignores missing values, junk lengths and undefined input", () => {
    expect(pickHeaders(undefined)).toEqual({});
    expect(pickHeaders([{ name: "content-length", value: "abc" }, { name: "content-type" }])).toEqual({});
  });
});

describe("requestBodyText", () => {
  it("serialises form data and decodes raw bytes, reporting the real size", () => {
    expect(requestBodyText({ formData: { email: ["a@b.co"], x: ["1", "2"] } }).text).toBe("email=a%40b.co&x=1&x=2");
    const bytes = new TextEncoder().encode('{"q":"hello"}').buffer;
    expect(requestBodyText({ raw: [{ bytes }] })).toEqual({ text: '{"q":"hello"}', bytes: 13 });
    expect(requestBodyText(undefined)).toEqual({ bytes: 0 });
    expect(requestBodyText({ error: "x" })).toEqual({ bytes: 0 });
    expect(requestBodyText({ raw: [{ file: "/etc/passwd" }] })).toEqual({ bytes: 0 });
  });
  it("truncates long bodies", () => {
    const bytes = new TextEncoder().encode("x".repeat(100_000)).buffer;
    const out = requestBodyText({ raw: [{ bytes }] }, 1000);
    expect(out.text).toHaveLength(1000);
    expect(out.bytes).toBe(100_000);
  });
});

describe("stripQuery / isBenignDomain", () => {
  it("drops query and fragment", () => {
    expect(stripQuery("https://a.test/x/y?token=abc#frag")).toBe("https://a.test/x/y");
    expect(stripQuery("not a url?x=1")).toBe("not a url");
  });
  it("knows analytics/CDN domains and honours the allowlist, but not look-alikes or localhost", () => {
    expect(isBenignDomain("https://www.google-analytics.com/collect")).toBe(true);
    expect(isBenignDomain("https://cdn.jsdelivr.net/x.js")).toBe(true);
    expect(isBenignDomain("https://evil-google-analytics.com/")).toBe(false);
    expect(isBenignDomain("http://127.0.0.1:4791/collect/x")).toBe(false);
    expect(isBenignDomain("https://metrics.mycorp.com/e", ["mycorp.com"])).toBe(true);
    expect(isBenignDomain("https://metrics.mycorp.com/e", ["other.com"])).toBe(false);
  });
});

describe("networkExfil: sensitive data in URL or body", () => {
  it("flags an email in a pixel query string as critical (GET exfiltration)", () => {
    const f = networkExfil(net("https://track.evil.test/p.gif?e=jane%40example.com", {}, { resourceType: "image" }), [], []);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ type: "sensitive_data_outbound", severity: "critical" });
    expect(f[0]!.evidence).not.toContain("jane@example.com");
    expect(f[0]!.evidence).toContain("URL");
  });
  it("flags secrets in the path as critical", () => {
    const f = networkExfil(net("https://x.evil.test/c/sk-abcdefghijklmnopqrstuv"), [], []);
    expect(f[0]).toMatchObject({ severity: "critical" });
  });
  it("flags a Luhn card in a POST body and masks the evidence", () => {
    const f = networkExfil(net("https://x.evil.test/c", {}, { method: "POST", bodyPreview: "card=4242 4242 4242 4242" }), [], []);
    expect(f[0]).toMatchObject({ severity: "critical" });
    expect(f[0]!.evidence).not.toContain("4242 4242 4242 4242");
  });
  it("an email going back to the page's own site is only low; secrets stay critical", () => {
    expect(networkExfil(net("https://shop.test/api/profile?email=jane%40example.com"), [], [])[0]).toMatchObject({ severity: "low" });
    expect(networkExfil(net("https://shop.test/api?k=sk-abcdefghijklmnopqrstuv"), [], [])[0]).toMatchObject({ severity: "critical" });
  });
  it("an email to a known analytics domain is low", () => {
    const f = networkExfil(net("https://www.google-analytics.com/collect?uid=jane%40example.com"), [], []);
    expect(f[0]).toMatchObject({ severity: "low" });
  });
  it("treats ws:// like http:// when judging third parties", () => {
    const f = networkExfil(net("ws://127.0.0.1:4791/collect/x?e=jane@example.com", {}, { resourceType: "websocket" }), [], []);
    expect(f[0]).toMatchObject({ severity: "critical" });
    expect(f[0]!.message).toContain("WebSocket");
  });
});

describe("networkExfil: noise control", () => {
  it("ignores ordinary first-party and analytics traffic", () => {
    expect(networkExfil(net("https://shop.test/api/cart?item=lamp&page=2"), [], pageText)).toEqual([]);
    expect(networkExfil(net("https://shop.test/static/logo.png", {}, { resourceType: "image" }), [], pageText)).toEqual([]);
    expect(networkExfil(net("https://www.google-analytics.com/g/collect?v=2&tid=G-ABC&dl=https%3A%2F%2Fshop.test%2Fproduct&dt=Acme%20Desk%20Lamp"), [], pageText)).toEqual([]);
    expect(networkExfil(net("https://cdn.jsdelivr.net/npm/x.js", {}, { resourceType: "script" }), [], pageText)).toEqual([]);
  });
  it("does not treat the page's own URL or short values as copied page text", () => {
    const f = networkExfil(net("https://track.other.test/e?u=https%3A%2F%2Fshop.test%2Fproduct&p=1&s=ab"), [], [{ url: PAGE, text: "https://shop.test/product ab 1" }]);
    expect(f).toEqual([]);
  });
  it("ignores non-http destinations", () => {
    expect(networkExfil(net("data:text/plain;base64,QQ=="), [], [])).toEqual([]);
    expect(networkExfil(net("chrome-extension://abc/x.js"), [], [])).toEqual([]);
  });
});

describe("networkExfil: page text sent to a third party", () => {
  it("flags text seen earlier on a page in a POST body as high", () => {
    const f = networkExfil(
      net("https://collect.evil.test/c", {}, { method: "POST", bodyPreview: JSON.stringify({ code: "LAMP-7731-XQ" }) }),
      [],
      pageText,
    );
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ type: "cross_domain_data", severity: "high" });
    expect(f[0]!.evidence).toContain("LAMP-7731-XQ");
  });
  it("flags text copied into a query string", () => {
    const f = networkExfil(net("https://collect.evil.test/c?d=ships+to+12+Hill+Road"), [], pageText);
    expect(f[0]).toMatchObject({ type: "cross_domain_data", severity: "high" });
  });
  it("downgrades to low for an allowlisted domain and ignores pages from the destination site itself", () => {
    const url = "https://metrics.mycorp.com/c?d=LAMP-7731-XQ";
    expect(networkExfil(net(url), [], pageText, { allowlist: ["mycorp.com"] })[0]).toMatchObject({ severity: "low" });
    expect(networkExfil(net(url), [], [{ url: "https://metrics.mycorp.com/", text: "LAMP-7731-XQ" }])).toEqual([]);
  });
});

describe("networkExfil: beacon right after a hidden instruction", () => {
  const read = hiddenRead(9_000);
  it("flags a beacon / image / websocket to a new third-party domain within 2 s as high", () => {
    for (const type of ["ping", "image", "websocket"]) {
      const f = networkExfil(net("https://pixel.evil.test/hit", { timestamp: 10_000 }, { resourceType: type }), [read], []);
      expect(f, type).toHaveLength(1);
      expect(f[0]).toMatchObject({ type: "cross_domain_data", severity: "high" });
      expect(f[0]!.evidence).toContain("1000 ms after");
    }
  });
  it("also flags a page-load beacon that fired just BEFORE the page read was reported", () => {
    const f = networkExfil(net("https://pixel.evil.test/hit", { timestamp: 8_700 }, { resourceType: "ping" }), [read], []);
    expect(f).toHaveLength(1);
    expect(f[0]!.evidence).toContain("300 ms before");
  });
  it("does not flag after 2 s, for fetch, for known domains or when the page had no hidden instruction", () => {
    const at = (resourceType: string, ts = 10_000, url = "https://pixel.evil.test/hit", pr = read) =>
      networkExfil(net(url, { timestamp: ts }, { resourceType }), [pr], []);
    expect(at("ping", 11_500)).toEqual([]);
    expect(at("xmlhttprequest")).toEqual([]);
    const clean = { ...read, flags: [] };
    expect(at("ping", 10_000, undefined, clean)).toEqual([]);
    expect(at("ping", 10_000, undefined, hiddenRead(9_000, "low"))).toEqual([]);
  });
  it("downgrades analytics beacons to low and ignores domains already contacted", () => {
    const analytics = networkExfil(net("https://www.google-analytics.com/collect", { timestamp: 10_000 }, { resourceType: "ping" }), [read], []);
    expect(analytics).toHaveLength(1);
    expect(analytics[0]).toMatchObject({ severity: "low" });
    const earlier = net("https://pixel.evil.test/earlier", { timestamp: 9_500 });
    expect(networkExfil(net("https://pixel.evil.test/hit", { timestamp: 10_000 }, { resourceType: "ping" }), [read, earlier], [])).toEqual([]);
  });
});

describe("analyzeStep routes network requests to the network detector only", () => {
  it("does not double-report a POST body", () => {
    const step = net("https://x.evil.test/c", {}, { method: "POST", bodyPreview: "e=jane@example.com" });
    const flags = analyzeStep(step, [], []);
    expect(flags.filter((f) => f.type === "sensitive_data_outbound")).toHaveLength(1);
  });
  it("repeated polling is never a stuck loop", () => {
    const history = [1, 2, 3, 4, 5].map((i) => net("https://shop.test/api/poll", { timestamp: i }));
    expect(analyzeStep(net("https://shop.test/api/poll"), history, [])).toEqual([]);
  });
});
