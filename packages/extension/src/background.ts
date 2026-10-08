import { LocalRunStore, type KeyValueStore } from "@steplight/core";
import { createMessageHandler, type BackgroundDeps, type Session } from "./background-logic.js";
import { SERVER_URL } from "./messages.js";
import { parseMessage, senderAllowed } from "./validate.js";

const SCRIPT_ID = "steplight-recorder";

async function injectIntoActiveTab(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id !== undefined) {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
  }
}

const local = new LocalRunStore(chrome.storage.local as unknown as KeyValueStore);

const TOKEN_KEY = "cliToken";

/** The CLI session token lives in session storage: cleared when the browser closes, like the CLI's own token. */
async function getToken(): Promise<string | undefined> {
  const stored = await chrome.storage.session.get(TOKEN_KEY);
  const token = stored[TOKEN_KEY];
  return typeof token === "string" ? token : undefined;
}

const deps: BackgroundDeps = {
  local,
  getToken,
  async setToken(token) {
    if (token) await chrome.storage.session.set({ [TOKEN_KEY]: token });
    else await chrome.storage.session.remove(TOKEN_KEY);
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
    const stored = await chrome.storage.session.get("session");
    return stored["session"] as Session | undefined;
  },
  async save(session) {
    if (session) await chrome.storage.session.set({ session });
    else await chrome.storage.session.remove("session");
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
      await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] }).catch(() => undefined);
      await chrome.scripting.registerContentScripts([
        { id: SCRIPT_ID, matches: ["<all_urls>"], js: ["content.js"], runAt: "document_idle" },
      ]);
    } catch (err) {
      console.warn("[steplight] could not register content script on all sites:", err);
    }
    await injectIntoActiveTab().catch((err) => console.warn("[steplight] inject failed:", err));
  },
  async disableRecorder() {
    await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] }).catch(() => undefined);
  },
  now: () => Date.now(),
};

const handle = createMessageHandler(deps);

// Only this extension's own popup and content scripts may talk to the worker. Everything else
// (other extensions, web pages) is ignored, and malformed messages are dropped without a reply.
// The manifest declares no `externally_connectable`, so web pages cannot reach this listener at all.
chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  const message = parseMessage(raw);
  if (!message || !senderAllowed(message, sender, chrome.runtime.id)) return false;
  void handle(message).then(sendResponse);
  return true; // reply asynchronously
});
