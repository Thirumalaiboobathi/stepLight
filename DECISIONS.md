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
