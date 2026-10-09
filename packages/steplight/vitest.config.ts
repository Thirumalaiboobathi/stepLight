import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 120_000,
    env: { STEPLIGHT_AUDIT_FILE: path.join(os.tmpdir(), "steplight-pkg-tests-audit.jsonl") },
  },
});
