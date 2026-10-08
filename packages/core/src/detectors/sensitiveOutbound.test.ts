import { describe, expect, it } from "vitest";
import { sensitiveOutbound } from "./sensitiveOutbound.js";

const post = (bodyPreview: string, url = "https://collector.test/x", method = "POST") => ({
  method,
  url,
  bodyPreview,
});

describe("sensitiveOutbound — positives", () => {
  it("flags a Luhn-valid card number as critical", () => {
    const f = sensitiveOutbound(post("card=4242 4242 4242 4242"));
    expect(f[0]).toMatchObject({ type: "sensitive_data_outbound", severity: "critical" });
  });
  it("flags an OpenAI-style key", () => {
    expect(sensitiveOutbound(post("key=sk-abcdefghijklmnopqrstuvwx"))[0]?.severity).toBe("critical");
  });
  it("flags an AWS access key", () => {
    expect(sensitiveOutbound(post("AKIAIOSFODNN7EXAMPLE"))[0]?.severity).toBe("critical");
  });
  it("flags a GitHub token", () => {
    expect(sensitiveOutbound(post("t=ghp_" + "a".repeat(36)))[0]?.severity).toBe("critical");
  });
  it("flags a JWT", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk";
    expect(sensitiveOutbound(post(jwt))[0]?.message).toContain("JWT");
  });
  it("flags an email sent to another site as critical", () => {
    const f = sensitiveOutbound(post("email=jane@example.com"), "https://shop.test/checkout");
    expect(f[0]?.severity).toBe("critical");
  });
  it("never leaks the secret in evidence", () => {
    const f = sensitiveOutbound(post("sk-abcdefghijklmnopqrstuvwx"));
    expect(f[0]!.evidence).not.toContain("abcdefghijklmnop");
  });
});

describe("sensitiveOutbound — negatives", () => {
  it("ignores digit strings that fail Luhn", () => {
    expect(sensitiveOutbound(post("order=1234 5678 9012 3456"))).toEqual([]);
  });
  it("ignores GET requests", () => {
    expect(sensitiveOutbound(post("a@b.co", "https://x.test", "GET"))).toEqual([]);
  });
  it("ignores empty bodies", () => {
    expect(sensitiveOutbound({ method: "POST", url: "https://x.test" })).toEqual([]);
  });
  it("ignores harmless bodies", () => {
    expect(sensitiveOutbound(post('{"flight":"AI-101","seat":"12A"}'))).toEqual([]);
  });
  it("downgrades a same-site email to low", () => {
    const f = sensitiveOutbound(post("email=a@b.co", "https://shop.test/login"), "https://shop.test/");
    expect(f[0]?.severity).toBe("low");
  });
  it("ignores short 'sk-' words", () => {
    expect(sensitiveOutbound(post("task-list sk-short"))).toEqual([]);
  });
});
