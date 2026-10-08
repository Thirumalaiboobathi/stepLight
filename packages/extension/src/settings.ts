import {
  CAPTURE_LEVELS,
  SUGGESTED_DENYLIST,
  verifyAuditLog,
  type AuditEntry,
  type Policy,
  normalizeDomainList,
  normalizeSettings,
  validatePattern,
  type CaptureLevel,
  type Settings,
} from "@steplight/core";
import type { ExtensionMessage, StatusReply } from "./messages.js";

/* Privacy settings page. Everything is read and written as plain text (no innerHTML). */

const KEY = "sl-settings";
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const lines = (value: string): string[] => value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

/** What the organisation policy locks, as published by the service worker. */
interface PolicyView {
  managed: boolean;
  policy: Policy;
  lockedKeys: string[];
  forcedDenylist: string[];
  forcedPatterns: string[];
}

async function loadPolicyView(): Promise<PolicyView> {
  const stored = await chrome.storage.local.get("sl-policy");
  return (stored["sl-policy"] as PolicyView | undefined) ?? { managed: false, policy: {}, lockedKeys: [], forcedDenylist: [], forcedPatterns: [] };
}

/** Grey out what the administrator controls and say so. */
function applyManaged(view: PolicyView): void {
  $("managedNote").hidden = !view.managed;
  const lock = (el: HTMLInputElement | HTMLTextAreaElement, why: string): void => {
    el.disabled = true;
    el.title = why;
  };
  const why = "Managed by your organization";
  if (view.lockedKeys.includes("deepCapture")) lock($<HTMLInputElement>("deep"), why);
  if (view.lockedKeys.includes("siteAllowlist")) lock($<HTMLTextAreaElement>("allow"), why);
  const max = view.policy.maxCaptureLevel;
  if (max) {
    for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="level"]')) {
      if (CAPTURE_LEVELS.indexOf(radio.value as CaptureLevel) > CAPTURE_LEVELS.indexOf(max)) {
        radio.disabled = true;
        radio.title = `${why}: the highest level allowed is ${max}`;
      }
    }
  }
  if (view.policy.retentionDays) {
    const days = $<HTMLInputElement>("days");
    days.max = String(view.policy.retentionDays);
    days.title = `${why}: at most ${view.policy.retentionDays} days`;
  }
  const forcedDeny = $("forcedDeny");
  forcedDeny.hidden = view.forcedDenylist.length === 0;
  forcedDeny.textContent = view.forcedDenylist.length ? `Also never recorded, required by your organization: ${view.forcedDenylist.join(", ")}` : "";
  const forcedPatterns = $("forcedPatterns");
  forcedPatterns.hidden = view.forcedPatterns.length === 0;
  forcedPatterns.textContent = view.forcedPatterns.length ? `Always redacted, required by your organization: ${view.forcedPatterns.join("  ")}` : "";
  if (view.policy.disableDeepCapture) $<HTMLInputElement>("deep").checked = false;
}

/** Show the audit log and whether its hash chain is intact. */
async function renderAudit(): Promise<void> {
  const stored = await chrome.storage.local.get("sl-audit");
  const log = (stored["sl-audit"] as { entries: AuditEntry[]; anchor: string } | undefined) ?? { entries: [], anchor: "" };
  const result = verifyAuditLog(log.entries, log.entries.length > 0 ? log.anchor || undefined : undefined);
  const status = $("auditStatus");
  status.className = result.ok ? "ok" : "bad";
  status.textContent = result.ok
    ? `${log.entries.length} entries. The hash chain is intact.`
    : `The audit log has been tampered with: ${result.reason} (entry ${result.brokenAt}).`;
  const list = $("auditList");
  list.textContent = "";
  for (const e of log.entries.slice(-50).reverse()) {
    const li = document.createElement("li");
    const detail = Object.entries(e.detail).map(([k, v]) => `${k}=${String(v)}`).join(" ");
    li.textContent = `${new Date(e.ts).toISOString()}  ${e.action}  ${detail}`;
    list.appendChild(li);
  }
  $("auditExport").onclick = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(log, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "steplight-audit-log.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
}

async function load(): Promise<Settings> {
  const stored = await chrome.storage.local.get(KEY);
  return normalizeSettings(stored[KEY]);
}

function fill(s: Settings): void {
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="level"]')) radio.checked = radio.value === s.captureLevel;
  $<HTMLTextAreaElement>("deny").value = s.siteDenylist.join("\n");
  $<HTMLTextAreaElement>("allow").value = s.siteAllowlist.join("\n");
  $<HTMLTextAreaElement>("netallow").value = s.networkAllowlist.join("\n");
  $<HTMLTextAreaElement>("patterns").value = s.customPatterns.join("\n");
  $<HTMLInputElement>("deep").checked = s.deepCapture;
  $<HTMLInputElement>("indicator").checked = s.pageIndicator;
  $<HTMLInputElement>("days").value = String(s.retentionDays);
  $<HTMLInputElement>("maxmb").value = String(s.maxStorageMB);
  $("firstRun").hidden = s.firstRunDone;
}

/** Read the form. Returns the settings and a list of problems (invalid patterns, ignored lines). */
function read(previous: Settings): { settings: Settings; errors: string[]; notes: string[] } {
  const errors: string[] = [];
  const notes: string[] = [];
  const domainList = (id: string, label: string): string[] => {
    const raw = lines($<HTMLTextAreaElement>(id).value);
    const clean = normalizeDomainList(raw);
    const dropped = raw.filter((r) => !clean.includes(r.toLowerCase().replace(/^https?:\/\//, "").replace(/[/:?#].*$/, "")));
    if (dropped.length > 0) notes.push(`${label}: ignored ${dropped.map((d) => JSON.stringify(d)).join(", ")} (not a domain).`);
    return clean;
  };
  const patterns: string[] = [];
  for (const source of lines($<HTMLTextAreaElement>("patterns").value)) {
    const check = validatePattern(source);
    if (check.ok) patterns.push(source);
    else errors.push(`${source.slice(0, 40)}: ${check.reason}`);
  }
  const level = (document.querySelector<HTMLInputElement>('input[name="level"]:checked')?.value ?? "standard") as CaptureLevel;
  const settings = normalizeSettings({
    ...previous,
    captureLevel: level,
    deepCapture: $<HTMLInputElement>("deep").checked,
    pageIndicator: $<HTMLInputElement>("indicator").checked,
    retentionDays: Number($<HTMLInputElement>("days").value),
    maxStorageMB: Number($<HTMLInputElement>("maxmb").value),
    siteDenylist: domainList("deny", "Deny list"),
    siteAllowlist: domainList("allow", "Allow list"),
    networkAllowlist: domainList("netallow", "Trusted domains"),
    customPatterns: patterns,
    firstRunDone: true,
  });
  return { settings, errors, notes };
}

async function main(): Promise<void> {
  let current = await load();
  fill(current);
  const view = await loadPolicyView();
  applyManaged(view);
  void renderAudit();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes["sl-audit"]) void renderAudit();
  });

  $("save").addEventListener("click", () => {
    void (async () => {
      const { settings, errors, notes } = read(current);
      const list = $("patternErrors");
      list.textContent = "";
      for (const e of errors) {
        const li = document.createElement("li");
        li.textContent = e;
        list.appendChild(li);
      }
      if (errors.length > 0) {
        $("saved").textContent = "Not saved: fix the patterns above.";
        return;
      }
      await chrome.storage.local.set({ [KEY]: settings });
      current = settings;
      fill(settings);
      applyManaged(view);
      $("saved").textContent = notes.length > 0 ? `Saved. ${notes.join(" ")}` : "Saved.";
    })();
  });

  const addSuggestions = async (): Promise<void> => {
    const merged = normalizeDomainList([...current.siteDenylist, ...SUGGESTED_DENYLIST]);
    current = { ...current, siteDenylist: merged, firstRunDone: true };
    await chrome.storage.local.set({ [KEY]: current });
    fill(current);
    $("saved").textContent = `Added ${SUGGESTED_DENYLIST.length} suggested sites to the deny list.`;
  };
  $("suggest").addEventListener("click", () => void addSuggestions());
  $("dismissSuggest").addEventListener("click", () => {
    current = { ...current, firstRunDone: true };
    void chrome.storage.local.set({ [KEY]: current }).then(() => ($("firstRun").hidden = true));
  });

  let armed = false;
  $("deleteAll").addEventListener("click", () => {
    const button = $<HTMLButtonElement>("deleteAll");
    if (!armed) {
      armed = true;
      button.textContent = "Click again to delete everything";
      setTimeout(() => {
        armed = false;
        button.textContent = "Delete all Steplight data";
      }, 5000);
      return;
    }
    armed = false;
    button.textContent = "Delete all Steplight data";
    const message: ExtensionMessage = { type: "delete_all" };
    void (chrome.runtime.sendMessage(message) as Promise<StatusReply>).then(() => {
      $("deleted").textContent = "All Steplight data was deleted.";
    });
  });
}

void main();
