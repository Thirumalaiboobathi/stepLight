// Runs before `pnpm pack` / `pnpm publish`: bundles the built viewer into the CLI package, because
// the published CLI serves it from ../viewer-dist (see findViewerDir in src/server.ts).
import { cp, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const from = path.resolve(root, "../viewer/dist");
const to = path.join(root, "viewer-dist");

try {
  await stat(path.join(from, "index.html"));
} catch {
  console.error("The viewer is not built. Run `pnpm -r build` first.");
  process.exit(1);
}
await rm(to, { recursive: true, force: true });
await cp(from, to, { recursive: true });
console.log(`viewer copied to ${to}`);
