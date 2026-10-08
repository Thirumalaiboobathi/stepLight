import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

// Tests run commands that append to the audit log; keep that out of the user's real folders.
export default defineConfig({
  test: { env: { STEPLIGHT_AUDIT_FILE: path.join(os.tmpdir(), "steplight-cli-tests-audit.jsonl") } },
});
