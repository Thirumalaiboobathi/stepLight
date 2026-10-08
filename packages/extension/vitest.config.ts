import { defineConfig } from "vitest/config";

// The end-to-end tests load the real extension and share port 4777 with the CLI server,
// so test files must not run in parallel.
export default defineConfig({
  test: { fileParallelism: false },
});
