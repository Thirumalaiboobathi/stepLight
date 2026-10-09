# Changelog

All notable changes to Steplight. The npm packages (`steplight`, `@steplight/core`, `@steplight/sdk`, `@steplight/cli`, `@steplight/redteam`) share one version number. The GitHub Action ([steplight-dev/steplight-check-action](https://github.com/steplight-dev/steplight-check-action)) is versioned separately.

## 0.1.0 - 2026-10-09

First public release. Steplight is a flight recorder for AI agents that drive a browser: it records what the agent does, replays it, and flags prompt injection and data exfiltration. Everything runs on your machine.

### Recording and replay
- **Three ways to record:** a Playwright SDK (`steplight.record(page, …)`), a Chrome extension that works on its own (standalone mode with a bundled viewer), and the CLI for files, viewing and exports.
- **One-install package:** `npm i -D steplight` gives the SDK (`import { steplight } from "steplight"`) and the `steplight` command; `@steplight/*` are the underlying packages.
- **Replay viewer** (CLI and extension): timeline, ▶ Replay, page snapshots with hidden text highlighted, "caused by" links between steps, token estimates per page, dark mode, usable from 375 px phones up.
- **Network capture:** fetch, XHR, beacons, image pixels and WebSockets (extension via `webRequest`, SDK via Playwright), single-page-app route changes, and an opt-in page-level "Deep capture".
- **Run diff** (first point of divergence), **Playwright repro script** from a run, **failure explainer** (covered, disabled, hidden, off-screen, wrong selector), **stuck-loop detection**, OpenTelemetry export, single-file HTML reports.

### Detection
- **Hidden instructions** (hidden divs, white-on-white, off-screen, 1 px or transparent text, comments, aria-label and alt text, zero-width characters, text injected late or after a route change).
- **Data leaving the page:** cross-domain form posts and background requests carrying text from an earlier page; secrets and personal data in bodies and URL query strings; beacons to new third-party domains right after a page with hidden instructions. Precision is preferred over recall; known analytics and CDN domains are downgraded.
- **Red-team pack:** 18 harmless attack pages with a scorecard out of 100 (`steplight redteam`).
- **CI:** `steplight check` with `steplight.rules.yml`, JUnit and SARIF output, and the [Steplight Agent Check](https://github.com/steplight-dev/steplight-check-action) GitHub Action. Guide: [docs/github-actions.md](docs/github-actions.md).

### Security and privacy posture
- **Local only.** No servers, accounts, analytics, telemetry, remote code, `eval` or CDN scripts. Network requests go only to `127.0.0.1` (your own viewer) and, if you configure one, your OpenTelemetry collector.
- **You choose what is kept:** capture levels Minimal / Standard (default) / Full. Password, card, one-time-code and payment-frame fields are never read; typed values are never recorded; headers are never captured except two response headers.
- **Redaction at the source** (20+ kinds incl. cards with Luhn, IBAN, Aadhaar, PAN, JWTs, cloud and AI API keys, URL parameters, encoded forms, user patterns checked against ReDoS), again before storage and on export; it fails closed. It is pattern-based and does not recognise names or addresses; use Minimal or the site deny list for those.
- **Encryption at rest:** AES-256-GCM in the extension (non-extractable key) and optional for CLI/SDK files; password-protected exports (PBKDF2-SHA256, 600k iterations).
- **Deletion:** default 7-day retention in the extension, `steplight purge`, delete-all, site deny list with suggested sensitive sites, a REC badge while recording.
- **Hardened surfaces:** text-only rendering (XSS-tested in viewer and reports), strict CSPs, a localhost server with a random session token, Host/Origin checks, schema validation, size and rate limits, extension sender and message validation.
- **Enterprise controls:** Chrome managed policy and CLI/SDK policy files that can only tighten settings, plus a hash-chained, tamper-evident audit log. See [docs/enterprise.md](docs/enterprise.md).
- **Supply chain:** npm packages are published from GitHub Actions with OIDC trusted publishing and provenance (no npm token exists); every workflow action is pinned to a commit SHA with least-privilege permissions; CodeQL, dependency review, `pnpm audit`, CycloneDX SBOM and Dependabot run in CI. `npm audit signatures` needs npm 11+. Policy: [SECURITY.md](SECURITY.md); design: [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

### Known limits
- Redaction is pattern-based; the extension's encryption does not protect against malware running as your user; Deep capture shares a JavaScript world with the page; network capture covers one tab; the audit log is tamper-evident, not tamper-proof; the Chrome extension is not yet on the Chrome Web Store.

## 0.1.0-rc.3, rc.2 (pre-releases)

Release-candidate builds used to validate OIDC trusted publishing and the unscoped `steplight` package (`next` dist-tag). `0.1.0-rc.1` failed in CI before publishing anything.
