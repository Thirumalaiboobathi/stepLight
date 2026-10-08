import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./",
  build: { outDir: "dist", emptyOutDir: true },
  server: { proxy: { "/api": "http://localhost:4777" } },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
} as never);
