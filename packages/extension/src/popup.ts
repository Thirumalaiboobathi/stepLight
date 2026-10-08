import { SERVER_URL, type ExtensionMessage, type StatusReply } from "./messages.js";

let viewerUrl = chrome.runtime.getURL("viewer.html");

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
  const connected = status.mode === "connected";
  const badge = $("mode");
  badge.textContent = connected ? "Connected to CLI" : "Standalone";
  badge.className = connected ? "mode connected" : "mode standalone";
  badge.title = connected
    ? "Steps are sent to the Steplight CLI server on localhost:4777."
    : "No CLI server found. Runs are stored inside the extension and viewed in the bundled viewer.";
  viewerUrl = connected ? SERVER_URL : chrome.runtime.getURL("viewer.html");
  $("error").textContent = status.error
    ? status.error
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
$("viewer").addEventListener("click", (e) => {
  e.preventDefault();
  void chrome.tabs.create({ url: viewerUrl });
});
void refresh();
setInterval(() => void refresh(), 1500);
