# Privacy

**Steplight processes everything on your device. No data leaves your computer.**

This covers the Steplight Chrome extension, the SDK and the CLI. Steplight has no servers, no accounts, no analytics and no telemetry. The code makes no network requests except to `localhost` (and to an OpenTelemetry collector *you* configure, if you choose to export).

## What Steplight records

Only while you (or your script) start a recording:

| Data | Details |
|---|---|
| Pages visited | URL and title of each page the agent loads |
| Page text | A text snapshot of each page, including text that is hidden from view (that is how hidden prompt injections are found). Capped at 200 KB per page (60 KB in extension storage). |
| Actions | Clicks (element selector and visible label), which form field changed, form submissions (method, destination, field names/values) |
| Network requests | SDK only: method, URL and a body preview of fetch/XHR requests (≤ 2 KB) |
| Flags | Findings from the detectors (for example "hidden instruction", "data sent to another domain") with short evidence |

## What Steplight does **not** record

- The values you type into fields. Only *which* field changed is stored.
- Password fields (values are never read).
- Anything while recording is stopped. The extension injects its recorder only after you press **Start recording**.

## Redaction

Before anything is written to disk or extension storage, Steplight replaces emails, card-like numbers (Luhn-valid), API keys (`sk-…`, `AKIA…`, `ghp_…`, …) and JWTs with `[REDACTED:<kind>]`, including when they appear percent-encoded in form bodies. Exported files and HTML reports are redacted again.

Redaction is pattern-based. It does **not** recognise free-text personal data such as names or addresses. Treat recordings as sensitive.

## Where data is stored

| Mode | Location |
|---|---|
| **Standalone** (extension, no CLI running) | The extension's own `chrome.storage.local`, capped at about 8 MB. When the cap is reached the oldest runs are deleted automatically. The in-progress session state lives in `chrome.storage.session` (memory only, cleared when the browser closes). |
| **Connected** (CLI running) | The extension sends steps to `http://localhost:4777` (your own `steplight view` process), which writes them to `.steplight/runs/` in the folder where you started it. |
| **SDK** | `.steplight/runs/` (or the directory you pass as `dir`). |

Data is never synced to your Google account and never uploaded anywhere.

## How to delete your data

- **Extension (standalone):** open the viewer and remove runs, or remove the extension (this deletes all of its storage). Runs are also evicted automatically when the storage cap is reached.
- **CLI / SDK runs:** `steplight clear` deletes every run in `.steplight/runs`, `steplight clear --keep 5` keeps the newest five. You can also delete the folder.

## Permissions

The extension requests the minimum it needs; each permission and its purpose is listed in [docs/store-listing.md](docs/store-listing.md). Access to all websites is *optional* and requested only when you press Start, and you can revoke it at any time in `chrome://extensions`.

## Sharing

Exporting a run (JSON or HTML report) creates a file on your disk. Sharing it is your decision; review it first.

## Contact

Open an issue on the project repository.
