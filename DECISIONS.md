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
