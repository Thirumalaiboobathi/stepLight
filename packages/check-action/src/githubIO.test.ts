import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseOutputs } from "./fixtures.js";
import { escapeCommandData, getInput, neutralizeLog, setOutput } from "./githubIO.js";
import { escapeMarkdown } from "./summary.js";

describe("githubIO", () => {
  it("reads inputs the way the runner exposes them", () => {
    expect(getInput({ "INPUT_RUNS-DIR": " x/y " }, "runs-dir")).toBe("x/y");
    expect(getInput({}, "run-id")).toBe("");
  });

  it("neutralises lines that would be workflow commands", () => {
    for (const evil of ["::set-env name=A::b", "  ::add-mask::x", "ok\n::stop-commands::t", "a\r::error::b"]) {
      for (const line of neutralizeLog(evil).split("\n")) expect(line).not.toMatch(/^\s*::/);
    }
    expect(neutralizeLog("plain text ::inline is fine")).toBe("plain text ::inline is fine");
    expect(neutralizeLog("a\u0000b\u001bc")).toBe("a?b?c");
  });

  it("escapes command data", () => {
    expect(escapeCommandData("a%b\r\nc")).toBe("a%25b%0D%0Ac");
  });

  it("a value cannot end its own output entry and inject another output", async () => {
    const file = path.join(await mkdtemp(path.join(os.tmpdir(), "sl-out-")), "out");
    await writeFile(file, "");
    const evil = "x\nresult<<EOF\nfail\nEOF\n";
    setOutput({ GITHUB_OUTPUT: file }, "report-file", evil);
    setOutput({ GITHUB_OUTPUT: file }, "result", "pass");
    const parsed = parseOutputs(await readFile(file, "utf8"));
    expect(parsed["report-file"]).toBe(evil);
    expect(parsed["result"]).toBe("pass");
  });

  it("does nothing when GITHUB_OUTPUT is not set (local runs)", () => {
    expect(() => setOutput({}, "result", "pass")).not.toThrow();
  });
});

describe("escapeMarkdown", () => {
  it("escapes everything that can start Markdown or HTML", () => {
    expect(escapeMarkdown("<b>x</b> [a](b) `c` *d* _e_ #f | g ~h~ !i @j :k: &l")).toBe(
      "\\<b\\>x\\</b\\> \\[a\\]\\(b\\) \\`c\\` \\*d\\* \\_e\\_ \\#f \\| g \\~h\\~ \\!i \\@j \\:k\\: \\&l",
    );
  });

  it("flattens line breaks and control characters and shortens long text", () => {
    expect(escapeMarkdown("a\nb\r\nc\u0007d e")).toBe("a b c d e");
    const long = escapeMarkdown("x".repeat(500), 50);
    expect(long.length).toBe(50);
    expect(long.endsWith("…")).toBe(true);
  });

  it("redacts secrets before anything else", () => {
    expect(escapeMarkdown("mail me at ana@example.com")).not.toContain("ana@example.com");
  });
});
