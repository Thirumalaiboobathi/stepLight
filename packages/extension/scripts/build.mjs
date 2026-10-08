// Plain multi-entry Vite build (no CRXJS). Each entry is bundled on its own as a classic
// IIFE script, because content scripts cannot use ES module imports / shared chunks.
import { existsSync } from "node:fs";
import { cp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
await rm(dist, { recursive: true, force: true });

for (const name of ["background", "content", "popup"]) {
  await build({
    root,
    configFile: false,
    logLevel: "warn",
    publicDir: false,
    build: {
      outDir: dist,
      emptyOutDir: false,
      minify: false,
      target: "chrome110",
      lib: {
        entry: path.join(root, `src/${name}.ts`),
        name: `steplight_${name}`,
        formats: ["iife"],
        fileName: () => `${name}.js`,
      },
    },
  });
}
await cp(path.join(root, "public"), dist, { recursive: true });

// Bundle the replay viewer as an extension page (viewer.html) for standalone mode.
const viewerDist = path.resolve(root, "../viewer/dist");
if (!existsSync(path.join(viewerDist, "index.html"))) {
  throw new Error("Viewer is not built. Run `pnpm --filter @steplight/viewer build` first.");
}
await cp(path.join(viewerDist, "assets"), path.join(dist, "assets"), { recursive: true });
await cp(path.join(viewerDist, "index.html"), path.join(dist, "viewer.html"));
await cp(path.join(viewerDist, "favicon.svg"), path.join(dist, "favicon.svg"));
console.log("extension built →", dist);
