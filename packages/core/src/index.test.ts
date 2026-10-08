import { describe, expect, it } from "vitest";
import { VERSION } from "./index.js";

describe("core", () => {
  it("exports a version", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
