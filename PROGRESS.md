# Progress

All 7 phases are complete and committed. Acceptance command verified from a fresh `git clone`:
`pnpm install && pnpm -r build && pnpm -r test && pnpm demo` (all green).

| Phase | Status |
|---|---|
| 1 Scaffold | ✅ |
| 2 Core (model, redaction, 4 detectors, storage, OTel) | ✅ |
| 3 SDK + Playwright | ✅ |
| 4 Fixtures + demo agent | ✅ |
| 5 Viewer + CLI | ✅ |
| 6 Chrome extension | ✅ |
| 7 Docs + polish | ✅ |
| R2-A Store readiness | ✅ standalone mode, import/export, PRIVACY.md, store listing, zip, icons |
| R2-B Viewer polish | ✅ Clean badge, auto-select, Replay state, hover titles, clear, logo+icons, perf guard |
| R2-C1 Stuck loops + failure explainer | ✅ |
| R2-C2 Run diff | ✅ core diffRuns, `steplight diff`, viewer Compare mode, demo |
| R2-C3 Playwright repro scripts | ✅ `steplight replay-script`, Copy as Playwright test, executed in tests |
| R2-C4 Agent CI checks | ✅ `steplight check` (text/junit/sarif), GitHub Action example |
| R2-C5 Red-team pack | ✅ `@steplight/redteam`, `steplight redteam serve|report`, 13 attacks, demo agents |

## What works

- **Core**: Step/Run/Flag model; per-run folder storage (`run.json`, `steps.jsonl`, `snapshots/`); redaction (emails, Luhn cards, API keys, JWTs, percent-encoded) and truncation before disk; detectors `hiddenInstruction`, `crossDomainData`, `sensitiveOutbound`, `suspiciousRedirect`; `causedBy` inference; OTel span mapping with OTLP/HTTP export that fails silently.
- **SDK**: `steplight.record(page, { task })` → navigation, clicks, field changes, form submits, fetch/XHR, downloads, per-load page snapshots, detectors, `run.note()`, `run.end()`. Fails open.
- **Demo**: `pnpm demo` runs a scripted agent that obeys a hidden instruction. Result: high `hidden_instruction` on the page read, Premium click `causedBy` that read, critical + high flags on the checkout submit; the clean page has no high flags.
- **CLI**: `steplight view` (viewer + JSON API + `/api/ingest`, 127.0.0.1 only), `steplight export <id> [--otlp]`.
- **Viewer**: run list with severity badges, timeline coloured by severity, step detail with highlighted hidden-text evidence, request preview, caused-by / led-to links, 800 ms replay, dark mode, no horizontal scroll at 375 px.
- **Extension**: MV3, builds to `packages/extension/dist`, verified loading in real Chromium and recording the hijack scenario through the real server.

## How to run

```bash
pnpm install
pnpm exec playwright install chromium   # one-time browser download
pnpm -r build && pnpm -r test
pnpm demo && pnpm view                  # http://localhost:4777
```

## Tests: 103 passing

| Package | Tests |
|---|---|
| core | 69 (detectors: 51 unit tests, ~95% statement coverage) |
| sdk | 3 (real Chromium against fixtures) |
| demo-agent | 1 (acceptance scenario) |
| cli | 8 (API/ingest + Playwright viewer e2e incl. replay and 375 px) |
| extension | 17 (message handling, manifest, bundle checks, real-browser e2e) |
| viewer | 5 |

## Bugs found by the tests and fixed along the way

- Unbounded email regex took 146 s on 300 KB of text (quadratic) → length-bounded regexes, truncate before redact.
- URL-encoded form bodies (`a%40b.co`) bypassed email detection and redaction → percent-decode before matching.
- Flag evidence for emails leaked the first/last characters → kind-aware masking.

## Known gaps / issues

- Extension does not capture fetch/XHR or SPA (pushState) navigation, and records one tab at a time. Following the agent across pages needs the optional all-sites permission.
- Extension has no icons, and is not packaged/published (load unpacked only).
- Extension e2e needs port 4777 free (it skips itself otherwise) and the full Playwright Chromium.
- Detectors are heuristic and English-only. `hiddenInstruction` sees DOM text only (not images, canvas, PDFs, shadow DOM, iframes' internals).
- `causedBy` is a lexical-overlap heuristic; it will miss paraphrased instructions.
- Redaction is pattern-based; free-text PII (names, addresses) is not caught.
- The viewer polls (3 s) rather than streaming; very large runs are not virtualised.
- `@steplight/*` packages are not published to npm; `steplight` bin works from the repo build.
- Line endings: repo uses LF (`.gitattributes`); Windows checkouts may show CRLF warnings.

## Next 5 tasks (priority order)

1. **Extension network + SPA capture** (`webRequest`/history API hook) and multi-tab runs, so CDP/Browser Use agents get full `network_request` coverage and cross-domain detection works for fetch/XHR.
2. **Python SDK** for Browser Use (emit the same `steps.jsonl` format, or POST to `/api/ingest`).
3. **Package and publish**: npm release of `@steplight/core|sdk|cli` (bundle the viewer into the CLI package), Chrome Web Store build with icons.
4. **Detector quality pass**: collect a corpus of real injections and benign pages, measure false positives, add multilingual patterns, shadow DOM / iframe scanning, and image-text (OCR) as an opt-in.
5. **MCP tracing + live view**: record tool calls next to browser steps, and stream steps to the viewer over SSE instead of polling.
