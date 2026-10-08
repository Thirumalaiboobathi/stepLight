# Chrome Web Store listing: Steplight

Copy-paste material for the Chrome Web Store developer dashboard.

## Name

Steplight: replay and trace your AI agent

## Short description (≤ 132 characters)

Record, replay and flag every step an AI browser agent takes: hidden prompt injections and data sent to unknown sites. 100% local.

## Full description

Steplight is a flight recorder for AI agents that drive a web browser.

When an agent (Browser Use, a Playwright/CDP script, an LLM with browser tools) works in your browser, Steplight records what it does, step by step: pages it read, links it clicked, forms it submitted. It then replays the run in a clear timeline and flags suspicious moments:

• Hidden prompt injections: text a human cannot see (display:none, white-on-white, off-screen, tiny font…) that tries to give the agent new orders, such as "always select the Premium option".
• Data leaving to other domains: form submissions or requests that carry data copied from an earlier page to a different site.
• Sensitive data in outbound requests: emails, card numbers, API keys and tokens.
• Suspicious redirects right after reading a page with hidden instructions.

For each flagged step you can see which earlier page most likely caused it ("caused by"), the page text the agent could read with the hidden text highlighted, and the request that was sent.

Works on its own: runs are stored inside the extension and viewed in the built-in viewer. Developers can optionally connect the open-source Steplight CLI (localhost) to keep runs as files, export OpenTelemetry traces, and run checks in CI.

PRIVACY: everything stays on your device. Steplight has no servers, no accounts, no analytics. Typed values and passwords are never recorded, and emails, card numbers and API keys are redacted before anything is stored. Recording starts only when you press Start and stops when you press Stop.

Open source (Apache-2.0).

## Single-purpose statement

Steplight has a single purpose: to record the actions an automated (AI) agent performs in the browser and show them in a local replay viewer, flagging suspicious behaviour such as hidden prompt injections and data sent to other domains.

## Permission justifications (one line each)

| Permission | Justification |
|---|---|
| `activeTab` | Lets the extension inject its recorder into the tab the user is on when they press Start, without install-time access to any site. |
| `scripting` | Injects and registers the content script that observes clicks, form submits and page text while recording. |
| `storage` | Stores recorded runs locally (standalone mode) and keeps the in-progress session alive across service-worker restarts; never synced. |
| Host permission `http://localhost:4777/*` | Sends recorded steps to the user's own Steplight CLI server on localhost, if one is running. No other host is contacted. |
| Optional host permission `<all_urls>` | Requested only when the user presses Start, so the recorder can follow the agent across the sites it visits; the user can decline (the current page is recorded) or revoke it at any time. |

No remote code is loaded or executed. All code ships in the package.

## Data use disclosure (Privacy practices tab)

**Does the extension collect or transmit user data?** No user data is transmitted off the device or sent to the developer. Data below is *processed and stored locally* only, and only during a recording the user starts.

Data types handled locally while recording (tick only if the form requires declaring local handling; none is transmitted):

| Category | Handled? | Notes |
|---|---|---|
| Personally identifiable information | No | Emails, cards, keys are redacted before storage. |
| Health / financial / authentication information | No | Passwords are never read; secrets are redacted. |
| Personal communications | No | |
| Location | No | |
| Web history | Yes, locally | URLs of pages visited during a recording. |
| User activity | Yes, locally | Clicks and form submissions during a recording. |
| Website content | Yes, locally | Text of pages visited during a recording. |

**Certifications (all true):**
- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes unrelated to the item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:** link to `PRIVACY.md` in the public repository.

## Assets checklist

- [x] Icons 16/32/48/128 px (in the package)
- [ ] At least one 1280×800 screenshot: the viewer showing the flight-booking run with the hidden-text flag
- [ ] Small promo tile 440×280 (optional)
- [x] ZIP: `pnpm --filter @steplight/extension package` → `packages/extension/steplight-extension-<version>.zip`
