import { createMessageHandler, type BackgroundDeps, type Session } from "./background-logic.js";
import { SERVER_URL, type ExtensionMessage } from "./messages.js";

const SCRIPT_ID = "steplight-recorder";

async function injectIntoActiveTab(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id !== undefined) {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
  }
}

const deps: BackgroundDeps = {
  async load() {
    const stored = await chrome.storage.session.get("session");
    return stored["session"] as Session | undefined;
  },
  async save(session) {
    if (session) await chrome.storage.session.set({ session });
    else await chrome.storage.session.remove("session");
  },
  async post(message) {
    const res = await fetch(`${SERVER_URL}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
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

chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  void handle(message).then(sendResponse);
  return true; // reply asynchronously
});
