# Progress

## Round 3 status (in progress)

| Part | Status |
|---|---|
| A. Existing attack surfaces | ✅ report CSP (hashed, no network), viewer CSP header, extension-page CSP, XSS tests (viewer + report, 6 payload families), CLI session token + pairing, Host/Origin checks, 5 MB limit, rate limit, zod ingest schema, id validation, extension sender + message validation (+ 59 security tests) |
| B. Network capture + SPA | ✅ webRequest capture (tab-scoped, header allowlist, body analysed in memory), `networkExfil` detector (URL/body secrets, copied page text, beacon after hidden instruction), opt-in MAIN-world deep capture, SPA navigation + debounced re-scan, 5 new red-team pages, SDK parity, viewer/report request metadata, real-Chromium e2e for each page + analytics control + perf test |
| C. Privacy controls | ✅ capture levels (min/standard/full) in extension + SDK, always-on never-capture fields, site allow/deny lists + first-run suggestions + "paused" status, redaction engine rewrite (20+ kinds, encodings, custom patterns with ReDoS checks, fast-check fuzzing), redaction at the source, retention (extension 7 days; `steplight purge`), delete-all (settings page, viewer, `/api/purge`), REC badge + page pill, settings page |
| D. Encryption at rest | ✅ extension storage AES-256-GCM (non-extractable key in IndexedDB, IV per record), CLI/SDK file encryption (key or scrypt passphrase, 0600 files), password-protected JSON + HTML exports, pre-export dialog with strip options, `steplight decrypt` |
| E. Enterprise controls | ✅ managed_schema.json + chrome.storage.managed policy (9 keys, only ever tightens), `--policy` / steplight.config.json / STEPLIGHT_* for CLI+SDK, hash-chained audit log (extension UI + `steplight audit`), docs/enterprise.md |
| F. Supply chain | ⏳ |
| G. Honest docs | ⏳ |


Round 1 (MVP) and Round 2 (store readiness, polish, developer features) are complete and committed. The acceptance command was verified from a fresh `git clone`:
`pnpm install && pnpm -r build && pnpm -r test && pnpm demo` (all green; after a one-time `pnpm exec playwright install chromium`).

## Round 2 status

| Part | Status |
|---|---|
| A. Chrome Web Store readiness | ✅ standalone mode (`chrome.storage.local`, 8 MB cap, oldest-run eviction), mode shown in the popup, bundled `viewer.html`, JSON export/import, PRIVACY.md, docs/store-listing.md, `pnpm --filter @steplight/extension package` (zip), 16/32/48/128 icons |
| B. Viewer polish | ✅ Clean badge, auto-select newest run + first flagged step, Replay `aria-disabled`, hover titles + 2-line wrap, `steplight clear [--keep N]`, demo clears old demo runs, SVG logo, 1 MB / <500 ms performance guard |
| C1. Stuck loops + failure explainer | ✅ `stuckLoop` detector, SDK diagnosis (covered / disabled / hidden / off-screen / 0 or many matches / similar selectors), "Why did this fail?" panel, `stuck.html` fixture + demo run |
| C2. Run diff | ✅ `diffRuns` (LCS alignment), `steplight diff`, viewer Compare mode, demo prints the diff |
| C3. Playwright repro | ✅ `steplight replay-script`, Copy as Playwright test (both viewers); generated tests are executed in the test suite |
| C4. Agent CI checks | ✅ `steplight check` (rules YAML; text / JUnit / SARIF; exit 0/1/2), GitHub Action in `examples/github-action/` |
| C5. Red-team pack | ✅ `@steplight/redteam`: 13 attack pages, `steplight redteam serve`, `report` (text/markdown/json, score out of 100), gullible and resilient demo agents |
| C6. Token and context cost | ✅ per page-read estimates (visible / hidden / boilerplate), run total + top 3 pages, viewer, `steplight tokens`, OTel attribute |
| C7. Shareable HTML report | ✅ `steplight report [--diff]`, Export HTML report in both viewers, verified offline, <2 MB |
| D. Docs and wrap-up | ✅ README (Why Steplight, feature table, usage per feature), CONTRIBUTING.md, issue templates, clean-clone check |

## What works

- **Record**: Playwright SDK and Chrome extension (standalone or connected to the CLI) record navigations, clicks, field changes (values never recorded), form submits, page snapshots (hidden text included), flags, causal links, token estimates.
- **Detect**: hidden instructions (CSS-hidden, comments, aria-label/alt, zero-width, delayed injection), cross-domain data, sensitive outbound data, suspicious redirects, stuck loops.
- **Understand**: viewer with timeline, highlighted evidence, failure explainer, Compare, token summary; `diff`, `tokens`, `report`.
- **Reproduce and gate**: `replay-script`, `check` (JUnit/SARIF + Action), `redteam`.
- **Share**: JSON export/import, self-contained HTML report, all redacted again on export.

## How to run

```bash
pnpm install
pnpm exec playwright install chromium     # one-time
pnpm -r build && pnpm -r test
pnpm demo && pnpm view                    # http://localhost:4777
pnpm --filter @steplight/demo-agent redteam-demo && node packages/cli/dist/bin.js redteam report
pnpm --filter @steplight/extension package   # zip for the Chrome Web Store
```

## Tests: 276 passing

| Package | Tests |
|---|---|
| core | 182 (detectors, redaction, storage, local store, bundles, OTel, diff, repro, check rules, tokens, HTML report, perf guard) |
| cli | 42 (API/ingest/import, check formats, diff, clear, report, tokens, redteam, replay executed with Playwright Test, viewer e2e incl. replay, compare, copy-test, offline report, 375 px) |
| extension | 25 (message handling, standalone/connected, manifest + bundle checks, real-Chromium e2e for both modes) |
| redteam | 14 |
| viewer | 7 |
| sdk | 4 (real Chromium against fixtures) |
| demo-agent | 2 (the four demo scenarios; the full red-team pack end to end) |

## Bugs the tests found (all fixed)

- Email regex was quadratic, then still 500 ms/MB: replaced by an `@`-anchored scanner.
- URL-encoded form bodies bypassed email detection/redaction.
- Evidence masking leaked part of an email.
- **SDK lost page snapshots when an agent navigated immediately after `goto()`**: scans now run inside the page at load time.
- Run task titles and metadata were not redacted in exports and HTML reports.
- Invalid YAML in the GitHub Action's `action.yml` (caught by parsing it in a test).
- A blocking `spawnSync` deadlocked the in-process fixtures server in a test.

## Known gaps

- **Extension**: no fetch/XHR or SPA (pushState) capture, one tab at a time, and it cannot see an agent's failed actions (so no failure explainer there). The optional all-sites permission needs a human click; the e2e test uses a patched manifest copy. Not published to the Web Store (zip + listing material are ready); the store screenshots are still to be taken.
- **SDK**: only page-level action methods are wrapped for failure capture; Locator actions need `run.reportError()`. Playwright only (no Puppeteer / CDP SDK).
- **Detectors** are heuristic and English-only; they read DOM text, comments and aria-label/alt, not images, canvas, PDFs, shadow DOM or iframe internals. `causedBy` is lexical overlap.
- **Token figures are chars/4 estimates**, and boilerplate detection is heuristic.
- **Red-team**: attack pages cover 13 techniques but only test agents that read text; no image/OCR or multi-step attacks. The scorecard aggregates all runs in a directory.
- **Diff** aligns by URL path + target; very different flows produce a "changed" wall. Runs above ~2000 steps fall back to position-wise alignment.
- **GitHub Action** is validated by YAML parsing only (cannot run GitHub Actions offline). Packages are not published to npm.
- The viewer polls (3 s) instead of streaming, and long runs are not virtualised.
- Redaction is pattern-based: free-text personal data (names, addresses) is not caught.

## Next 5 tasks (priority order)

1. **Extension network + SPA capture** (`webRequest` / history API) and multi-tab runs, so CDP and Browser Use agents get full `network_request` coverage and cross-domain detection for fetch/XHR.
2. **Python SDK / Browser Use integration**: emit the same run format (or POST to `/api/ingest`), including failure diagnosis, so Python agents get every feature above.
3. **Publish**: npm release of `@steplight/core|sdk|cli|redteam` (bundle the viewer into the CLI), Chrome Web Store submission with screenshots, versioned releases.
4. **Detector quality corpus**: collect real injections and benign pages, measure false positives, add multilingual patterns, shadow DOM / iframe scanning and (opt-in) image-text detection; grow the red-team pack with multi-step and image attacks.
5. **Live view and MCP tracing**: stream steps to the viewer over SSE instead of polling and record MCP tool calls next to browser steps.
