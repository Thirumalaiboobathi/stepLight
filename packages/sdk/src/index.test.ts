import { expect, it } from "vitest";
import { VERSION } from "./index.js";

it("re-exports core version", () => {
  expect(VERSION).toBe("0.1.0");
});
