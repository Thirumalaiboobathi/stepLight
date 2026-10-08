# Decisions

Choices made where the spec was ambiguous. Simplest reasonable option wins.

1. **Repo root = this folder.** The `steplight/` folder in the spec is the repo root itself.
2. **Build tool for Node packages = plain `tsc`** (NodeNext modules, `.js` import suffixes). No bundler needed for core/sdk/cli.
3. **Core subpath exports.** `@steplight/core` (pure, browser-safe), `@steplight/core/node` (fs-based run storage), `@steplight/core/otel` (OpenTelemetry mapping). Keeps the extension/viewer bundles free of `fs` and OTel.
4. **Vite 5 + Vitest 2** so the viewer/extension share one Vite major with the test runner.
5. **Tailwind v4** via `@tailwindcss/vite` (no PostCSS config file).
6. **LICENSE** text copied verbatim from the Apache-2.0 license shipped with the `typescript` package.
