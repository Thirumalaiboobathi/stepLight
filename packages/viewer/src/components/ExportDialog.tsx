import { useMemo, useState } from "react";
import { summarizeExport, type ExportOptions, type RunBundle } from "@steplight/core";

interface Props {
  kind: "json" | "html";
  bundle: RunBundle;
  /** Set when the report also contains a comparison with a second run. */
  comparing?: boolean;
  /** Organisation policy: the file must be password-protected. */
  requirePassword?: boolean;
  onConfirm: (options: ExportOptions) => void;
  onCancel: () => void;
}

/**
 * Shown before any export: lists exactly what the file will contain, lets the person leave out
 * page snapshots, request bodies and URL query strings, and optionally protect the file with a
 * password. Everything is rendered as text.
 */
export function ExportDialog({ kind, bundle, comparing, requirePassword, onConfirm, onCancel }: Props) {
  const [stripSnapshots, setStripSnapshots] = useState(false);
  const [stripBodies, setStripBodies] = useState(false);
  const [stripQueryStrings, setStripQueryStrings] = useState(false);
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");

  const options: ExportOptions = { stripSnapshots, stripBodies, stripQueryStrings, ...(password ? { password } : {}) };
  const summary = useMemo(() => summarizeExport(bundle, options), [bundle, stripSnapshots, stripBodies, stripQueryStrings, password]);
  const mismatch = password !== again;
  const needsPassword = requirePassword === true && !password;
  const kb = (chars: number) => (chars < 1024 ? `${chars} characters` : `${(chars / 1024).toFixed(1)} KB`);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="export-title"
      data-testid="export-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4"
    >
      <div className="max-h-full w-full max-w-lg overflow-auto rounded-xl bg-white p-5 text-sm shadow-xl dark:bg-slate-900 dark:text-slate-100">
        <h2 id="export-title" className="mb-1 text-base font-semibold">
          Export {kind === "json" ? "run file (JSON)" : "HTML report"}
        </h2>
        <p className="mb-3 text-slate-500 dark:text-slate-400">
          Secrets are already redacted. Review what this file will contain:
        </p>
        <ul data-testid="export-summary" className="mb-3 list-disc space-y-0.5 pl-5">
          <li>Task title: “{summary.task}”</li>
          <li>{summary.steps} steps and {summary.flags} flags (with their evidence excerpts)</li>
          <li>{summary.snapshots} page snapshot{summary.snapshots === 1 ? "" : "s"} ({kb(summary.snapshotChars)} of page text)</li>
          <li>{summary.bodies} request body preview{summary.bodies === 1 ? "" : "s"}</li>
          <li>{summary.urlsWithQuery} URL{summary.urlsWithQuery === 1 ? "" : "s"} with a query string or fragment</li>
          {comparing && <li>A comparison with a second run</li>}
          <li>{summary.encrypted ? "Protected with your password" : "Not password-protected: anyone with the file can read it"}</li>
        </ul>

        <label className="flex items-center gap-2 py-0.5">
          <input data-testid="strip-snapshots" type="checkbox" checked={stripSnapshots} onChange={(e) => setStripSnapshots(e.target.checked)} />
          Leave out page snapshots (all page text)
        </label>
        <label className="flex items-center gap-2 py-0.5">
          <input data-testid="strip-bodies" type="checkbox" checked={stripBodies} onChange={(e) => setStripBodies(e.target.checked)} />
          Leave out request body previews
        </label>
        <label className="flex items-center gap-2 py-0.5">
          <input data-testid="strip-query" type="checkbox" checked={stripQueryStrings} onChange={(e) => setStripQueryStrings(e.target.checked)} />
          Remove query strings and fragments from URLs
        </label>

        <div className="mt-3 grid gap-2">
          <label className="grid gap-1">
            {requirePassword ? "Password (required by your organization)" : "Password (optional)"}
            <input
              data-testid="export-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="rounded border border-slate-300 bg-transparent px-2 py-1 dark:border-slate-700"
            />
          </label>
          {password && (
            <label className="grid gap-1">
              Repeat password
              <input
                data-testid="export-password-again"
                type="password"
                autoComplete="new-password"
                value={again}
                onChange={(e) => setAgain(e.target.value)}
                className="rounded border border-slate-300 bg-transparent px-2 py-1 dark:border-slate-700"
              />
            </label>
          )}
          {password && mismatch && <p className="text-red-600">The passwords do not match.</p>}
          {password && !mismatch && (
            <p className="text-slate-500 dark:text-slate-400">
              {kind === "json"
                ? "The file can be opened again with Import (or `steplight decrypt`)."
                : "The report becomes a small page that asks for the password before showing anything. There is no way to recover a forgotten password."}
            </p>
          )}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button data-testid="export-cancel" onClick={onCancel} className="rounded-lg border border-slate-300 px-3 py-1.5 dark:border-slate-700">
            Cancel
          </button>
          <button
            data-testid="export-confirm"
            disabled={(Boolean(password) && mismatch) || needsPassword}
            title={needsPassword ? "Your organization requires exports to be password-protected" : undefined}
            onClick={() => onConfirm(options)}
            className="rounded-lg bg-indigo-600 px-3 py-1.5 font-medium text-white disabled:opacity-40"
          >
            Export
          </button>
        </div>
      </div>
    </div>
  );
}
