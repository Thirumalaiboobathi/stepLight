// Plain multi-entry Vite build (no CRXJS). Each entry is bundled on its own as a classic
// IIFE script, because content scripts cannot use ES module imports / shared chunks.
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
console.log("extension built →", dist);
