// The project lives in the `steplight-dev` GitHub organisation. This test fails if a link to an
// earlier location (a personal-account path, or `steplight/steplight`, which belongs to someone else)
// is committed again, and checks that package metadata points to the right place.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SELF = "packages/cli/src/urls.test.ts";
const TEXT = /\.(md|ts|tsx|js|mjs|cjs|json|ya?ml|html|css|txt|toml|svg)$/i;

/** Forbidden: old repository locations. The throwaway test repository `…/steplight-action-test` is allowed. */
const OLD_URLS: { name: string; pattern: RegExp }[] = [
  { name: "personal-account path of the main repository", pattern: /Thirumalaiboobathi\/steplight(?!-action-test)/i },
  { name: "personal-account path of the action repository", pattern: /Thirumalaiboobathi\/steplight-check-action/i },
  { name: "steplight/steplight (a different GitHub account)", pattern: /(?<![\w@./-])steplight\/steplight(?![\w-])/i },
  { name: "github.com/steplight/ (a different GitHub account)", pattern: /github\.com\/steplight\//i },
];

function trackedFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out.split("\0").filter((f) => f && TEXT.test(f) && f !== SELF && f !== "pnpm-lock.yaml");
}

describe("repository URLs", () => {
  it("no tracked text file links to an old repository location", () => {
    const hits: string[] = [];
    for (const file of trackedFiles()) {
      const text = readFileSync(path.join(ROOT, file), "utf8");
      for (const { name, pattern } of OLD_URLS) if (pattern.test(text)) hits.push(`${file}: ${name}`);
    }
    expect(hits).toEqual([]);
  });

  it("the patterns do catch the old URLs (and allow the new ones)", () => {
    const bad = [
      "https://github.com/Thirumalaiboobathi/stepLight",
      "Thirumalaiboobathi/steplight-check-action@abc",
      "git+https://github.com/steplight/steplight.git",
      "see steplight/steplight for details",
    ];
    for (const s of bad) expect(OLD_URLS.some((o) => o.pattern.test(s)), s).toBe(true);
    const ok = [
      "https://github.com/steplight-dev/steplight",
      "steplight-dev/steplight-check-action@abc",
      "Thirumalaiboobathi/steplight-action-test",
      "@steplight/core and steplight-plugin",
      "packages/steplight/steplight-x",
    ];
    for (const s of ok) expect(OLD_URLS.some((o) => o.pattern.test(s)), s).toBe(false);
  });

  it("every published package points at steplight-dev/steplight", () => {
    for (const pkg of ["core", "cli", "sdk", "redteam"]) {
      const json = JSON.parse(readFileSync(path.join(ROOT, "packages", pkg, "package.json"), "utf8")) as {
        repository?: { url?: string };
        homepage?: string;
        bugs?: { url?: string };
      };
      expect(json.repository?.url, pkg).toBe("git+https://github.com/steplight-dev/steplight.git");
      expect(json.homepage, pkg).toBe("https://github.com/steplight-dev/steplight#readme");
      expect(json.bugs?.url, pkg).toBe("https://github.com/steplight-dev/steplight/issues");
    }
  });

  it("the public Action README and security policy use the organisation's repositories", () => {
    const readme = readFileSync(path.join(ROOT, "packages", "check-action", "publish", "README.md"), "utf8");
    expect(readme).toContain("steplight-dev/steplight-check-action@");
    expect(readme).toContain("https://github.com/steplight-dev/steplight");
    const security = readFileSync(path.join(ROOT, "SECURITY.md"), "utf8");
    expect(security).toContain("https://github.com/steplight-dev/steplight/security/advisories/new");
  });
});
