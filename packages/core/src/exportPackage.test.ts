import { describe, expect, it } from "vitest";
import { createBundle } from "./bundle.js";
import { isPasswordProtected } from "./crypto.js";
import {
  applyExportOptions,
  openProtectedBundle,
  openProtectedExport,
  packageHtmlExport,
  packageJsonExport,
  summarizeExport,
  wrapEncryptedReport,
} from "./exportPackage.js";
import { encryptWithPassword } from "./crypto.js";
import type { Run } from "./types.js";

const run: Run = {
  id: "r1",
  task: "Book PRIVATE-TASK flight",
  startedAt: 1,
  endedAt: 5,
  status: "success",
  meta: {},
  steps: [
    { id: "s0", runId: "r1", index: 0, kind: "page_read", timestamp: 2, url: "https://shop.test/p?sid=SECRETQUERY", snapshotRef: "snapshots/s0.txt", flags: [{ type: "hidden_instruction", severity: "high", message: "m", evidence: "EVIDENCE-TEXT" }] },
    { id: "s1", runId: "r1", index: 1, kind: "form_submit", timestamp: 3, url: "https://shop.test/pay", request: { method: "POST", url: "https://collect.test/c?x=QUERYVAL", bodyPreview: "note=BODY-TEXT" }, flags: [] },
  ],
};
const bundle = () => createBundle(run, { s0: "SNAPSHOT-TEXT of the page" });

describe("export options", () => {
  it("summarises exactly what a plain export contains", () => {
    expect(summarizeExport(bundle())).toMatchObject({ steps: 2, flags: 1, snapshots: 1, bodies: 1, encrypted: false });
    expect(summarizeExport(bundle()).urlsWithQuery).toBe(2);
  });
  it("strips snapshots, bodies and query strings as asked, and the summary follows", () => {
    const lean = applyExportOptions(bundle(), { stripSnapshots: true, stripBodies: true, stripQueryStrings: true });
    const json = JSON.stringify(lean);
    for (const gone of ["SNAPSHOT-TEXT", "BODY-TEXT", "SECRETQUERY", "QUERYVAL"]) expect(json, gone).not.toContain(gone);
    expect(lean.run.steps[0]!.snapshotRef).toBeUndefined();
    expect(json).toContain("EVIDENCE-TEXT"); // flags stay
    expect(summarizeExport(bundle(), { stripSnapshots: true, stripBodies: true, stripQueryStrings: true })).toMatchObject({ snapshots: 0, bodies: 0, urlsWithQuery: 0 });
  });
  it("leaves the original untouched", () => {
    const b = bundle();
    applyExportOptions(b, { stripSnapshots: true, stripBodies: true });
    expect(b.run.steps[1]!.request!.bodyPreview).toBe("note=BODY-TEXT");
    expect(Object.keys(b.snapshots)).toEqual(["s0"]);
  });
});

describe("password-protected exports", () => {
  it("JSON: unreadable without the password, importable with it", async () => {
    const text = await packageJsonExport(bundle(), { password: "pw-123", stripBodies: true });
    expect(isPasswordProtected(JSON.parse(text))).toBe(true);
    for (const plain of ["PRIVATE-TASK", "SNAPSHOT-TEXT", "EVIDENCE-TEXT", "shop.test"]) expect(text, plain).not.toContain(plain);
    const back = await openProtectedBundle(text, "pw-123");
    expect(back.run.task).toBe("Book PRIVATE-TASK flight");
    expect(back.snapshots["s0"]).toContain("SNAPSHOT-TEXT");
    expect(back.run.steps[1]!.request!.bodyPreview).toBeUndefined();
    await expect(openProtectedBundle(text, "nope")).rejects.toThrow("Wrong password");
  });
  it("HTML: the file is a small decrypt page with a strict CSP and no plaintext", async () => {
    const html = await packageHtmlExport(bundle(), { password: "pw-123" });
    for (const plain of ["PRIVATE-TASK", "SNAPSHOT-TEXT", "EVIDENCE-TEXT", "Steplight run report"]) expect(html, plain).not.toContain(plain);
    expect(html).toContain("Encrypted Steplight report");
    const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)![1]!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|connect-src|https?:/);
    expect(html.match(/<script(?! type="application\/json")/g)).toHaveLength(1);
    const { kind, text } = await openProtectedExport(html, "pw-123");
    expect(kind).toBe("report-html");
    expect(text).toContain("PRIVATE-TASK");
    expect(text).toContain("Steplight run report");
  });
  it("a report cannot be imported as a run, and junk is refused", async () => {
    const html = await packageHtmlExport(bundle(), { password: "pw" });
    await expect(openProtectedBundle(html, "pw")).rejects.toThrow("encrypted report");
    await expect(openProtectedExport("{}", "pw")).rejects.toThrow("not a password-protected");
    const wrapped = wrapEncryptedReport(await encryptWithPassword("x", "pw", "report-html", 2000));
    expect(wrapped).not.toContain("<img");
  });
  it("without a password the exports are plain", async () => {
    expect(JSON.parse(await packageJsonExport(bundle()))).toMatchObject({ format: "steplight-run" });
    expect(await packageHtmlExport(bundle())).toContain("Steplight run report");
  });
});
