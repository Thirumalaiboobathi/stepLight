import { redactText, sanitizeBody, sanitizeSnapshot, type Flag } from "@steplight/core";
import type { PageEventMsg } from "./messages.js";

const redactFlag = (f: Flag): Flag => ({ ...f, message: redactText(f.message), evidence: redactText(f.evidence) });

/**
 * Redact an event inside the page's content script, BEFORE it crosses into the service worker
 * (defence in depth: the worker, the stores and the exports redact again). Detectors in the
 * worker still see that something sensitive was there, because redaction leaves `[REDACTED:kind]`
 * markers that count as findings.
 * If redaction itself fails, the event is dropped (`undefined`): fail closed for privacy.
 * @example redactEventAtSource({ kind: "form_submit", ..., body: "email=a%40b.co" }) // body: "email=[REDACTED:email]"
 */
export function redactEventAtSource(event: PageEventMsg): PageEventMsg | undefined {
  try {
    switch (event.kind) {
      case "page_read":
        return {
          ...event,
          url: redactText(event.url),
          title: redactText(event.title).slice(0, 300),
          text: sanitizeSnapshot(event.text),
          flags: event.flags.map(redactFlag),
        };
      case "click":
      case "type":
        return { ...event, url: redactText(event.url), selector: redactText(event.selector), text: redactText(event.text).slice(0, 300) };
      case "form_submit":
        return {
          ...event,
          url: redactText(event.url),
          selector: redactText(event.selector),
          action: redactText(event.action),
          body: sanitizeBody(event.body),
        };
      case "network":
        return {
          ...event,
          url: redactText(event.url),
          ...(event.pageUrl !== undefined ? { pageUrl: redactText(event.pageUrl) } : {}),
          ...(event.bodyText !== undefined ? { bodyText: sanitizeBody(event.bodyText) } : {}),
        };
      case "navigate":
        return { ...event, url: redactText(event.url) };
    }
  } catch {
    return undefined;
  }
}
