import {
  LocalRunStore,
  createBundle,
  parseBundle,
  type KeyValueStore,
  type Run,
  type RunBundle,
  type RunSummary,
} from "@steplight/core";

/** Minimal shape of the `chrome` global we use when running as an extension page. */
declare const chrome: { storage: { local: KeyValueStore } };

/** True when this page is the viewer bundled inside the Chrome extension (no CLI server). */
export const inExtension: boolean =
  typeof location !== "undefined" && location.protocol === "chrome-extension:";

let store: LocalRunStore | undefined;
function localStore(): LocalRunStore {
  store ??= new LocalRunStore(chrome.storage.local);
  return store;
}

const TOKEN_KEY = "steplight-token";

/**
 * The CLI prints a link ending in `#token=<session token>`. Keep the token for this tab only
 * (sessionStorage) and remove it from the address bar so it is not copied or leaked by accident.
 */
export function initToken(): void {
  if (inExtension || typeof location === "undefined") return;
  const match = /[#&]token=([0-9a-f]{16,128})/i.exec(location.hash);
  if (!match) return;
  try {
    sessionStorage.setItem(TOKEN_KEY, match[1]!);
  } catch {
    /* storage blocked: the viewer will ask for the link again */
  }
  history.replaceState(null, "", location.pathname + location.search);
}

function authHeaders(): Record<string, string> {
  try {
    const token = sessionStorage.getItem(TOKEN_KEY);
    return token ? { authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

const AUTH_HINT = "Not authorised. Open the link printed by `steplight view` (it ends in #token=…).";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: authHeaders() });
  if (res.status === 401) throw new Error(AUTH_HINT);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return (await res.json()) as T;
}

/** Fetch the list of stored runs, newest first. */
export const fetchRuns = (): Promise<RunSummary[]> =>
  inExtension ? localStore().listRuns() : getJson("/api/runs");

/** Fetch one run with all its steps. */
export async function fetchRun(id: string): Promise<Run> {
  if (!inExtension) return getJson(`/api/runs/${encodeURIComponent(id)}`);
  const run = await localStore().getRun(id);
  if (!run) throw new Error("run not found");
  return run;
}

/** Fetch the stored snapshot text of a step, or undefined if there is none. */
export async function fetchSnapshot(runId: string, stepId: string): Promise<string | undefined> {
  if (inExtension) return localStore().getSnapshot(runId, stepId);
  const res = await fetch(
    `/api/runs/${encodeURIComponent(runId)}/snapshot/${encodeURIComponent(stepId)}`,
    { headers: authHeaders() },
  );
  return res.ok ? res.text() : undefined;
}

/** Build an exportable bundle (run + all snapshots, redacted again). */
export async function buildBundle(run: Run): Promise<RunBundle> {
  const snapshots: Record<string, string> = {};
  await Promise.all(
    run.steps
      .filter((s) => s.snapshotRef)
      .map(async (s) => {
        const text = await fetchSnapshot(run.id, s.id);
        if (text !== undefined) snapshots[s.id] = text;
      }),
  );
  return createBundle(run, snapshots);
}

/**
 * Import an exported run file. Returns the id the run was stored under.
 * @throws Error with a readable message if the file is not a valid export.
 */
export async function importRunFile(text: string): Promise<string> {
  const bundle = parseBundle(text); // validates and re-sanitises; throws on bad input
  if (inExtension) return localStore().importRun(bundle.run, bundle.snapshots);
  const res = await fetch("/api/import", { method: "POST", body: text, headers: authHeaders() });
  if (res.status === 401) throw new Error(AUTH_HINT);
  const body = (await res.json()) as { id?: string; error?: string };
  if (!res.ok || !body.id) throw new Error(body.error ?? `import failed (${res.status})`);
  return body.id;
}

/** Trigger a browser download of text content. */
export function downloadText(filename: string, text: string, type = "application/json"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Copy text to the clipboard (falls back to a hidden textarea where the async API is blocked). */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    /* fall through to the legacy path */
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand("copy");
  area.remove();
  if (!ok) throw new Error("Clipboard is not available in this browser");
}
