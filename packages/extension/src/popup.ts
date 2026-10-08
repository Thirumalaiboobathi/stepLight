import { SERVER_URL, type ExtensionMessage, type StatusReply } from "./messages.js";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function ask(message: ExtensionMessage): Promise<StatusReply> {
  return chrome.runtime.sendMessage(message) as Promise<StatusReply>;
}

function render(status: StatusReply): void {
  const toggle = $<HTMLButtonElement>("toggle");
  const task = $<HTMLInputElement>("task");
  toggle.textContent = status.recording ? "Stop recording" : "Start recording";
  toggle.className = status.recording ? "stop" : "start";
  task.disabled = status.recording;
  if (status.recording && status.task) task.value = status.task;
  $("state").textContent = status.recording
    ? `● Recording · ${status.steps} steps`
    : "Not recording";
  $("error").textContent = status.error
    ? `${status.error} — is "steplight view" running on ${SERVER_URL}?`
    : "";
}

async function refresh(): Promise<void> {
  try {
    render(await ask({ type: "status" }));
  } catch (err) {
    $("error").textContent = String(err);
  }
}

async function toggle(): Promise<void> {
  const current = await ask({ type: "status" });
  if (current.recording) {
    render(await ask({ type: "stop" }));
    return;
  }
  // Must run in this click handler (user gesture). Optional: without it only the current page is recorded.
  await chrome.permissions.request({ origins: ["<all_urls>"] }).catch(() => false);
  render(await ask({ type: "start", task: $<HTMLInputElement>("task").value }));
}

$("toggle").addEventListener("click", () => void toggle());
$<HTMLAnchorElement>("viewer").href = SERVER_URL;
void refresh();
setInterval(() => void refresh(), 1500);
