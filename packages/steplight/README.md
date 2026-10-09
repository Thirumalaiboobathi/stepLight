# steplight

A flight recorder for AI agents that drive a browser. Record what the agent does, replay it step by step, and get flagged when a page tried to hijack it (hidden prompt injection) or when data left for a site it should not have. Everything stays on your machine: no servers, no accounts, no telemetry.

`steplight` installs the SDK and the command line together. They are also published separately as `@steplight/sdk` and `@steplight/cli`, on top of `@steplight/core` (detectors, redaction, storage).

## Install

```bash
npm i -D steplight playwright      # playwright is only needed to record (the SDK instruments your Playwright page)
npx playwright install chromium
```

## Record an agent (3 lines)

```js
import { steplight } from "steplight";

const run = await steplight.record(page, { task: "Book the cheapest flight" });
// ... let your agent drive `page` ...
await run.end("success");
```

Runs are redacted and written to `.steplight/runs` (optionally encrypted).

## Command line

```bash
npx steplight view                  # replay viewer on http://127.0.0.1:4777
npx steplight check --latest        # exit 1 when the run breaks steplight.rules.yml: for CI
npx steplight report <runId>        # single-file HTML report
npx steplight --help                # diff, replay-script, export --otlp, redteam, purge, audit, ...
```

## Links

- Documentation, security policy and threat model: https://github.com/steplight-dev/steplight
- CI guide: https://github.com/steplight-dev/steplight/blob/main/docs/github-actions.md
- GitHub Action: https://github.com/steplight-dev/steplight-check-action

Apache-2.0.
