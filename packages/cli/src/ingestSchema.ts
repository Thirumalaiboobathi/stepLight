import { z } from "zod";
import { STEP_KINDS, isSafeId } from "@steplight/core/node";

const id = z.string().refine(isSafeId, "unsafe id");
const text = (max: number) => z.string().max(max);
const ts = z.number().int().nonnegative().max(8.64e15);

const flag = z.object({
  type: z.string().regex(/^[a-z_]{1,40}$/),
  severity: z.enum(["low", "medium", "high", "critical"]),
  message: text(2_000),
  evidence: text(2_000),
});

const diagnosis = z.object({
  selector: text(1_000),
  matchCount: z.number().int().min(-1).max(1_000_000),
  elements: z
    .array(
      z.object({
        selector: text(1_000),
        tag: text(40),
        text: text(500),
        visible: z.boolean(),
        disabled: z.boolean(),
        inViewport: z.boolean(),
        pointerEvents: text(40).optional(),
        coveredBy: text(1_000).optional(),
      }),
    )
    .max(20),
  reasons: z.array(text(1_000)).max(20),
  similar: z.array(text(1_000)).max(20),
});

const tokens = z.object({
  total: z.number().nonnegative(),
  visibleChars: z.number().nonnegative(),
  hiddenChars: z.number().nonnegative(),
  boilerplateChars: z.number().nonnegative(),
  boilerplateShare: z.number().min(0).max(1),
  estimated: z.literal(true),
});

const step = z.object({
  id,
  runId: id,
  index: z.number().int().nonnegative().max(1_000_000),
  kind: z.enum(STEP_KINDS as unknown as [string, ...string[]]),
  timestamp: ts,
  durationMs: z.number().nonnegative().max(8.64e15).optional(),
  url: text(4_000).optional(),
  targetSelector: text(1_000).optional(),
  targetText: text(2_000).optional(),
  request: z
    .object({ method: text(16), url: text(4_000), bodyPreview: text(20_000).optional() })
    .optional(),
  flags: z.array(flag).max(100),
  causedBy: id.optional(),
  error: text(4_000).optional(),
  diagnosis: diagnosis.optional(),
  tokens: tokens.optional(),
});

/** Schema of every message accepted by `POST /api/ingest`. Unknown keys are dropped. */
export const ingestSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("run_start"),
    run: z.object({
      id,
      task: text(2_000),
      startedAt: ts,
      meta: z.record(text(200), text(1_000)).optional(),
    }),
  }),
  z.object({
    type: z.literal("step"),
    runId: id,
    step,
    snapshot: text(2_000_000).optional(),
  }),
  z.object({
    type: z.literal("run_end"),
    runId: id,
    status: z.enum(["success", "failed"]),
    endedAt: ts.optional(),
  }),
]);

export type ParsedIngest = z.infer<typeof ingestSchema>;
