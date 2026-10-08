# Chrome Web Store listing: Steplight

Copy-paste material for the Chrome Web Store developer dashboard. Every claim here matches what the extension does today;
keep it that way when features change (the tests in `packages/extension` check the permission list).

## Name

Steplight: replay and trace your AI agent

## Short description (≤ 132 characters)

Record, replay and flag every step an AI browser agent takes: hidden prompt injections and data sent to unknown sites. 100% local.

## Full description

Steplight is a flight recorder for AI agents that drive a web browser.

When an agent (Browser Use, a Playwright/CDP script, an LLM with browser tools) works in your browser, Steplight records what it does, step by step: pages it read, links it clicked, forms it submitted, and the background requests the page made. It then replays the run in a clear timeline and flags suspicious moments:

• Hidden prompt injections: text a human cannot see (display:none, white-on-white, off-screen, tiny font, zero-width characters…), including text that appears after a script or a single-page-app route change, that tries to give the agent new orders, such as "always select the Premium option".
• Data leaving to other domains: form submissions or background requests (fetch, XHR, beacons, tracking pixels, WebSockets) that carry text copied from an earlier page to a different site.
• Sensitive data in requests, including in URL query strings: emails, card numbers, API keys, tokens.
• Beacons to unknown domains right after a page with hidden instructions, and suspicious redirects.
• Agents stuck in a loop.

For each flagged step you can see which earlier page most likely caused it ("caused by"), the page text with the hidden text highlighted, and the request that was sent. Compare two runs, export a self-contained HTML report, or copy a Playwright test that replays the run.

You decide how much is kept: Minimal (URLs without query strings, step kinds and flags only), Standard (default; adds redacted page text and request metadata) or Full (adds redacted request body previews). Password, card, one-time-code and similar fields are never read. You can deny sites (banks, health portals, password managers; suggested on first run), see a "REC" badge while recording, set automatic deletion (default 7 days) and delete everything with one button. Stored runs are encrypted with AES-256-GCM, and exports can be password-protected.

Works on its own: runs are stored inside the extension and viewed in the built-in viewer. Developers can optionally pair the open-source Steplight CLI (localhost only) to keep runs as files, export OpenTelemetry traces, and run checks in CI. Organisations can restrict the extension with Chrome Enterprise policy.

PRIVACY: everything stays on your device. Steplight has no servers, no accounts, no analytics, no remote code. Recording starts only when you press Start and stops when you press Stop. Secrets are redacted before anything is stored. Redaction is pattern-based and does not recognise free text such as names or addresses; use the Minimal level or the site deny list for anything that must never be stored.

Open source (Apache-2.0). Security policy and threat model are in the repository.

## Single-purpose statement

Steplight has a single purpose: to record the actions an automated (AI) agent performs in the browser and show them in a local replay viewer, flagging suspicious behaviour such as hidden prompt injections and data sent to other domains.

## Permission justifications (one line each)

| Permission | Justification |
|---|---|
| `activeTab` | Lets the extension inject its recorder into the tab the user is on when they press Start, without install-time access to any site. |
| `scripting` | Injects and registers the content script that observes clicks, form submits and page text while recording (and, only if the user turns on "Deep capture", the page hook for fetch / XHR / beacon / WebSocket). |
| `storage` | Stores recorded runs (encrypted), the user's privacy settings and the audit log locally, and keeps the in-progress session across service-worker restarts; never synced. Also reads the organisation policy (managed storage), if an administrator set one. |
| `webRequest` | Observes (never blocks or modifies) the background requests of the tab being recorded, to detect data leaving the page through fetch, XHR, beacons, images and WebSockets. Used only while recording; request headers are not requested, and from responses only `content-type` and `content-length` are read. |
| `webNavigation` | Detects single-page-app route changes (`history.pushState`, `#fragment`) and page commits in the recorded tab, so pages that change without a reload are re-read and recorded, and so site rules apply to the page that made a request. |
| Host permission `http://localhost:4777/*` | Sends recorded steps to the user's own Steplight CLI server on localhost, only if the user pasted its pairing link. No other host is contacted. |
| Optional host permission `<all_urls>` | Requested only when the user presses Start, so the recorder (and `webRequest`) can follow the agent across the sites it visits; the user can decline (the current page is recorded) or revoke it at any time. Sites the user denies are never read. |

No remote code is loaded or executed (no `eval`, no CDN, no remote scripts). All code ships in the package. The extension's
content security policy allows connections only to the extension itself and `localhost:4777`.

## Data use disclosure (Privacy practices tab)

**Does the extension collect or transmit user data?** No user data is transmitted off the device or sent to the developer. Data below is *processed and stored locally* only (encrypted), and only during a recording the user starts.

Data types handled locally while recording (declare these if the form asks about local handling; none is transmitted):

| Category | Handled? | Notes |
|---|---|---|
| Personally identifiable information | Possibly, locally | Page text can contain personal data. Emails, phone numbers, cards, IDs and keys are redacted by pattern before storage; names and addresses are not recognised. The Minimal level stores no page text. |
| Health / financial / authentication information | No (by design) | Password, card, one-time-code and similar fields are never read; secrets are redacted; sites can be denied. |
| Personal communications | No | |
| Location | No | |
| Web history | Yes, locally | URLs of pages visited during a recording (query strings removed at the Minimal level). |
| User activity | Yes, locally | Clicks, which field changed (never its value), form submissions and background requests during a recording. |
| Website content | Yes, locally | Text of pages visited during a recording (not stored at the Minimal level). |

**Certifications (all true):**
- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes unrelated to the item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:** link to `PRIVACY.md` in the public repository.

## Assets checklist

- [x] Icons 16/32/48/128 px (in the package)
- [ ] At least one 1280×800 screenshot: the viewer showing the flight-booking run with the hidden-text flag
- [ ] A second screenshot: Privacy settings page (capture levels, deny list) and one of a flagged network request
- [ ] Small promo tile 440×280 (optional)
- [x] ZIP: `pnpm --filter @steplight/extension package` → `packages/extension/steplight-extension-<version>.zip`
