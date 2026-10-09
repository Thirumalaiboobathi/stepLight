# Steplight in GitHub Actions

This guide wires Steplight into a pull-request check: your agent runs in CI with recording on, and the build fails if the run hit a prompt injection, sent data to a site it should not, got stuck, or broke a rule you wrote.

You need: a project that drives a browser with Playwright (your own script or an agent framework), Node 20+, and a GitHub repository.

## 1. Install

```bash
npm i -D steplight playwright
npx playwright install chromium
```

`steplight` is the SDK and the command line in one package (the underlying `@steplight/*` packages can also be installed separately). Everything runs locally and offline; nothing is sent anywhere.

## 2. Wrap your agent with `steplight.record`

Call `record()` on the page your agent drives and `end()` when it finishes. Nothing else changes in your agent.

```js
// agent.mjs
import { chromium } from "playwright";
import { steplight } from "steplight";

const browser = await chromium.launch();
const page = await browser.newPage();

const run = await steplight.record(page, { task: "Book the cheapest flight from Delhi to Mumbai" });
let status = "success";
try {
  await runMyAgent(page); // your code
} catch (err) {
  status = "failed";
  throw err;
} finally {
  await run.end(status); // writes .steplight/runs/<runId>/
  await browser.close();
}
```

`record()` never throws into your agent: if recording fails it logs to stderr and the agent keeps running. Runs are redacted before they are written (emails, cards, keys, tokens…). Capture levels, encryption and the other options are in the [README](../README.md#sdk-playwright).

## 3. Write the rules

Create `steplight.rules.yml` in the repository root:

```yaml
max_steps: 40               # fail if the run took more steps than this
max_severity: medium        # fail on any flag more severe than this (so high and critical fail)
must_visit:                 # each entry must appear in a visited URL (path or query)
  - /checkout
must_not_visit_domains:     # fail if the agent contacted these domains or their subdomains
  - evil.example
no_stuck_loops: true        # fail if the agent repeated the same action
```

Unknown keys are rejected, so a typo cannot silently disable a rule. Try it locally first: `npx steplight check --latest`.

## 4. The workflow

`.github/workflows/agent-check.yml`. Pin every third-party action to a full commit SHA (the comments name the versions):

```yaml
name: agent-check
on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  agent-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npx playwright install --with-deps chromium

      # Run your agent with recording on. It writes .steplight/runs/.
      - run: node agent.mjs

      # Check the newest run against steplight.rules.yml and fail the job on a finding.
      - id: steplight
        uses: steplight-dev/steplight-check-action@ca1c3dab43a7776ad9b0781393d2b3e910ebf4ab # v1.0.1
        with:
          fail-on: high # low | medium | high | critical

      # Keep the recorded run so you can open it in the viewer (also when the check failed).
      - if: always()
        uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
        with:
          name: steplight-runs
          path: .steplight/runs
          retention-days: 7
```

What the check action does: it reads the latest run from `.steplight/runs`, applies `steplight.rules.yml` and the `fail-on` threshold, writes a summary (task, flags table, rule violations) to the job page, and sets the outputs `result` (`pass`/`fail`), `flag-count`, `max-severity` and `report-file`. All its inputs are documented in the [action's README](https://github.com/steplight-dev/steplight-check-action#inputs). To check one particular run, pass `run-id`.

To open the uploaded run, download the artifact, unzip it into `.steplight/runs` and run `npx steplight view`.

### Alternative without the action

The CLI does the same thing and fits any CI system:

```yaml
      - run: npx steplight check --latest --rules steplight.rules.yml   # exit 0 pass, 1 findings, 2 usage error
```

## 5. Optional: findings in GitHub code scanning (SARIF)

Add `format: sarif` and upload the file. This needs `security-events: write` and a repository where code scanning is available (public repositories, or private ones with GitHub Advanced Security):

```yaml
    permissions:
      contents: read
      security-events: write
    steps:
      # … same steps as above, then:
      - id: steplight
        uses: steplight-dev/steplight-check-action@ca1c3dab43a7776ad9b0781393d2b3e910ebf4ab # v1.0.1
        with:
          format: sarif
          output-file: steplight.sarif

      - if: always() && steps.steplight.outputs.report-file != ''
        uses: github/codeql-action/upload-sarif@2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2 # v4.38.2
        with:
          sarif_file: steplight.sarif
          category: steplight
```

For JUnit (test reports in your CI UI) use `format: junit`.

## Things to know

- **Treat the uploaded run as sensitive.** It is redacted, but it holds page text and URLs from the sites your agent visited. Keep `retention-days` short, and restrict who can read artifacts. The `minimal` capture level keeps no page text (`steplight.record(page, { task, captureLevel: "minimal" })`); detectors still see everything in memory.
- **Pull requests from forks** do not get write permissions or secrets, so the SARIF upload step will not work there; the check itself does.
- **Encrypted runs** (`encryption` option) cannot be read by the action; decrypt them first with `steplight decrypt`, or record unencrypted in CI.
- **Test your agent's resistance** before relying on the check: `npx steplight redteam serve` serves harmless injection pages to aim your agent at, then `npx steplight redteam report` scores it.
- **Updating the pins:** Dependabot (`package-ecosystem: github-actions`) keeps SHA-pinned actions current. Resolve a release's SHA with `git ls-remote https://github.com/steplight-dev/steplight-check-action v1.0.1`.
