import { describe, expect, it } from "vitest";
import type { Step } from "../types.js";
import { bodyValues, crossDomainData } from "./crossDomainData.js";

const page = { url: "https://airline.test/flights", text: "Premium Plus fare ₹42,000 flight AI-9981" };

const submit = (body: string, over: Partial<Step> = {}): Step => ({
  id: "s1",
  runId: "r",
  index: 3,
  kind: "form_submit",
  timestamp: 0,
  url: "https://airline.test/checkout",
  request: { method: "POST", url: "https://tracker.example.net/collect", bodyPreview: body },
  flags: [],
  ...over,
});

describe("crossDomainData — positives", () => {
  it("flags form-encoded data copied from an earlier page", () => {
    const f = crossDomainData(submit("fare=Premium+Plus&x=1"), [page]);
    expect(f[0]).toMatchObject({ type: "cross_domain_data", severity: "high" });
  });
  it("flags JSON payloads", () => {
    expect(crossDomainData(submit('{"flight":"AI-9981"}'), [page])).toHaveLength(1);
  });
  it("flags PUT network requests", () => {
    const s = submit("flight=AI-9981", { kind: "network_request" });
    s.request!.method = "PUT";
    expect(crossDomainData(s, [page])).toHaveLength(1);
  });
  it("flags with several earlier pages, matching any", () => {
    const f = crossDomainData(submit("v=AI-9981"), [{ url: "https://a.test", text: "nothing" }, page]);
    expect(f).toHaveLength(1);
  });
  it("includes the copied value as evidence", () => {
    expect(crossDomainData(submit("v=AI-9981"), [page])[0]!.evidence).toContain("AI-9981");
  });
});

describe("crossDomainData — negatives", () => {
  it("ignores same-site submissions", () => {
    const s = submit("v=AI-9981");
    s.request!.url = "https://airline.test/book";
    expect(crossDomainData(s, [page])).toEqual([]);
  });
  it("ignores GET requests", () => {
    const s = submit("v=AI-9981", { kind: "network_request" });
    s.request!.method = "GET";
    expect(crossDomainData(s, [page])).toEqual([]);
  });
  it("ignores bodies with no value from history", () => {
    expect(crossDomainData(submit("name=Someone+Else"), [page])).toEqual([]);
  });
  it("ignores short or generic values", () => {
    expect(crossDomainData(submit("a=1&b=true&c=submit"), [{ url: "https://x.test", text: "1 true submit" }])).toEqual([]);
  });
  it("ignores data that came from the destination site itself", () => {
    const own = { url: "https://tracker.example.net/home", text: "AI-9981" };
    expect(crossDomainData(submit("v=AI-9981"), [own])).toEqual([]);
  });
  it("ignores steps with no request", () => {
    expect(crossDomainData(submit("x", { request: undefined }), [page])).toEqual([]);
  });
});

describe("bodyValues", () => {
  it("decodes form values and drops short ones", () => {
    expect(bodyValues("a=hello%20world&b=1")).toEqual(["hello world"]);
  });
});
