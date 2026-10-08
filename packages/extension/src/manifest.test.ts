import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(path.join(root, "public/manifest.json"), "utf8"));

describe("manifest.json", () => {
  it("is a minimal-permission MV3 manifest", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions.sort()).toEqual(["activeTab", "scripting", "storage", "webNavigation", "webRequest"]);
    // Broad host access is optional and requested at runtime only.
    expect(manifest.host_permissions).toEqual(["http://localhost:4777/*"]);
    expect(manifest.optional_host_permissions).toEqual(["<all_urls>"]);
    expect(manifest.content_scripts).toBeUndefined();
  });
});

describe("manifest security", () => {
  const csp = manifest.content_security_policy.extension_pages as string;
  it("sets a strict extension-page CSP", () => {
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*|https:|data:|blob:/);
    // network only to the local CLI
    for (const url of csp.match(/https?:\/\/[^\s;]+/g) ?? []) expect(url).toMatch(/^http:\/\/(localhost|127\.0\.0\.1):4777$/);
  });
  it("is not reachable from web pages or other extensions", () => {
    expect(manifest.externally_connectable).toBeUndefined();
    expect(manifest.web_accessible_resources).toBeUndefined();
    expect(manifest.content_scripts).toBeUndefined();
  });
});

describe("managed policy schema", () => {
  const schema = JSON.parse(readFileSync(path.join(root, "public/managed_schema.json"), "utf8"));
  it("is declared in the manifest and exists", () => {
    expect(manifest.storage).toEqual({ managed_schema: "managed_schema.json" });
  });
  it("describes exactly the policy keys the code understands", async () => {
    const { POLICY_KEYS } = await import("@steplight/core");
    expect(Object.keys(schema.properties).sort()).toEqual([...POLICY_KEYS].sort());
    expect(schema.type).toBe("object");
    for (const [key, def] of Object.entries<{ title?: string; description?: string; type?: string }>(schema.properties)) {
      expect(def.title, key).toBeTruthy();
      expect(def.description, key).toBeTruthy();
      expect(["string", "array", "integer", "boolean"]).toContain(def.type);
    }
    expect(schema.properties.maxCaptureLevel.enum).toEqual(["minimal", "standard", "full"]);
  });
});

describe("manifest icons", () => {
  it("declares 16/32/48/128 px icons that exist in public/", () => {
    expect(Object.keys(manifest.icons).sort()).toEqual(["128", "16", "32", "48"]);
    expect(manifest.action.default_icon).toEqual(manifest.icons);
    for (const f of Object.values<string>(manifest.icons)) expect(existsSync(path.join(root, "public", f)), f).toBe(true);
  });
});

describe.skipIf(!existsSync(path.join(root, "dist")))("built extension (dist)", () => {
  const dist = path.join(root, "dist");
  it("contains every file the manifest references", () => {
    const files = [manifest.background.service_worker, manifest.action.default_popup, "content.js", "popup.js", "deep.js", "settings.js", "settings.html", "viewer.html", ...Object.values<string>(manifest.icons)];
    for (const f of files) expect(existsSync(path.join(dist, f)), f).toBe(true);
  });
  it("bundles content script as a classic script with no module imports", () => {
    const content = readFileSync(path.join(dist, "content.js"), "utf8");
    expect(content).not.toMatch(/^\s*import\s/m);
    expect(content).not.toMatch(/^\s*export\s/m);
  });
  it("makes no network calls except to localhost", () => {
    for (const f of ["background.js", "content.js", "popup.js", "deep.js", "settings.js"]) {
      const code = readFileSync(path.join(dist, f), "utf8");
      const urls = code.match(/https?:\/\/[a-z0-9.-]+/gi) ?? [];
      const external = urls.filter((u) => !/localhost|127\.0\.0\.1|example\.|\.test|w3\.org|schema|opentelemetry|github|json-schema/i.test(u));
      expect(external, f).toEqual([]);
    }
  });
});
