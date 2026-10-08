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
