# Privacy

**Steplight processes everything on your device. No data leaves your computer.**

This covers the Steplight Chrome extension, the SDK and the CLI. Steplight has no servers, no accounts, no analytics and no
telemetry. It loads no remote code and uses no CDN. The code makes no network requests except to `localhost` (your own
`steplight view` process) and, if you choose to export traces, to an OpenTelemetry collector *you* configure.

Steplight records what an AI agent does in a browser so that you can review it. That is sensitive by nature, so it is built
to keep as little as possible, to protect what it keeps, and to delete it on a schedule. The details are below.
(For the security design see [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md); for organisations, [docs/enterprise.md](docs/enterprise.md).)

## You choose how much is kept: three capture levels

Recording only happens after you press **Start recording** (extension) or call `record()` (SDK). Detectors always look at the
full data **in memory** first; what is *written down* depends on the level in **Privacy settings**. The default is **Standard**.

| | Minimal | **Standard** (default) | Full |
|---|---|---|---|
| Step kinds (navigate, click, form submit, …) and flags | ✅ | ✅ | ✅ |
| URLs | ✅ without query strings or fragments | ✅ (secret-looking parameters redacted) | ✅ (same) |
| Page text snapshots | ❌ | ✅ redacted | ✅ redacted |
| Click / field labels, error text | ❌ | ✅ redacted | ✅ redacted |
| Background requests (fetch, XHR, beacons, images, WebSocket) | method + URL only | + type, status, timing, sizes, `content-type` | + |
| Request body previews | ❌ | ❌ (size only) | ✅ redacted, ≤ 2 KB |
| Short evidence excerpts inside flags | ✅ redacted | ✅ redacted | ✅ redacted |

## Never captured, whatever you choose

These rules are always on and cannot be switched off:

- **Password fields**, fields with `autocomplete` of `cc-*`, `one-time-code`, `current-password` or `new-password`, and fields whose
  name, id, label or placeholder looks like card / CVV / OTP / PIN / SSN / Aadhaar / PAN / password / token / secret.
  Their values are never read, and they are left out of form bodies entirely.
- Anything editable inside a payment provider's frame (Stripe, PayPal, Razorpay, Adyen, …).
- What you type into other fields: only *which* field changed is recorded, not the value.
- Request and response **headers**, except `content-type` and `content-length` of responses. Cookies, `Authorization`, API-key
  and session headers are never read.
- Anything while recording is stopped, and anything on a site you have denied.

## Redaction

Secrets are replaced by `[REDACTED:<kind>]` **inside the page's content script, before data crosses into the extension**, again
before storage, and again on export. Recognised: emails, phone numbers (international and Indian), payment cards (Luhn), IBAN,
US SSN, Aadhaar (checksum), PAN, JWTs, AWS / GitHub / OpenAI / Anthropic / Slack / Stripe / Google / npm keys, private key blocks,
bearer and basic credentials, `password=` style pairs, secret-looking URL parameters (`token`, `key`, `code`, `session`, `auth`,
`sig`, `password`), values hidden in URL-encoding, JSON/HTML escapes or base64, and any patterns you add in settings. If
redaction fails for any reason, the data is dropped rather than stored.

Redaction is pattern-based. It does **not** recognise free-text personal data such as names or addresses. Use the Minimal level,
the site deny list or your own patterns for anything that must never be stored.

## Network capture

While recording, the extension observes background requests of the tab you recorded (never blocking or changing them) so it can
flag data leaving the page, for example an email sent to another domain by `fetch`, a beacon, a tracking pixel or a WebSocket.
Request bodies are inspected in memory and, at the Standard level, **not stored**. "Deep capture" (off by default, labelled in
settings) additionally hooks the page's own `fetch`, `XMLHttpRequest`, `sendBeacon` and `WebSocket` to see payloads before
they are encoded; it needs access to all sites and a hostile page can notice it.

## Sites

You can deny sites (nothing is read, redacted or stored there: the popup says "Recording paused on this site") or allow only
certain sites. On first run Steplight offers to add a suggested deny list of banking, health and password-manager sites; it
never does so without asking. While recording, the toolbar icon shows **REC** and (optionally) a small badge appears in the
corner of recorded pages, so nobody is recorded unknowingly.

## Where data is stored, and how it is protected

| Mode | Location | Protection |
|---|---|---|
| **Standalone** (extension, no CLI) | `chrome.storage.local`, capped (default 8 MB, oldest runs removed first) | every record encrypted with **AES-256-GCM**, fresh IV each, key kept as a non-extractable key in the extension's IndexedDB |
| **Connected** (CLI running, paired) | `.steplight/runs/` in the folder where `steplight view` runs | local server on `127.0.0.1` with a random token; files owner-only (0600) on macOS/Linux; **optional AES-256-GCM** (`STEPLIGHT_ENCRYPTION_KEY` or a passphrase) |
| **SDK** | `.steplight/runs/` (or your `dir`) | same as the CLI |

The encryption protects stored data from backups, file scanners and other users. The key lives in the same browser profile, so
it does **not** protect against malware running as you or someone who can open your browser profile. On Windows the owner-only file
mode does not exist; run folders inherit the folder's permissions. In-progress session state lives in `chrome.storage.session`
(memory only). Data is never synced to your Google account and never uploaded anywhere.

## Retention and deleting your data

- **Automatic:** the extension deletes runs older than **7 days** by default (change it in settings; 0 keeps them). The CLI and SDK
  never delete on their own; `steplight view --retention-days N` or a policy does.
- **Delete everything:** *Privacy settings → Delete all Steplight data*, or **Delete all data** in the viewer (extension: all runs,
  pairing and any recording in progress; CLI viewer: all runs in the folder).
- **CLI:** `steplight purge --older-than-days 7`, `steplight purge --all --yes`, `steplight clear [--keep N]`. These remove run
  folders including snapshots. Removing a file does not overwrite its bytes on disk; use encryption (and disk encryption) if that matters.
- Removing the extension deletes all of its storage.

## Audit log

Steplight keeps a local, tamper-evident log of its own actions (recording started/stopped, exports, deletions, settings and
policy changes). It contains no page content, URLs or task titles. See *Privacy settings → Audit log* and `steplight audit`.

## Sharing and exports

Exporting a run (JSON or HTML report) creates a file on your disk; nothing is uploaded. Before any export a dialog lists what
the file will contain (task title, steps, flags, page snapshots, request bodies, URLs with query strings) and lets you leave out
snapshots, bodies and query strings. You can protect the file with a password (AES-256-GCM, key derived with PBKDF2-SHA256);
a forgotten password cannot be recovered. Everything is redacted again at export. Sharing the file is your decision.

## Permissions

The extension requests the minimum it needs; each permission and its purpose is listed in [docs/store-listing.md](docs/store-listing.md).
Access to all websites is *optional* and requested only when you press Start; you can revoke it at any time in `chrome://extensions`.
Organisations can restrict the extension further with Chrome Enterprise policy.

## Contact

Report privacy or security problems privately: see [SECURITY.md](SECURITY.md). Other questions: open an issue on the project repository.
