import { formatTokens, summarizeTokens, type Run } from "@steplight/core";
import { shortUrl } from "../format";

/** Run-level token cost estimate with the three most expensive pages. Renders nothing without data. */
export function TokenSummary({ run, onSelect }: { run: Run; onSelect: (index: number) => void }) {
  const s = summarizeTokens(run);
  if (s.pages === 0) return null;
  return (
    <div data-testid="token-summary" className="border-b border-slate-200 px-4 py-3 text-sm dark:border-slate-800">
      <p>
        <span className="font-semibold">~{formatTokens(s.total)} tokens</span>{" "}
        <span className="text-xs text-slate-500 dark:text-slate-400">
          (estimate, chars/4) across {s.pages} page read{s.pages === 1 ? "" : "s"} ·{" "}
          {Math.round(s.boilerplateShare * 100)}% boilerplate
          {s.hiddenChars > 0 ? ` · ${formatTokens(Math.ceil(s.hiddenChars / 4))} hidden` : ""}
        </span>
      </p>
      <p className="mt-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
        Most expensive pages
      </p>
      <ol className="mt-1 space-y-1">
        {s.top.map((p) => (
          <li key={p.stepId}>
            <button
              data-testid="expensive-page"
              onClick={() => onSelect(p.index)}
              className="flex w-full items-baseline gap-2 rounded px-1 py-0.5 text-left text-xs hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <span className="w-12 shrink-0 font-mono">{formatTokens(p.tokens)}</span>
              <span className="min-w-0 flex-1 truncate">{shortUrl(p.url) || `step #${p.index}`}</span>
              <span className="shrink-0 text-slate-500 dark:text-slate-400">{Math.round(p.boilerplateShare * 100)}% boilerplate</span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
