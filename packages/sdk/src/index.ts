import { record } from "./recorder.js";

export { record } from "./recorder.js";
export type { RecordOptions, RunHandle } from "./recorder.js";
export { VERSION } from "@steplight/core";

/**
 * Namespace form of the SDK.
 * @example
 * import { steplight } from "@steplight/sdk";
 * const run = await steplight.record(page, { task: "Book a flight" });
 */
export const steplight = { record };
