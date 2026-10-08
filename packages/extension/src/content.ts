import { collectPageScan, computeTokenStats, hiddenInstruction } from "@steplight/core";
import { listenForDeepCapture } from "./deep-receiver.js";
import type { ExtensionMessage, PageEventMsg, StatusReply } from "./messages.js";

/* Runs inside web pages. Never throws into the page; stops itself when not recording. */
type Marked = typeof globalThis & { __steplightContent?: boolean };

function selectorOf(el: Element): string {
  const tag = el.tagName.toLowerCase();
  if (el.id) return `${tag}#${el.id}`;
  const name = el.getAttribute("name");
  if (name) return `${tag}[name="${name}"]`;
  const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/)[0] : "";
  return cls ? `${tag}.${cls}` : tag;
}

function textOf(el: Element): string {
  const t =
    el.getAttribute("aria-label") ||
    el.getAttribute("title") ||
    (el as HTMLElement).innerText ||
    (el as HTMLInputElement).value ||
    el.textContent ||
    "";
  return t.replace(/\s+/g, " ").trim().slice(0, 200);
}

function labelOf(el: HTMLInputElement): string {
  return (
    el.labels?.[0]?.textContent ||
    el.getAttribute("aria-label") ||
    el.getAttribute("placeholder") ||
    el.name ||
    el.id ||
    el.tagName
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

/** URL-encoded form fields. Password values are never read; file inputs are skipped. */
function formBody(form: HTMLFormElement): string {
  const parts: string[] = [];
  for (const el of Array.from(form.elements) as HTMLInputElement[]) {
    if (!el.name || el.disabled) continue;
    const type = (el.type || "").toLowerCase();
    if ((type === "checkbox" || type === "radio") && !el.checked) continue;
    if (type === "submit" || type === "button" || type === "file") continue;
    const value = type === "password" ? "[password]" : String(el.value ?? "");
    parts.push(`${encodeURIComponent(el.name)}=${encodeURIComponent(value)}`);
  }
  return parts.join("&");
}

function main(): void {
  const g = globalThis as Marked;
  if (g.__steplightContent) return;
  g.__steplightContent = true;
  let active = true;

  const send = (event: PageEventMsg): void => {
    if (!active) return;
    const message: ExtensionMessage = { type: "event", event };
    chrome.runtime
      .sendMessage(message)
      .then((reply: StatusReply | undefined) => {
        if (!reply?.recording) active = false; // recording stopped: go quiet
      })
      .catch(() => {
        active = false; // extension reloaded or unavailable
      });
  };

  const guard = <T extends Event>(fn: (e: T) => void) => (e: T) => {
    try {
      if (active) fn(e);
    } catch (err) {
      console.warn("[steplight]", err);
    }
  };

  document.addEventListener(
    "click",
    guard((e: MouseEvent) => {
      const t = e.target as Element | null;
      const el = t?.closest?.("a,button,input,select,summary,[role=button],label") ?? t;
      if (el) {
        send({ kind: "click", url: location.href, selector: selectorOf(el), text: textOf(el), timestamp: Date.now() });
      }
    }),
    true,
  );
  document.addEventListener(
    "change",
    guard((e: Event) => {
      const el = e.target as HTMLInputElement | null;
      if (el?.tagName) {
        // The value itself is deliberately not sent.
        send({ kind: "type", url: location.href, selector: selectorOf(el), text: labelOf(el), timestamp: Date.now() });
      }
    }),
    true,
  );
  document.addEventListener(
    "submit",
    guard((e: Event) => {
      const form = e.target as HTMLFormElement;
      send({
        kind: "form_submit",
        url: location.href,
        selector: selectorOf(form),
        method: (form.method || "get").toUpperCase(),
        action: form.action || location.href,
        body: formBody(form),
        timestamp: Date.now(),
      });
    }),
    true,
  );

  /* ---- page reading: at load, after SPA route changes and when scripts add text later ---- */
  const reported = new Set<string>(); // hidden-instruction evidence already reported for the current URL
  let lastUrl = "";
  let lastTextHash = 0;
  let scans = 0;
  const MAX_SCANS = 40; // per page lifetime
  const MIN_GAP_MS = 750; // at most about one scan per second
  let lastScanAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const hash = (text: string): number => {
    let h = 5381;
    for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
    return h;
  };

  /** Read the page and report it when the URL changed or new hidden instructions appeared. */
  const readPage = (reason: "load" | "change"): void => {
    try {
      if (!active || scans >= MAX_SCANS) return;
      scans++;
      lastScanAt = Date.now();
      const scan = collectPageScan();
      const textHash = hash(scan.text);
      const urlChanged = scan.url !== lastUrl;
      if (urlChanged) reported.clear();
      if (!urlChanged && textHash === lastTextHash) return;
      const flags = hiddenInstruction(scan.dom);
      const fresh = flags.filter((f) => !reported.has(f.evidence));
      if (!urlChanged && fresh.length === 0) {
        lastTextHash = textHash; // text changed but nothing new to report
        return;
      }
      lastUrl = scan.url;
      lastTextHash = textHash;
      for (const f of flags) reported.add(f.evidence);
      send({
        kind: "page_read",
        url: scan.url,
        title: reason === "load" || urlChanged ? scan.title : `${scan.title} (content changed after load)`,
        text: scan.text,
        flags: urlChanged ? flags : fresh,
        tokens: computeTokenStats(scan),
        timestamp: Date.now(),
      });
    } catch (err) {
      console.warn("[steplight] page scan failed:", err);
    }
  };

  /** Debounced, rate-limited re-read (MutationObserver and route changes). */
  const scheduleRead = (delay = 400): void => {
    if (timer !== undefined || !active) return;
    const wait = Math.max(delay, MIN_GAP_MS - (Date.now() - lastScanAt));
    timer = setTimeout(() => {
      timer = undefined;
      readPage("change");
    }, wait);
  };

  readPage("load");
  // Scripts often insert text shortly after load (and after client-side route changes).
  setTimeout(() => readPage("change"), 1000);
  try {
    const observer = new MutationObserver(() => {
      if (!active) return observer.disconnect();
      scheduleRead();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["style", "class", "hidden", "aria-label", "alt"] });
  } catch (err) {
    console.warn("[steplight] observer failed:", err);
  }

  // The service worker tells us about SPA route changes (history.pushState / #fragment).
  chrome.runtime.onMessage.addListener((message: unknown, sender) => {
    if (sender.id !== chrome.runtime.id || sender.tab) return; // only from our own service worker
    if (typeof message === "object" && message !== null && (message as { type?: unknown }).type === "rescan") {
      scans = Math.max(0, scans - 5); // a route change earns a few extra reads
      scheduleRead(300);
    }
  });

  listenForDeepCapture(send, () => active);
}

main();
