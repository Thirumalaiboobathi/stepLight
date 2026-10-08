/* eslint-disable @typescript-eslint/no-explicit-any */

/** Name of the Playwright binding the injected script reports through. */
export const BINDING_NAME = "__steplightEmit";

/** An interaction reported by the injected page script. */
export interface PageEvent {
  type: "click" | "change" | "submit";
  selector: string;
  text: string;
  /** Present for `submit`. */
  method?: string;
  action?: string;
  body?: string;
}

/**
 * Page-side script: reports clicks, field changes and form submissions through the
 * binding. Self-contained (serialised by Playwright). Never throws into the host page.
 * Password and file field values are never read.
 */
export function installPageListeners(bindingName: string): void {
  const w: any = globalThis;
  if (w.__steplightInstalled) return;
  w.__steplightInstalled = true;
  const emit = (e: unknown) => {
    try {
      const fn = w[bindingName];
      if (typeof fn === "function") void Promise.resolve(fn(e)).catch(() => undefined);
    } catch {
      /* fail open */
    }
  };
  const selectorOf = (el: any): string => {
    if (!el || !el.tagName) return "";
    const tag = String(el.tagName).toLowerCase();
    if (el.id) return `${tag}#${el.id}`;
    const name = el.getAttribute && el.getAttribute("name");
    if (name) return `${tag}[name="${name}"]`;
    const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/)[0] : "";
    return cls ? `${tag}.${cls}` : tag;
  };
  const textOf = (el: any): string => {
    const t =
      (el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("title"))) ||
      el.innerText ||
      el.value ||
      el.textContent ||
      "";
    return String(t).replace(/\s+/g, " ").trim().slice(0, 200);
  };
  const labelOf = (el: any): string =>
    String(
      (el.labels && el.labels[0] && el.labels[0].textContent) ||
        el.getAttribute("aria-label") ||
        el.getAttribute("placeholder") ||
        el.name ||
        el.id ||
        el.tagName,
    )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100);
  const formBody = (form: any): string => {
    const parts: string[] = [];
    for (const el of Array.from(form.elements) as any[]) {
      if (!el.name || el.disabled) continue;
      const type = String(el.type || "").toLowerCase();
      if ((type === "checkbox" || type === "radio") && !el.checked) continue;
      if (type === "submit" || type === "button" || type === "file") continue;
      const value = type === "password" ? "[password]" : String(el.value ?? "");
      parts.push(`${encodeURIComponent(el.name)}=${encodeURIComponent(value)}`);
    }
    return parts.join("&");
  };
  const submitEvent = (form: any) => {
    emit({
      type: "submit",
      selector: selectorOf(form),
      text: textOf(form).slice(0, 100),
      method: String(form.method || "get").toUpperCase(),
      action: String(form.action || w.location.href),
      body: formBody(form),
    });
  };

  w.document.addEventListener(
    "click",
    (ev: any) => {
      try {
        const t = ev.target;
        const el = (t && t.closest && t.closest("a,button,input,select,summary,[role=button],label")) || t;
        if (el) emit({ type: "click", selector: selectorOf(el), text: textOf(el) });
      } catch {
        /* fail open */
      }
    },
    true,
  );
  w.document.addEventListener(
    "change",
    (ev: any) => {
      try {
        const el = ev.target;
        if (!el || !el.tagName) return;
        emit({ type: "change", selector: selectorOf(el), text: labelOf(el) });
      } catch {
        /* fail open */
      }
    },
    true,
  );
  w.document.addEventListener(
    "submit",
    (ev: any) => {
      try {
        submitEvent(ev.target);
      } catch {
        /* fail open */
      }
    },
    true,
  );
  try {
    const proto: any = (globalThis as any).HTMLFormElement.prototype;
    const original = proto.submit;
    proto.submit = function (this: any) {
      try {
        submitEvent(this);
      } catch {
        /* fail open */
      }
      return original.apply(this, arguments);
    };
  } catch {
    /* fail open */
  }
}
