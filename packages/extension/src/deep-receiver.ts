import { normalizeSettings } from "@steplight/core";
import type { PageEventMsg } from "./messages.js";
import { parsePageEvent } from "./validate.js";

const SETTINGS_KEY = "sl-settings";
/** Most deep-capture events accepted per second: a page cannot flood the recorder. */
const MAX_PER_SECOND = 50;

/**
 * Receive requests reported by the opt-in page hook (`deep.js`, MAIN world) over a private
 * MessageChannel. Only starts when Deep capture is enabled in the settings. Every message must
 * carry this session's random nonce and is validated like any other page event; since page
 * scripts share a world with the hook, these events are treated as untrusted data.
 */
export function listenForDeepCapture(send: (event: PageEventMsg) => void, isActive: () => boolean): void {
  void (async () => {
    try {
      const stored = await chrome.storage.local.get(SETTINGS_KEY);
      if (!normalizeSettings(stored[SETTINGS_KEY]).deepCapture) return;
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      const nonce = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
      const channel = new MessageChannel();
      let windowStart = Date.now();
      let count = 0;
      channel.port1.onmessage = (e: MessageEvent) => {
        try {
          if (!isActive()) return;
          const data = e.data as { nonce?: unknown; event?: unknown } | null;
          if (!data || data.nonce !== nonce) return;
          if (Date.now() - windowStart > 1000) {
            windowStart = Date.now();
            count = 0;
          }
          if (++count > MAX_PER_SECOND) return;
          const event = parsePageEvent(data.event);
          if (event?.kind === "network" && event.source === "deep") send(event);
        } catch {
          /* drop malformed messages */
        }
      };
      window.postMessage({ steplight: "handshake", nonce }, location.origin, [channel.port2]);
    } catch (err) {
      console.warn("[steplight] deep capture unavailable:", err);
    }
  })();
}
