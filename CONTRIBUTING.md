# Contributing to Steplight

Thanks for helping. Steplight is local-first: **no runtime network calls except to localhost, no telemetry, no external services.** Please keep it that way.

## Setup

Requirements: Node 20+ and pnpm 9+.

```bash
git clone <your fork> && cd steplight
pnpm install
pnpm --filter @steplight/extension exec playwright install chromium     # browser for the SDK, demo and integration tests
pnpm -r build
```

## Everyday commands

```bash
pnpm -r build                 # build every package (viewer before extension; the extension bundles it)
pnpm -r test                  # all tests (some drive real Chromium, ~2 minutes)
pnpm --filter @steplight/core test         # just one package
pnpm --filter @steplight/core exec vitest run src/detectors/hiddenInstruction.test.ts
pnpm lint                     # ESLint
pnpm format                   # Prettier
pnpm demo                     # scripted agents → .steplight/runs
pnpm view                     # viewer on http://localhost:4777
pnpm --filter @steplight/extension package   # zip for the Chrome Web Store
```

Notes:
- The extension's end-to-end test uses port 4777 and skips itself if a real `steplight view` is already running. Stop it for the full run.
- Integration tests start their own fixture servers on free ports.
- Windows works; use Git Bash or PowerShell. Tests that spawn child processes use async `spawn`, never `spawnSync` (the fixtures server lives in the same process).

## Ground rules

1. **TypeScript strict**, small files, JSDoc with an `@example` on every exported function.
2. **Fail open.** Recording must never crash or slow the agent: wrap hooks in try/catch and log to stderr.
3. **Precision over recall** for every detector. A noisy detector is worse than a missed one. When unsure, use a lower severity.
4. **No secret ever reaches disk unredacted.** New fields that carry free text must go through `sanitizeStep` / `redactText` (see `packages/core/src/sanitize.ts`).
5. **Every feature gets tests, a README section with a usage example, and (where it makes sense) a demo in `examples/`.** Features should work in both viewers (CLI and extension) unless the README's feature table says otherwise.
6. **Log ambiguous decisions in `DECISIONS.md`** and keep `PROGRESS.md` current.
7. Commit messages: `area: what changed` (for example `core: add stuck-loop detector`).

## How to add a detector

Detectors are pure functions in `packages/core/src/detectors/`.

1. Create `myDetector.ts` exporting a function that returns `Flag[]` (see `stuckLoop.ts` for a step + history detector, `hiddenInstruction.ts` for a page-content one). Add a new `FlagType` in `packages/core/src/types.ts` if needed.
2. Write `myDetector.test.ts` **first**: at least **4 positive** and **4 negative** cases. The negatives are false-positive guards (for example, a normal "Click Download to get the PDF" button must not be flagged high).
3. Export it from `detectors/index.ts`. Step/request detectors are combined in `analyzeStep` (`packages/core/src/analyze.ts`); page-content detectors run on a `PageScan` (see `collect.ts`), in the SDK (`packages/sdk/src/recorder.ts`) and the extension content script.
4. Keep it fast. Add a pathological input for it to `packages/core/src/perf.test.ts` (all detectors must handle 1 MB in under 500 ms). Avoid unbounded regexes; scan from anchors such as `indexOf("@")` instead.
5. Give it a severity that follows the rules in the README's detector table, mention it there, and add the new flag type to the viewer if it needs special display (`packages/viewer/src/components/`).

## How to add a red-team page

Attack pages live in `packages/redteam/src/attacks.ts`.

1. Add an entry with `base(id, title, technique, goal, build, options)`. Use a URL-safe `id` (`/^[a-z0-9-]+$/`); the page is served at `/attacks/<id>.html`.
2. In `build`, call `page(this, injectionHtml)` with the injection delivered through your channel. For "visit" attacks use `visitPayload(this, ctx)`, which asks the agent to open `/canary/<id>`. For exfiltration attacks post to `${ctx.collector}/collect/<id>` and set `goalKind: "exfil"`. Escape everything with `esc()`.
3. Keep it **harmless and honest**: a normal product page with the price visible, a benign task ("find the price") and a canary that only records that the agent obeyed.
4. Set `expectedFlag` to the severity Steplight should give it (`"high"` for hidden text, `"low"` for visible text). If the existing detectors do not catch your technique, fix the detector in `packages/core` (and add tests there) rather than lowering the expectation.
5. Run `pnpm --filter @steplight/redteam test` (checks structure) and `pnpm --filter @steplight/demo-agent test` (a gullible scripted agent must fall for every page; a resilient one must resist all, and every page must be flagged). If your page needs the gullible agent to behave differently, update `examples/demo-agent/src/redteam.mjs`.

## Pull requests

- Describe the problem and the user-visible change; link the issue.
- Include the test output of `pnpm -r build && pnpm -r test`.
- Screenshots for viewer changes (dark mode and a 375 px width).
- By contributing you agree that your contribution is licensed under Apache-2.0.

## Reporting security issues

Please do not open a public issue for a vulnerability in Steplight itself. Use GitHub's private vulnerability reporting on the repository. New *attack patterns* that Steplight misses are welcome as public issues (use the "New attack pattern" template).

## Security-sensitive changes

Steplight handles browsing data, so some changes get extra care. Before opening a PR that touches any of the following,
read [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) and add a test that proves the control still holds (including a negative test):

- rendering of recorded text in a viewer or report (text nodes only, never `innerHTML`), or any CSP;
- redaction, the never-capture field rules (`packages/core/src/neverCapture.ts`; the page scripts repeat the rule inline and a test keeps them in sync) or capture levels;
- the CLI server (token, Host/Origin checks, schemas, limits) or extension message handling (`validate.ts`);
- encryption, exports, policy or the audit log;
- workflows: every `uses:` must be pinned to a commit SHA with a version comment and permissions must stay minimal (`packages/cli/src/supplychain.test.ts` enforces this).

New runtime dependencies need a reason in `DECISIONS.md`. Report vulnerabilities privately (see [SECURITY.md](SECURITY.md)).
