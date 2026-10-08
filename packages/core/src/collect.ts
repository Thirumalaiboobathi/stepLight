/* eslint-disable @typescript-eslint/no-explicit-any */
import type { DomInfo } from "./detectors/hiddenInstruction.js";

/** Result of scanning a page: all text (hidden included) plus per-node styling facts. */
export interface PageScan {
  url: string;
  title: string;
  /** Every text run on the page, including invisible ones, one per line. */
  text: string;
  dom: DomInfo;
}

/**
 * Scan the current document. MUST stay fully self-contained (no imports or outer
 * references) because Playwright serialises it with `toString()` and runs it in the page;
 * the Chrome extension content script calls it directly.
 * @example const scan = await page.evaluate(collectPageScan)
 */
export function collectPageScan(): PageScan {
  const doc: any = (globalThis as any).document;
  const win: any = globalThis;
  const MAX_NODES = 1500;
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "TITLE", "META", "LINK"]);
  const nodes: any[] = [];
  const lines: string[] = [];
  const perElement = new Map<any, string>();
  const order: any[] = [];

  // Text that is not rendered but is still read by agents working on raw HTML / the a11y tree.
  const extras: { text: string; source: "comment" | "attribute"; label: string }[] = [];

  const walker = doc.createTreeWalker(doc.documentElement, 132 /* SHOW_TEXT | SHOW_COMMENT */);
  let n: any;
  while ((n = walker.nextNode())) {
    const t = String(n.nodeValue ?? "").replace(/\s+/g, " ").trim();
    if (!t) continue;
    if (n.nodeType === 8) {
      if (t.length >= 8) extras.push({ text: t, source: "comment", label: "comment" });
      continue;
    }
    const el = n.parentElement;
    if (!el || SKIP.has(el.tagName)) continue;
    const prev = perElement.get(el) as string | undefined;
    if (prev === undefined) order.push(el);
    perElement.set(el, prev === undefined ? t : `${prev} ${t}`);
  }

  const bgOf = (el: any): string => {
    for (let e = el; e; e = e.parentElement) {
      const bg = win.getComputedStyle(e).backgroundColor as string;
      const m = /rgba?\((\d+)[ ,]+(\d+)[ ,]+(\d+)(?:[ ,/]+([\d.]+))?/.exec(bg);
      if (m && (m[4] === undefined || parseFloat(m[4]) > 0.5)) return bg;
    }
    return "rgb(255, 255, 255)";
  };

  for (const el of order) {
    if (nodes.length >= MAX_NODES) break;
    const text = perElement.get(el) as string;
    lines.push(text);
    const cs = win.getComputedStyle(el);
    let display = cs.display as string;
    const visibility = cs.visibility as string;
    let opacity = 1;
    let ariaHidden = false;
    let hiddenAttr = false;
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const s = win.getComputedStyle(e);
      if (s.display === "none") display = "none";
      opacity *= parseFloat(s.opacity);
      if (e.getAttribute("aria-hidden") === "true") ariaHidden = true;
      if (e.hasAttribute("hidden")) hiddenAttr = true;
    }
    const r = el.getBoundingClientRect();
    nodes.push({
      text,
      display,
      visibility,
      opacity,
      fontSizePx: parseFloat(cs.fontSize),
      rect: {
        x: r.x + (win.scrollX ?? 0),
        y: r.y + (win.scrollY ?? 0),
        width: r.width,
        height: r.height,
      },
      color: cs.color,
      backgroundColor: bgOf(el),
      ariaHidden,
      hiddenAttr,
    });
  }

  for (const el of Array.from(doc.querySelectorAll("[aria-label],[alt]")) as any[]) {
    for (const attr of ["aria-label", "alt"]) {
      const v = String(el.getAttribute(attr) ?? "").replace(/\s+/g, " ").trim();
      if (v.length >= 8) extras.push({ text: v, source: "attribute", label: attr });
    }
  }
  for (const e of extras) {
    if (nodes.length >= MAX_NODES) break;
    lines.push(`[${e.label}] ${e.text}`);
    nodes.push({ text: e.text, source: e.source });
  }

  return {
    url: String(win.location.href),
    title: String(doc.title ?? ""),
    text: lines.join("\n"),
    dom: { url: String(win.location.href), nodes },
  };
}
