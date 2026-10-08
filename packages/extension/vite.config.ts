import { defineConfig } from "vite";

export default defineConfig({
  build: { outDir: "dist", emptyOutDir: true, lib: false, rollupOptions: { input: "src/placeholder.ts" } },
});
