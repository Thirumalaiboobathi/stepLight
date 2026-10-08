import type { Severity } from "@steplight/core";
import { SEVERITY_STYLE } from "../format";

/** Small coloured pill showing a severity (renders nothing when undefined). */
export function SeverityBadge({ severity, label }: { severity?: Severity; label?: string }) {
  if (!severity) return null;
  return (
    <span
      data-testid="severity-badge"
      className={`inline-block shrink-0 rounded-full px-2 py-0.5 text-xs font-medium uppercase tracking-wide ${SEVERITY_STYLE[severity].badge}`}
    >
      {label ?? severity}
    </span>
  );
}
