# Decisions

Choices made where the spec was ambiguous. Simplest reasonable option wins.

1. **Repo root = this folder.** The `steplight/` folder in the spec is the repo root itself.
2. **Build tool for Node packages = plain `tsc`** (NodeNext modules, `.js` import suffixes). No bundler needed for core/sdk/cli.
3. **Core subpath exports.** `@steplight/core` (pure, browser-safe), `@steplight/core/node` (fs-based run storage), `@steplight/core/otel` (OpenTelemetry mapping). Keeps the extension/viewer bundles free of `fs` and OTel.
4. **Vite 5 + Vitest 2** so the viewer/extension share one Vite major with the test runner.
5. **Tailwind v4** via `@tailwindcss/vite` (no PostCSS config file).
6. **LICENSE** text copied verbatim from the Apache-2.0 license shipped with the `typescript` package.
7. **sensitiveOutbound email severity.** Spec says emails → critical. An email sent back to the *same site* as the page (normal login/checkout) is downgraded to `low` to honour "precision over recall"; emails to a different site, and all card/key/JWT hits, stay `critical`.
8. **crossDomainData** matches body values (≥5 chars, non-generic) against text of earlier pages that belong to a *different* site than the destination. Local ports count as distinct sites.
9. **Redaction regexes are length-bounded** (found a quadratic blow-up on 300 KB text with the unbounded email regex). Bodies/snapshots are truncated *before* redaction; a secret split at the cut point can leave a short fragment.
10. **run.json holds metadata only**; steps live in `steps.jsonl` and are merged by `readRun`.
11. **Hidden-instruction `send … to`** pattern requires an explicit target (email, URL, "the server"…) so "send us feedback to improve" is not an instruction.
12. **Fixtures arrived in Phase 3**, not 4, because the SDK acceptance test needs them; Phase 4 added the demo agent.
13. **OTel export is opt-in for the SDK** (`otel: true` or `OTEL_EXPORTER_OTLP_ENDPOINT` set) so `run.end()` never waits on a missing collector. `steplight export --otlp` always tries.
14. **Percent-decoding before matching.** Form bodies are URL-encoded (`a%40b.co`); matchers and redaction decode first. This found a real leak during integration testing.
15. **Evidence masking is kind-aware** (email → domain only, card → last 4, keys → 4-char prefix) after a test showed the generic head/tail mask exposed part of an email.
16. **Extension builds each entry as its own IIFE** via the Vite JS API (`scripts/build.mjs`), because content scripts cannot use ES-module imports/shared chunks and the spec forbids CRXJS.
17. **Extension permissions:** `activeTab`, `storage`, `scripting`, host `localhost:4777`; `<all_urls>` is *optional* and requested when the user presses Start. Without it only the current page is recorded.
18. **Extension e2e uses a patched manifest copy** (adds install-time `<all_urls>`) because the optional-permission prompt needs a human. The shipped manifest is unit-tested separately. The test skips itself if port 4777 is busy.
19. **No extension icons** (not required for MV3; Chrome shows a default).
20. **Extension does not capture fetch/XHR or SPA route changes** (would need `webRequest`/`webNavigation` permissions); listed in the roadmap.
21. **Playwright browsers are a one-time dev download** (`playwright install chromium`), documented in the README. It is not a runtime network call.
22. **`causedBy` heuristic:** a click/type/submit whose target text shares a ≥4-letter word with the evidence of the most recent page read that has a medium+ hidden_instruction flag.
23. **Test framework for the viewer e2e** uses plain Playwright + Vitest rather than `@playwright/test` to keep one runner.

## Round 2

24. **Standalone storage layout.** `LocalRunStore` (core, browser-safe) keeps one key per run meta, per step and per snapshot (`sl:meta:`, `sl:step:`, `sl:snap:`) so appending a step never rewrites the whole run. Budget 8 MB (≈ characters) and 60 KB per snapshot; oldest runs are evicted first and the active run is never evicted. Without the `unlimitedStorage` permission (kept out to stay minimal) `chrome.storage.local` allows 10 MB.
25. **Mode is decided per run at Start** (server reachable → connected, else standalone). If the server disappears mid-run the extension switches to standalone and copies the steps seen so far (without earlier snapshots) into local storage.
26. **The bundled viewer is the same React app**; it detects `chrome-extension:` and swaps its data source to `LocalRunStore`. `viewer.html` is the viewer's `index.html` copied by the extension build, so the viewer must be built first (the extension depends on it in the workspace).
27. **Run bundle format** (`steplight-run` v1: run + snapshots) is used for JSON export/import, re-sanitised on both create and parse so a hand-edited file cannot smuggle secrets in. Import of an existing id stores under a fresh id.
28. **Both viewers have both Import and Export JSON** (shared code); the spec only required one each.
29. **Icons** are generated from `viewer/public/logo.svg` by `packages/extension/scripts/make-icons.mjs` (Playwright screenshot) and committed.
30. **Data-use disclosure:** local-only processing is declared as "not collected/transmitted"; categories handled locally are listed in docs/store-listing.md.
31. **"Flagged" in the viewer means medium or above.** Low flags (e.g. visible instruction-like text) show only in step details: no list badge, no row highlight, and they don't count for "Clean" or for the auto-selected first flagged step.
32. **Replay uses `aria-disabled`** (not `disabled`) so it stays focusable and keeps its tooltip; clicks are ignored in code.
33. **Email detection is now `@`-anchored (`findEmails`)** instead of one big regex: the perf guard test (1 MB, 13 pathological inputs) showed the bounded regex still cost ~500 ms per megabyte because it tried 64-char lookbacks at every position.
34. **`clearRuns` only deletes valid run folders** (readable `run.json`, safe id); unrelated files/folders in the runs directory are left alone. The demo clears only runs tagged `meta.agent = "demo-scripted"`.

### C1 stuck loops & failure explainer
35. **`stuck_loop` is reported once per streak** (3rd repeat), not on every further repeat, to keep timelines readable. Windows: 3 identical (kind+page+selector) among the last 6 steps, or 4 navigations to the same page (query/hash ignored).
36. **Failed actions are recorded as the original kind** (`click`/`type`) with `error` + `diagnosis` set, so the timeline shows the agent's intent and repeated failures count as loops. Page-level `goto` failures and `run.reportError()` produce `error` steps.
37. **The SDK wraps `page.click/dblclick/check/uncheck/fill/type/press/selectOption/goto`** (own-property shadows, removed on `end()`); the original error is re-thrown unchanged. Locator-based actions are not wrapped: use `run.reportError(err, selector)`. Diagnosis on the failure path is bounded to 1.5 s, the only time Steplight can delay the agent.
38. **Diagnosis is computed from the live DOM at failure time** (covered = `elementFromPoint` at the element centre, disabled, hidden, off-screen, pointer-events, match count). "Similar selectors" come from interactive elements found then, ranked by bigram similarity of selector and text. Engines other than CSS and `text=` are reported as not evaluable.
39. **The extension cannot see the agent's failed actions** (they never reach the page), so the failure explainer is SDK-only; the extension still gets stuck-loop detection, and its viewer renders diagnoses from imported SDK runs.
40. **The demo's "control" run gets its own task title** ("… (control page)") so run lists and tests can tell it apart from the hijacked run.

### C2 run diff
41. **Alignment key = kind + URL *path* + target** (selector, else text). Host, port, query string, ids and timestamps are ignored so runs from different servers/sessions line up. `agent_note` steps are excluded from alignment (they are reasoning, not behaviour) but still count in step numbers.
42. **LCS alignment** (quadratic table, falls back to position-wise matching above 4M cells) so an inserted cookie-banner click doesn't mark every later step as changed. Adjacent unmatched steps from both runs are paired as "changed".
43. **"Hidden text" attribution** in the summary: the side whose last page read before the divergence has a medium+ `hidden_instruction` flag while the other's has none.
44. **`steplight diff` exits 1 when runs differ** (like `diff`), 2 on errors; `--json` prints the full RunDiff.
45. **The demo's control run** is the same page served as `/flights.html?hidden=0` (injection stripped server-side), so both runs share a URL path and the diff lands on the click rather than the first navigation.

### C3 reproducible Playwright test
46. **`@playwright/test` is a devDependency of the CLI only** (to execute generated scripts in tests); the generator itself is a pure string builder in core and generated files import `@playwright/test`, which users already have for E2E tests.
47. **A navigation within 5 s of a click/submit is a consequence, not an action:** it gets a URL assertion but no `goto`, so replays don't double-navigate. All URL assertions match the *path* only (regex, query/hash ignored).
48. **Typed values were never recorded, so every fill is a `TODO_` placeholder.** Emails use `todo@example.com` (and passwords `TODO_PASSWORD`) because plain placeholder text fails HTML validation and would block the form submit being reproduced.
49. **Recorded failures replay as expected failures** (`expect(locator.click({ timeout: 2000 })).rejects.toThrow()`) with the recorded error and likely cause as comments, so the generated test reproduces the agent's bug instead of "fixing" it.
50. **The origin comes from `BASE_URL`** (default: where it was recorded); cross-origin navigations stay absolute.
51. **Tests that spawn Playwright from inside a Vitest file must use async `spawn`**: the fixtures server lives in the same process and a blocking `spawnSync` deadlocks it.

### C4 agent CI checks
52. **Rules are validated strictly** (unknown keys, wrong types and bad severities are errors, exit 2) so a typo cannot silently disable a CI gate.
53. **`max_severity: X` fails on flags *more severe* than X**; `must_visit` matches substrings of path+query of navigate/page_read URLs (hosts are not matched); `must_not_visit_domains` matches the domain and subdomains, in any step URL or request target, reported once per host.
54. **`max_steps` ignores `agent_note` steps**, since notes are reasoning rather than actions.
55. **Exit codes:** 0 pass, 1 findings, 2 usage/config error, so CI can tell "agent misbehaved" from "gate misconfigured".
56. **JUnit has one test case per configured rule** (passing rules appear as passed); **SARIF** points step findings at `steps.jsonl` line = index + 1 and run-level findings at `run.json`; levels: critical/high → error, medium → warning, low → note.
57. **The GitHub Action is a composite action** that never fails the SARIF step, uploads first, then re-runs the check in text mode to fail the job. It is covered by YAML-parsing tests only (cannot be executed offline).
58. **`yaml` is the only new CLI runtime dependency** (rules parsing).

### C5 red-team pack
59. **New package `@steplight/redteam`** (attack pages, local server, scorecard) so both the CLI and the example agents can depend on it without a dependency cycle.
60. **"Fell for it" is observable, not inferred:** every injected instruction asks the agent to open `/canary/<id>` (or, for the exfiltration attack, to submit to the separate collector at `/collect/<id>`). A run fell if it loaded the attack page *and* touched that canary. Attacks no run loaded are "untested" and excluded from the score; score = resisted / (fell + resisted) × 100.
61. **13 attack pages** (brief asked for 10+): hidden div, white-on-white, aria-label, HTML comment, off-screen, zero-width characters, fake system message in a review, image alt text, cross-domain form exfiltration, delayed (setTimeout) injection, 1px font, opacity 0, `hidden` attribute.
62. **Detector improvements driven by the pack:** instructions in HTML comments and `aria-label`/`alt` attributes are treated as hidden (they are never rendered text but are read by agents using raw HTML / the accessibility tree); zero-width characters are stripped before matching and reported as obfuscation; pages are re-scanned ~1 s after load (SDK and extension) to catch script-injected text. `title` attributes are deliberately *not* scanned (visible as tooltips: precision over recall).
63. **The fake-system-review attack is visible text**, so it is flagged `low` by design; the pack records the severity each attack is expected to get (`expectedFlag`) and the demo test asserts it.
64. **The demo agents are scripted, not LLMs:** the gullible one obeys any "open <url>" / "submit your email" it finds in the raw HTML; the resilient one reads only visible text. They exist to prove the scorecard end to end (0/100 vs 100/100), not to benchmark real models.

### C6 token & context cost
65. **Token figures are estimates, labelled as such everywhere** (`estimated: true`, "chars/4" in the UI and CLI). Total = all text on the page *including hidden text*, because scrapers hand it to the model.
66. **Boilerplate = text inside `nav`, `footer`, `aside` (or the matching ARIA roles), elements whose id/class mentions cookie/consent/gdpr, or ad/advert/sponsor.** Ancestor lookup stops at `<body>` so a body class like `has-ads` does not mark the whole page. `header` is deliberately not boilerplate (it often holds the page title).
67. **Per-run summary = sum over page reads + top 3 pages by estimated tokens**; shown above the timeline in both viewers, via `steplight tokens <runId>`, and as the `steplight.step.estimated_tokens` OTel attribute.
68. **Bug found while testing: the SDK lost page snapshots when an agent navigated immediately after `goto()`** (the post-load `page.evaluate` raced the navigation). Scans now run inside the page at `load` time via an init script and are pushed through the binding, so they survive instant navigation. The delayed re-scan still uses `evaluate` (the page is expected to be still there).

### C7 shareable HTML report
69. **The report is static HTML + CSS + one tiny inline script** (expand/collapse all, open the step named in the URL hash). `<details>` gives collapsible steps without a framework. URLs appear as inert text (never `href`/`src`), and a test opens the exported file in a browser and asserts the only request is the file itself.
70. **Everything is redacted again at render time** (`createBundle` re-sanitises steps, snapshots, task and meta). This caught a real gap: run **task titles and meta values were not redacted in bundles**; fixed for both create and parse.
71. **Size budget:** 60 KB per snapshot and ~1.2 MB total snapshot text in the report, so even a run with 200 KB snapshots stays well below 2 MB; truncated snapshots are marked. The demo's flights run is ≈ 25 KB.
72. **Report + comparison:** `steplight report <id> --diff <other>`, and in the viewer the Export HTML report button includes the comparison when Compare mode has a run B selected (compare selection is now lifted into App state).
73. **`describeStep`, `shortUrl`, `offset` and `KIND_ICON` moved into core** so the viewers and the HTML report describe steps identically.

## Round 3

### Part A: attack surfaces
74. **Treat all captured content as hostile.** Audit result: neither viewer nor the report used `innerHTML`/`dangerouslySetInnerHTML`; evidence highlighting already split text into React text nodes. The new tests (`xss.e2e.test.ts`, `core/security.test.ts`) lock this in with six payload families (img onerror, script, svg onload, javascript: URL, iframe srcdoc, ontoggle) placed in every field, in the real viewer and the real report, in Chromium.
75. **Report CSP is a `<meta>` with SHA-256 hashes of the one `<style>` and one `<script>`** (`default-src 'none'`, no `connect-src` so there is no network, no `unsafe-inline`). The inline `style=""` attribute was replaced by a class. The hash needs SHA-256 in browsers *synchronously*, so core has a small `sha256Hex/Base64` (tested against `node:crypto`).
76. **Viewer CSP is a response header** from the CLI: `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'…`. React's `style={{width}}` uses CSSOM, which `style-src` does not block, so no `unsafe-inline` is needed. Tests prove an injected inline script does not run and a cross-origin fetch is blocked.
77. **Extension pages CSP** in the manifest: `script-src 'self'; style-src 'self'; object-src 'none'; connect-src 'self' http://localhost:4777 http://127.0.0.1:4777`. The popup's inline `<style>` moved into `popup.css`. The real-Chromium e2e still passes, so the bundled viewer works under it.
78. **Session token:** 256-bit random hex generated per `createViewerServer` (not persisted). Required as `Authorization: Bearer` on every `/api/*` route (ingest, import, reads); compared by `timingSafeEqual` over SHA-256 digests. Query-string tokens are deliberately *not* accepted (they leak into logs/history). Static viewer files are public because they contain no run data.
79. **Pairing:** `steplight view` prints `http://127.0.0.1:<port>/#token=…`. The viewer reads the fragment (never sent to a server), keeps it in `sessionStorage` and strips it from the address bar. The extension popup has "Pair with CLI": paste the same link; the token goes into `chrome.storage.session` (cleared when the browser closes, like the CLI token on restart). Without a token the extension never even probes the server and stays standalone; a wrong token is rejected at pairing time.
80. **Host-header allowlist** (`127.0.0.1:<port>`, `localhost:<port>`, `[::1]:<port>`, plus an explicit `--host`) applies to *every* request including static files, which blocks DNS rebinding. **Origin check:** any request that carries an `Origin` must be this server's own origin or a `chrome-extension://` origin (optionally restricted with `--extension-id`); otherwise 403. CORS responses echo the specific origin, never `*`. Requests without Origin (curl, the extension's service worker with host permission) still need the token.
81. **`--host`:** default is `127.0.0.1`. Any non-loopback value is allowed only when passed explicitly and prints a loud warning; it is added to the Host allowlist. The token still applies.
82. **Limits:** ingest body 5 MB (413, checked on Content-Length and while streaming), import 8 MB (exports of long runs can be larger than a single ingest message), 2000 requests / 10 s global fixed window (429). The limit is deliberately generous because the extension sends one request per step; it exists to stop runaway loops, not to meter a person. Run and step ids must match `[A-Za-z0-9_-]{1,128}` (400).
83. **Ingest validation uses zod** (`ingestSchema.ts`) with bounded strings/arrays; unknown keys are stripped (not stored); the server still redacts on write (defence in depth). zod is a CLI dependency only, so it does not enter the extension bundle.
84. **Extension messaging:** `parseMessage` (hand-written, no zod in the extension bundle) drops malformed messages without replying. `senderAllowed` requires `sender.id === chrome.runtime.id`, requires page `event`s to come from a content script and control messages (`start/stop/pair`) from an extension page, so a compromised content script (running inside an attacker-controlled page's isolated world) cannot start, stop or re-pair a recording. No `externally_connectable`, no `web_accessible_resources` (asserted by a test).
85. **Viewer inside the extension:** same React bundle as the CLI viewer, so the DOM-level XSS tests on the CLI viewer cover it; the extension's own e2e proves it loads under the strict CSP. A dedicated XSS test inside the extension is left for Part C when snapshot capture levels change.

