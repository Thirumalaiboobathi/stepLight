import {
  SUGGESTED_DENYLIST,
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
