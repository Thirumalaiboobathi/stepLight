import { createBundle, parseBundle, type RunBundle } from "./bundle.js";
import { decryptWithPassword, encryptWithPassword, isPasswordProtected, type PasswordProtectedExport } from "./crypto.js";
import { sha256Base64 } from "./hash.js";
import { renderHtmlReport, reportInlineSources, type HtmlReportOptions } from "./htmlReport.js";
import { stripQuery } from "./network.js";

/** What the person chose to leave out of (or protect in) an export. */
export interface ExportOptions {
  /** Leave out all page snapshot text. */
  stripSnapshots?: boolean;
  /** Leave out request body previews. */
  stripBodies?: boolean;
  /** Remove query strings and fragments from every URL. */
  stripQueryStrings?: boolean;
  /** Encrypt the file with this password (AES-256-GCM, key from PBKDF2-SHA256). */
  password?: string;
}

/** Exactly what an export will contain, for the pre-export dialog. */
export interface ExportSummary {
  task: string;
  steps: number;
  flags: number;
  snapshots: number;
  snapshotChars: number;
  bodies: number;
  /** URLs that carry a query string or fragment. */
  urlsWithQuery: number;
  encrypted: boolean;
}

/**
 * Apply the export choices to a bundle (a copy; everything is redacted again). Query strings are
 * removed from step URLs, request URLs and the URLs inside flags' text are left as they are
 * because they were already redacted.
 * @example const lean = applyExportOptions(bundle, { stripSnapshots: true })
 */
export function applyExportOptions(bundle: RunBundle, options: ExportOptions): RunBundle {
  const run = {
    ...bundle.run,
    steps: bundle.run.steps.map((s) => {
      const step = { ...s };
      if (options.stripSnapshots) delete step.snapshotRef;
      if (step.request) {
        step.request = { ...step.request };
        if (options.stripBodies) delete step.request.bodyPreview;
        if (options.stripQueryStrings) step.request.url = stripQuery(step.request.url);
      }
      if (options.stripQueryStrings && step.url) step.url = stripQuery(step.url);
      return step;
    }),
  };
  return createBundle(run, options.stripSnapshots ? {} : bundle.snapshots);
}

/**
 * Describe what an export would contain after the given options, so the dialog can list it.
 * @example summarizeExport(bundle, { stripBodies: true }).bodies // 0
 */
export function summarizeExport(bundle: RunBundle, options: ExportOptions = {}): ExportSummary {
  const applied = applyExportOptions(bundle, options);
  const steps = applied.run.steps;
  const snaps = Object.values(applied.snapshots);
  return {
    task: applied.run.task,
    steps: steps.length,
    flags: steps.reduce((n, s) => n + s.flags.length, 0),
    snapshots: snaps.length,
    snapshotChars: snaps.reduce((n, t) => n + t.length, 0),
    bodies: steps.filter((s) => s.request?.bodyPreview).length,
    urlsWithQuery: steps.reduce((n, s) => n + [s.url, s.request?.url].filter((u) => u && /[?#]/.test(u)).length, 0),
    encrypted: Boolean(options.password),
  };
}

/**
 * The JSON text of an export: a plain run bundle, or, with a password, a password-protected file.
 * @example const text = await packageJsonExport(bundle, { password: "…" })
 */
export async function packageJsonExport(bundle: RunBundle, options: ExportOptions = {}): Promise<string> {
  const json = JSON.stringify(applyExportOptions(bundle, options), null, 2);
  if (!options.password) return json;
  return JSON.stringify(await encryptWithPassword(json, options.password, "run-json"));
}

/**
 * The HTML text of an export: the self-contained report, or, with a password, a small decrypt
 * page that holds the encrypted report and shows it after the password is entered.
 */
export async function packageHtmlExport(
  bundle: RunBundle,
  options: ExportOptions = {},
  report: HtmlReportOptions = {},
): Promise<string> {
  const compare = report.compare ? applyExportOptions(report.compare, options) : undefined;
  const html = renderHtmlReport(applyExportOptions(bundle, options), compare ? { compare } : {});
  if (!options.password) return html;
  return wrapEncryptedReport(await encryptWithPassword(html, options.password, "report-html"));
}

/**
 * Open a password-protected export (either kind) and return the plain text inside.
 * @throws "Wrong password or damaged file"
 */
export async function openProtectedExport(text: string, password: string): Promise<{ kind: PasswordProtectedExport["kind"]; text: string }> {
  let file: unknown;
  try {
    file = JSON.parse(text);
  } catch {
    file = extractPayload(text);
  }
  if (!isPasswordProtected(file)) throw new Error("This is not a password-protected Steplight export");
  return { kind: file.kind, text: await decryptWithPassword(file, password) };
}

/** Parse a password-protected run file straight to a bundle. */
export async function openProtectedBundle(text: string, password: string): Promise<RunBundle> {
  const { kind, text: inner } = await openProtectedExport(text, password);
  if (kind !== "run-json") throw new Error("This file is an encrypted report, not a run file you can import");
  return parseBundle(inner);
}

/* ------------------------------------------------------------------ the decrypt page */

const PAGE_STYLE =
  "body{margin:0;font:15px/1.5 system-ui,sans-serif;background:#0b1020;color:#e2e8f0}main{max-width:420px;margin:12vh auto;padding:0 1rem}" +
  "input,button{font:inherit;padding:.5rem .7rem;border-radius:6px;border:1px solid #475569;width:100%;box-sizing:border-box;margin-top:.5rem}" +
  "button{background:#6366f1;color:#fff;border:0;cursor:pointer}#err{color:#fca5a5;min-height:1.5em}iframe{position:fixed;inset:0;width:100%;height:100%;border:0;background:#fff}[hidden]{display:none}";

/** The decrypt page's own script. Mirrors `decryptWithPassword` in crypto.ts (PBKDF2-SHA256 → AES-256-GCM). */
const PAGE_SCRIPT = `(function(){
var d=JSON.parse(document.getElementById("payload").textContent);
var form=document.getElementById("f"),err=document.getElementById("err"),pw=document.getElementById("pw");
function b(s){var x=atob(s),o=new Uint8Array(x.length);for(var i=0;i<x.length;i++)o[i]=x.charCodeAt(i);return o;}
form.addEventListener("submit",function(e){
  e.preventDefault();err.textContent="";
  if(!(window.crypto&&crypto.subtle)){err.textContent="This page needs a secure context: open the file from disk (file://) in a current browser.";return;}
  var te=new TextEncoder();
  crypto.subtle.importKey("raw",te.encode(pw.value),"PBKDF2",false,["deriveKey"]).then(function(base){
    return crypto.subtle.deriveKey({name:"PBKDF2",hash:"SHA-256",salt:b(d.salt),iterations:d.iterations},base,{name:"AES-GCM",length:256},false,["decrypt"]);
  }).then(function(key){
    return crypto.subtle.decrypt({name:"AES-GCM",iv:b(d.iv),additionalData:te.encode("steplight:"+d.kind)},key,b(d.ct));
  }).then(function(plain){
    var html=new TextDecoder().decode(plain);
    var f=document.getElementById("view");
    f.src=URL.createObjectURL(new Blob([html],{type:"text/html"}));
    f.hidden=false;document.getElementById("gate").hidden=true;
  }).catch(function(){err.textContent="Wrong password or damaged file.";});
});
})();`;

/** Wrap an encrypted report in a small self-contained page that asks for the password. */
export function wrapEncryptedReport(file: PasswordProtectedExport): string {
  const inner = reportInlineSources();
  const csp = [
    "default-src 'none'",
    `style-src 'sha256-${sha256Base64(PAGE_STYLE)}' 'sha256-${sha256Base64(inner.style)}'`,
    `script-src 'sha256-${sha256Base64(PAGE_SCRIPT)}' 'sha256-${sha256Base64(inner.script)}'`,
    "frame-src blob:",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  // The payload is JSON of base64 text, so it cannot contain "<": it is safe inside a data block.
  const payload = JSON.stringify(file).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<title>Encrypted Steplight report</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<main id="gate">
<h1>Encrypted Steplight report</h1>
<p>This report is encrypted. Enter the password you were given. Nothing is sent anywhere: decryption happens in this page.</p>
<form id="f"><input id="pw" type="password" autocomplete="off" placeholder="Password" aria-label="Password" /><button type="submit">Open report</button></form>
<p id="err" role="alert"></p>
</main>
<iframe id="view" sandbox="allow-scripts" title="Steplight report" hidden></iframe>
<script type="application/json" id="payload">${payload}</script>
<script>${PAGE_SCRIPT}</script>
</body>
</html>
`;
}

/** Pull the JSON payload back out of a decrypt page (used by the CLI `decrypt` command). */
function extractPayload(html: string): unknown {
  const m = /<script type="application\/json" id="payload">([\s\S]*?)<\/script>/.exec(html);
  return m ? JSON.parse(m[1]!) : undefined;
}
