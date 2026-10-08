import { LocalRunStore, normalizeSettings, type KeyValueStore, type Settings } from "@steplight/core";
import { createMessageHandler, type BackgroundDeps, type Session } from "./background-logic.js";
import { SERVER_URL } from "./messages.js";
import { NetworkCollector, type WebRequestDetails } from "./network-collector.js";
import { parseMessage, senderAllowed } from "./validate.js";

const SCRIPT_ID = "steplight-recorder";
const DEEP_ID = "steplight-deep";
const SETTINGS_KEY = "sl-settings";
const TOKEN_KEY = "cliToken";

/** Unregister our content scripts one by one: the API rejects the whole call if any id is unknown. */
async function unregisterAll(): Promise<void> {
  for (const id of [SCRIPT_ID, DEEP_ID]) await chrome.scripting.unregisterContentScripts({ ids: [id] }).catch(() => undefined);
}

async function injectIntoActiveTab(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id !== undefined) {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
  }
}

const local = new LocalRunStore(chrome.storage.local as unknown as KeyValueStore);

/** The CLI session token lives in session storage: cleared when the browser closes, like the CLI's own token. */
async function getToken(): Promise<string | undefined> {
  const stored = await chrome.storage.session.get(TOKEN_KEY);
  const token = stored[TOKEN_KEY];
  return typeof token === "string" ? token : undefined;
}

/* ---------- settings (cached; refreshed when they change) ---------- */

let settingsCache: Settings | undefined;
async function getSettings(): Promise<Settings> {
  if (!settingsCache) {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    settingsCache = normalizeSettings(stored[SETTINGS_KEY]);
  }
  return settingsCache;
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[SETTINGS_KEY]) settingsCache = normalizeSettings(changes[SETTINGS_KEY].newValue);
});

/* ---------- session: kept in memory, persisted shortly after each change ---------- */

let cachedSession: Session | undefined;
let sessionLoaded: Promise<void> | undefined;
let persistTimer: ReturnType<typeof setTimeout> | undefined;
const PERSIST_DELAY_MS = 250;

/** Load the persisted session once per service-worker lifetime. */
function ensureSessionLoaded(): Promise<void> {
  sessionLoaded ??= chrome.storage.session.get("session").then((stored) => {
    cachedSession ??= stored["session"] as Session | undefined;
  });
  return sessionLoaded;
}

async function persistSession(): Promise<void> {
  persistTimer = undefined;
  if (cachedSession) await chrome.storage.session.set({ session: cachedSession });
  else await chrome.storage.session.remove("session");
}

const deps: BackgroundDeps = {
  local,
  getToken,
  async setToken(token) {
    if (token) await chrome.storage.session.set({ [TOKEN_KEY]: token });
    else await chrome.storage.session.remove(TOKEN_KEY);
  },
  settings: getSettings,
  async activeTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab ? { ...(tab.id !== undefined ? { id: tab.id } : {}), ...(tab.url ? { url: tab.url } : {}) } : undefined;
  },
  async probe() {
    const token = await getToken();
    if (!token) return false; // not paired: stay standalone
    try {
      const res = await fetch(`${SERVER_URL}/api/runs`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(1500),
      });
      return res.ok;
    } catch {
      return false;
    }
  },
  async load() {
    await ensureSessionLoaded();
    return cachedSession;
  },
  async save(session) {
    cachedSession = session;
    sessionLoaded ??= Promise.resolve();
    if (!session) {
      if (persistTimer) clearTimeout(persistTimer);
      await persistSession(); // stopping: persist immediately
    } else {
      persistTimer ??= setTimeout(() => void persistSession(), PERSIST_DELAY_MS);
    }
  },
  async post(message) {
    const token = await getToken();
    if (!token) throw new Error("not paired with the Steplight CLI");
    const res = await fetch(`${SERVER_URL}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(message),
    });
    if (!res.ok) throw new Error(`Steplight server answered ${res.status}`);
  },
  async enableRecorder() {
    // Follow the agent across pages when the optional "all sites" permission was granted;
    // otherwise (activeTab only) record just the current page.
    try {
      await unregisterAll();
      await chrome.scripting.registerContentScripts([
        { id: SCRIPT_ID, matches: ["<all_urls>"], js: ["content.js"], runAt: "document_idle" },
      ]);
      // "Deep capture" is opt-in: hook fetch/XHR/beacon/WebSocket in the page's own JS world.
      if ((await getSettings()).deepCapture) {
        await chrome.scripting.registerContentScripts([
          { id: DEEP_ID, matches: ["<all_urls>"], js: ["deep.js"], runAt: "document_start", world: "MAIN" },
        ]);
      }
    } catch (err) {
      console.warn("[steplight] could not register content scripts on all sites:", err);
    }
    await injectIntoActiveTab().catch((err) => console.warn("[steplight] inject failed:", err));
  },
  async disableRecorder() {
    await unregisterAll();
  },
  now: () => Date.now(),
};

const handle = createMessageHandler(deps);

/* ---------- messages from the popup and content scripts ---------- */

// Only this extension's own popup and content scripts may talk to the worker. Everything else
// (other extensions, web pages) is ignored, and malformed messages are dropped without a reply.
// The manifest declares no `externally_connectable`, so web pages cannot reach this listener at all.
chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  const message = parseMessage(raw);
  if (!message || !senderAllowed(message, sender, chrome.runtime.id)) return false;
  void handle(message).then(sendResponse);
  return true; // reply asynchronously
});

/* ---------- network capture (observational, non-blocking) and SPA navigation ---------- */

/** Request types the page hooks also report. */
const HOOKED = new Set(["xmlhttprequest", "ping", "websocket"]);
const DEEP_GRACE_MS = 400;

const collector = new NetworkCollector(
  () => cachedSession?.tabId,
  (event) => {
    // With Deep capture on, give the page hook a moment to report the same request first (it
    // carries the payload); the browser's own copy is then merged away instead of duplicated.
    if (settingsCache?.deepCapture && HOOKED.has(event.resourceType)) {
      setTimeout(() => void handle({ type: "event", event }), DEEP_GRACE_MS);
    } else {
      void handle({ type: "event", event });
    }
  },
  () => cachedSession?.tabUrl,
);
const URLS = ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"];
const guarded = (fn: (d: WebRequestDetails) => void) => (d: { tabId: number }): undefined => {
  // Cheap checks first: most events belong to tabs we are not recording.
  void ensureSessionLoaded().then(() => {
    if (cachedSession?.tabId === d.tabId) fn(d as unknown as WebRequestDetails);
  });
  return undefined; // observe only: never block or modify a request
};

chrome.webRequest.onBeforeRequest.addListener(guarded((d) => collector.onBeforeRequest(d)), { urls: URLS }, ["requestBody"]);
chrome.webRequest.onCompleted.addListener(guarded((d) => collector.onCompleted(d)), { urls: URLS }, ["responseHeaders"]);
chrome.webRequest.onErrorOccurred.addListener(guarded((d) => collector.onError(d)), { urls: URLS });

async function onSpaNavigation(d: { tabId: number; frameId: number; url: string }, via: "history" | "fragment"): Promise<void> {
  await ensureSessionLoaded();
  if (d.frameId !== 0 || cachedSession?.tabId !== d.tabId) return;
  await handle({ type: "event", event: { kind: "navigate", url: d.url, via, timestamp: Date.now() } });
  // Ask the content script to re-read the page: a new route may show (or hide) different text.
  chrome.tabs.sendMessage(d.tabId, { type: "rescan" }).catch(() => undefined);
}
chrome.webNavigation.onHistoryStateUpdated.addListener((d) => void onSpaNavigation(d, "history"));
chrome.webNavigation.onReferenceFragmentUpdated.addListener((d) => void onSpaNavigation(d, "fragment"));
