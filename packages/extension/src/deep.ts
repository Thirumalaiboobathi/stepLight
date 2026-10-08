/*
 * "Deep capture" hook. Runs in the page's own JavaScript world (manifest world: MAIN) and is
 * registered ONLY when the user turned Deep capture on. It reports fetch, XMLHttpRequest,
 * navigator.sendBeacon and WebSocket traffic, including bodies before they are encoded, to the
 * extension's content script over a private MessageChannel (the port is handed over once, in a
 * handshake that the hook swallows before any page script can see it).
 *
 * Rules: never throw into the page, never change what the page sends, keep names / lengths /
 * toString() of the wrapped functions native-looking (Proxy, not replacement functions).
 * Everything this file reports is untrusted by the receiver: the page can see this world too.
 */
(() => {
  const MAX_BODY = 20_000;
  const MAX_BUFFER = 100;
  let port: MessagePort | undefined;
  let nonce = "";
  const buffer: Record<string, unknown>[] = [];

  const deliver = (event: Record<string, unknown>): void => {
    try {
      port?.postMessage({ nonce, event });
    } catch {
      /* the receiver went away */
    }
  };
  const report = (event: Record<string, unknown>): void => {
    try {
      const full = { ...event, source: "deep", timestamp: Date.now(), pageUrl: location.href };
      if (port) deliver(full);
      else if (buffer.length < MAX_BUFFER) buffer.push(full);
    } catch {
      /* never break the page */
    }
  };

  window.addEventListener(
    "message",
    (e: MessageEvent) => {
      if (port || e.source !== window) return;
      const d = e.data as { steplight?: unknown; nonce?: unknown } | null;
      if (d && d.steplight === "handshake" && typeof d.nonce === "string" && e.ports[0]) {
        e.stopImmediatePropagation(); // page scripts registered later never see the handshake
        port = e.ports[0];
        nonce = d.nonce;
        for (const ev of buffer.splice(0)) deliver(ev);
      }
    },
    true,
  );

  /** Best-effort text of a request body; binary and Blob bodies are reported by size only. */
  const bodyOf = (body: unknown): { bodyText?: string; bodyBytes?: number } => {
    try {
      if (body === undefined || body === null) return {};
      if (typeof body === "string") return { bodyText: body.slice(0, MAX_BODY), bodyBytes: body.length };
      if (body instanceof URLSearchParams) {
        const text = body.toString();
        return { bodyText: text.slice(0, MAX_BODY), bodyBytes: text.length };
      }
      if (typeof FormData !== "undefined" && body instanceof FormData) {
        const parts: string[] = [];
        body.forEach((v, k) => parts.push(`${encodeURIComponent(k)}=${typeof v === "string" ? encodeURIComponent(v) : "[file]"}`));
        const text = parts.join("&");
        return { bodyText: text.slice(0, MAX_BODY), bodyBytes: text.length };
      }
      if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
        const bytes =
          body instanceof ArrayBuffer ? new Uint8Array(body) : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
        return { bodyText: new TextDecoder().decode(bytes.subarray(0, MAX_BODY * 3)).slice(0, MAX_BODY), bodyBytes: bytes.byteLength };
      }
      if (typeof Blob !== "undefined" && body instanceof Blob) return { bodyBytes: body.size };
    } catch {
      /* ignore */
    }
    return {};
  };
  const absolute = (u: unknown): string | undefined => {
    try {
      const raw = u instanceof URL ? u.href : typeof u === "string" ? u : (u as { url?: unknown } | null)?.url;
      return typeof raw === "string" ? new URL(raw, location.href).href : undefined;
    } catch {
      return undefined;
    }
  };

  const wrap = <T extends object>(target: T, handler: ProxyHandler<T>): T => new Proxy(target, handler);

  try {
    // fetch
    const nativeFetch = window.fetch;
    window.fetch = wrap(nativeFetch, {
      apply(target, thisArg, args: [RequestInfo | URL, RequestInit?]) {
        try {
          const [input, init] = args;
          const url = absolute(input);
          if (url) {
            const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
            report({ kind: "network", url, method, resourceType: "xmlhttprequest", ...bodyOf(init?.body) });
          }
        } catch {
          /* ignore */
        }
        return Reflect.apply(target, thisArg, args);
      },
    });

    // XMLHttpRequest
    const meta = new WeakMap<XMLHttpRequest, { method: string; url?: string | undefined }>();
    const proto = XMLHttpRequest.prototype;
    proto.open = wrap(proto.open, {
      apply(target, thisArg: XMLHttpRequest, args: unknown[]) {
        try {
          meta.set(thisArg, { method: String(args[0] ?? "GET").toUpperCase(), url: absolute(args[1]) });
        } catch {
          /* ignore */
        }
        return Reflect.apply(target, thisArg, args);
      },
    }) as typeof proto.open;
    proto.send = wrap(proto.send, {
      apply(target, thisArg: XMLHttpRequest, args: [Document | XMLHttpRequestBodyInit | null | undefined]) {
        try {
          const m = meta.get(thisArg);
          if (m?.url) report({ kind: "network", url: m.url, method: m.method, resourceType: "xmlhttprequest", ...bodyOf(args[0]) });
        } catch {
          /* ignore */
        }
        return Reflect.apply(target, thisArg, args);
      },
    });

    // sendBeacon
    if (typeof navigator.sendBeacon === "function") {
      navigator.sendBeacon = wrap(navigator.sendBeacon, {
        apply(target, thisArg, args: [string | URL, BodyInit?]) {
          try {
            const url = absolute(args[0]);
            if (url) report({ kind: "network", url, method: "POST", resourceType: "ping", ...bodyOf(args[1]) });
          } catch {
            /* ignore */
          }
          return Reflect.apply(target, thisArg, args);
        },
      });
    }

    // WebSocket: the handshake and every message sent
    const NativeWS = window.WebSocket;
    window.WebSocket = wrap(NativeWS, {
      construct(target, args: [string | URL, (string | string[])?], newTarget) {
        try {
          const url = absolute(args[0]);
          if (url) report({ kind: "network", url: url.replace(/^http/, "ws"), method: "GET", resourceType: "websocket" });
        } catch {
          /* ignore */
        }
        return Reflect.construct(target, args, newTarget);
      },
    });
    NativeWS.prototype.send = wrap(NativeWS.prototype.send, {
      apply(target, thisArg: WebSocket, args: [string | ArrayBufferLike | Blob | ArrayBufferView]) {
        try {
          report({ kind: "network", url: thisArg.url, method: "SEND", resourceType: "websocket", ...bodyOf(args[0]) });
        } catch {
          /* ignore */
        }
        return Reflect.apply(target, thisArg, args);
      },
    });
  } catch {
    /* hooks are best effort; the page must keep working */
  }
})();
