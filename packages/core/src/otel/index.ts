import { context, trace, SpanStatusCode, type Tracer } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { maxSeverity } from "../severity.js";
import type { Run } from "../types.js";

/** Default OTLP/HTTP collector endpoint. */
export const DEFAULT_OTLP_ENDPOINT = "http://localhost:4318";

/**
 * Emit a run as OpenTelemetry spans: a root `steplight.run` span, one child
 * `steplight.step.<kind>` span per step and one `steplight.flag` event per flag.
 * @example emitRunSpans(run, provider.getTracer("steplight"))
 */
export function emitRunSpans(run: Run, tracer: Tracer): void {
  const end = run.endedAt ?? run.steps.at(-1)?.timestamp ?? run.startedAt;
  const root = tracer.startSpan(
    "steplight.run",
    {
      startTime: run.startedAt,
      attributes: {
        "gen_ai.operation.name": "invoke_agent",
        "steplight.task": run.task,
        "steplight.run_id": run.id,
        "steplight.status": run.status,
      },
    },
    context.active(),
  );
  const parentCtx = trace.setSpan(context.active(), root);

  for (const step of run.steps) {
    const worst = maxSeverity(step.flags);
    const attributes: Record<string, string | number> = {
      "steplight.step.index": step.index,
      "steplight.step.id": step.id,
      "steplight.flag.count": step.flags.length,
    };
    if (step.url) attributes["url.full"] = step.url;
    if (worst) attributes["steplight.flag.max_severity"] = worst;
    if (step.targetText) attributes["steplight.step.target_text"] = step.targetText;
    if (step.causedBy) attributes["steplight.step.caused_by"] = step.causedBy;
    if (step.request) attributes["http.request.method"] = step.request.method;

    const span = tracer.startSpan(
      `steplight.step.${step.kind}`,
      { startTime: step.timestamp, attributes },
      parentCtx,
    );
    for (const flag of step.flags) {
      span.addEvent(
        "steplight.flag",
        {
          "steplight.flag.type": flag.type,
          "steplight.flag.severity": flag.severity,
          "steplight.flag.message": flag.message,
        },
        step.timestamp,
      );
    }
    if (step.kind === "error") span.setStatus({ code: SpanStatusCode.ERROR });
    span.end(step.timestamp + (step.durationMs ?? 0));
  }

  if (run.status === "failed") root.setStatus({ code: SpanStatusCode.ERROR });
  root.end(Math.max(end, run.startedAt));
}

/**
 * Send a run to an OTLP/HTTP endpoint (or a custom exporter). Never throws: if nothing
 * is listening the failure is swallowed and `false` is returned.
 * @example await exportRunOtlp(run) // uses OTEL_EXPORTER_OTLP_ENDPOINT or localhost:4318
 */
export async function exportRunOtlp(
  run: Run,
  options: { endpoint?: string; exporter?: SpanExporter } = {},
): Promise<boolean> {
  try {
    const base = options.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? DEFAULT_OTLP_ENDPOINT;
    const exporter =
      options.exporter ??
      new OTLPTraceExporter({
        url: `${base.replace(/\/+$/, "")}/v1/traces`,
        timeoutMillis: 3000,
      });
    const provider = new BasicTracerProvider({
      resource: resourceFromAttributes({ "service.name": "steplight" }),
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    emitRunSpans(run, provider.getTracer("steplight"));
    await provider.forceFlush();
    await provider.shutdown();
    return true;
  } catch {
    return false;
  }
}
