import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(path.join(root, "public/manifest.json"), "utf8"));

describe("manifest.json", () => {
  it("is a minimal-permission MV3 manifest", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions.sort()).toEqual(["activeTab", "scripting", "storage"]);
    // Broad host access is optional and requested at runtime only.
    expect(manifest.host_permissions).toEqual(["http://localhost:4777/*"]);
    expect(manifest.optional_host_permissions).toEqual(["<all_urls>"]);
    expect(manifest.content_scripts).toBeUndefined();
  });
});

describe.skipIf(!existsSync(path.join(root, "dist")))("built extension (dist)", () => {
  const dist = path.join(root, "dist");
  it("contains every file the manifest references", () => {
    const files = [manifest.background.service_worker, manifest.action.default_popup, "content.js", "popup.js"];
    for (const f of files) expect(existsSync(path.join(dist, f)), f).toBe(true);
  });
  it("bundles content script as a classic script with no module imports", () => {
    const content = readFileSync(path.join(dist, "content.js"), "utf8");
    expect(content).not.toMatch(/^\s*import\s/m);
    expect(content).not.toMatch(/^\s*export\s/m);
  });
  it("makes no network calls except to localhost", () => {
    for (const f of ["background.js", "content.js", "popup.js"]) {
      const code = readFileSync(path.join(dist, f), "utf8");
      const urls = code.match(/https?:\/\/[a-z0-9.-]+/gi) ?? [];
      const external = urls.filter((u) => !/localhost|127\.0\.0\.1|example\.|\.test|w3\.org|schema|opentelemetry|github|json-schema/i.test(u));
      expect(external, f).toEqual([]);
    }
  });
});
