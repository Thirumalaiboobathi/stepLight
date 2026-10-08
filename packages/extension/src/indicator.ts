/**
 * A small "Steplight is recording" pill in the corner of the page, so nobody is recorded
 * unknowingly. Lives in a closed shadow root (the page's CSS and scripts cannot restyle or read
 * it), ignores pointer events, and is removed when recording stops. Optional (setting
 * `pageIndicator`), on by default.
 */
export interface Indicator {
  /** The host element; the content script ignores DOM changes caused by it. */
  readonly host: HTMLElement;
  remove(): void;
}

/** Show the pill. Returns undefined if the page cannot take it (e.g. no documentElement). */
export function showIndicator(): Indicator | undefined {
  try {
    const parent = document.documentElement;
    if (!parent) return undefined;
    const host = document.createElement("div");
    host.setAttribute("data-steplight-indicator", "");
    host.style.cssText = "all:initial;position:fixed;right:12px;bottom:12px;z-index:2147483647;pointer-events:none;";
    const root = host.attachShadow({ mode: "closed" });
    const pill = document.createElement("div");
    pill.textContent = "● Steplight is recording";
    pill.style.cssText =
      "font:600 12px/1 system-ui,sans-serif;color:#fff;background:#dc2626;padding:6px 10px;border-radius:999px;box-shadow:0 1px 6px rgba(0,0,0,.35);opacity:.92;";
    root.appendChild(pill);
    parent.appendChild(host);
    return { host, remove: () => host.remove() };
  } catch {
    return undefined;
  }
}
