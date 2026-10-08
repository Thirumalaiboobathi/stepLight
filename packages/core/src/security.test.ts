import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createBundle } from "./bundle.js";
import { sha256Base64, sha256Hex } from "./hash.js";
import { renderHtmlReport } from "./htmlReport.js";
import type { Run, Step } from "./types.js";

/** Payloads an attacker could place in page text, URLs, selectors, task titles or evidence. */
export const XSS_PAYLOADS = [
  '<img src=x onerror="window.__pwned=1">',
  "<script>window.__pwned=1</script>",
  '<svg onload="window.__pwned=1"><circle r=1 /></svg>',
  "javascript:window.__pwned=1",
  '"><iframe srcdoc="<script>parent.__pwned=1</script>">',
  "</pre><details open ontoggle=window.__pwned=1>",
];

describe("sha256", () => {
  it("matches node:crypto on assorted inputs", () => {
    for (const len of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
      const text = randomBytes(len).toString("base64").slice(0, len);
      expect(sha256Hex(text)).toBe(createHash("sha256").update(text).digest("hex"));
    }
    expect(sha256Base64("héllo ✓")).toBe(createHash("sha256").update("héllo ✓").digest("base64"));
  });
});

function attackRun(payload: string): { run: Run; snapshots: Record<string, string> } {
  const step: Step = {
    id: "s0",
    runId: "r1",
    index: 0,
    kind: "page_read",
    timestamp: 1,
    url: `http://x.test/${encodeURIComponent(payload)}?q=${payload}`,
    targetText: payload,
    targetSelector: payload,
    snapshotRef: "snapshots/s0.txt",
    error: payload,
    diagnosis: { selector: payload, matchCount: 0, elements: [], similar: [payload], reasons: [payload] },
    request: { method: "POST", url: `http://evil.test/?${payload}`, bodyPreview: payload },
    flags: [{ type: "hidden_instruction", severity: "high", message: payload, evidence: payload }],
  };
  return {
    run: { id: "r1", task: payload, startedAt: 1, status: "success", steps: [step], meta: { note: payload } },
    snapshots: { s0: `before ${payload} after` },
  };
}

describe("HTML report is inert against attacker-controlled content", () => {
  for (const payload of XSS_PAYLOADS) {
    it(`escapes ${payload.slice(0, 24)}`, () => {
      const { run, snapshots } = attackRun(payload);
      const html = renderHtmlReport(createBundle(run, snapshots));
      // The only <script> element is the report's own; no element injected from data.
      expect(html.match(/<script/g)).toHaveLength(1);
      expect(html).not.toMatch(/<(img|iframe|svg|details open)\b/i);
      // Strip our own markup-free text: no inline event handler attribute can exist.
      expect(html).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
      expect(html).not.toContain("href=\"javascript:");
    });
  }

  it("carries a CSP with no network access and matching inline hashes", () => {
    const { run, snapshots } = attackRun("hi");
    const html = renderHtmlReport(createBundle(run, snapshots));
    const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)![1]!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toMatch(/connect-src|unsafe-inline|unsafe-eval|https?:|\*/);
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!;
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
    expect(csp).toContain(`style-src 'sha256-${sha256Base64(style)}'`);
    expect(csp).toContain(`script-src 'sha256-${sha256Base64(script)}'`);
    expect(html).not.toMatch(/\sstyle="/); // inline style attributes would violate the CSP
  });
});
