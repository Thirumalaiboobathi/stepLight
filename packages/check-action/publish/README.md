# Steplight Agent Check

A GitHub Action that runs [`steplight check`](https://github.com/steplight-dev/steplight) on a recorded run of an AI browser agent and **fails your workflow** when the agent was hijacked by a hidden prompt injection, sent data to a site it should not have, got stuck in a loop, or broke a rule you wrote.

Your agent records its run with the Steplight SDK or the Steplight browser extension (a folder of files under `.steplight/runs`). This action reads that folder, so there is nothing to install and no service to call.

- **Self-contained:** one bundled JavaScript file; nothing is downloaded at runtime.
- **Private:** runs never leave the runner. The action makes no network calls and has no telemetry.
- **CI-native:** text log, job summary, JUnit XML, or SARIF for GitHub code scanning.

## Quick start

```yaml
name: agent-check
on: [push, pull_request]

permissions:
  contents: read

jobs:
  agent-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false

      # ... run your agent here so that it records into .steplight/runs ...

      # Pin third-party actions to a full commit SHA. Resolve the SHA of the release you want with:
      #   git ls-remote https://github.com/steplight-dev/steplight-check-action v1.0.0
      - uses: steplight-dev/steplight-check-action@<full-commit-sha> # v1.0.0
        with:
          fail-on: high
```

The job fails if the run has any flag of severity `high` or `critical`, or breaks a rule in `steplight.rules.yml`.

## Example with code scanning (SARIF)

```yaml
jobs:
  agent-check:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write # needed to upload SARIF
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false

      - id: steplight
        uses: steplight-dev/steplight-check-action@<full-commit-sha> # v1.0.0
        with:
          format: sarif
          output-file: steplight.sarif

      - if: always() && steps.steplight.outputs.report-file != ''
        uses: github/codeql-action/upload-sarif@2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2 # v4.38.2
        with:
          sarif_file: steplight.sarif
          category: steplight
```

SARIF upload needs code scanning to be available for the repository (public repositories, or private ones with GitHub Advanced Security).

## Inputs

| Input | Default | Description |
|---|---|---|
| `runs-dir` | `.steplight/runs` | Folder with recorded runs, relative to the workspace. |
| `run-id` | latest run | Id of the run to check. Letters, digits, `-` and `_` only. |
| `rules` | `steplight.rules.yml` | Rules file (YAML). If the default file does not exist, only `fail-on` is applied (and the job summary says so). A non-default path that does not exist is an error. |
| `format` | `text` | `text`, `junit` or `sarif`. |
| `output-file` | `steplight-check.xml` / `.sarif` for those formats | Where to write the report, relative to the workspace. With `text`, a file is written only if you set this. |
| `fail-on` | `high` | Fail when any flag has at least this severity: `low`, `medium`, `high` or `critical`. |

All paths must stay inside `GITHUB_WORKSPACE`; `..` segments, absolute paths elsewhere and symbolic links that lead outside are rejected.

## Outputs

| Output | Description |
|---|---|
| `result` | `pass` or `fail`. Not set when the inputs were invalid (the step then fails with an error). |
| `flag-count` | Number of flags raised on the run, of any severity. |
| `max-severity` | Highest flag severity on the run (`low`, `medium`, `high`, `critical`) or `none`. |
| `report-file` | Absolute path of the written report, or an empty string. |

## Job summary

Every run adds a summary to the workflow run page: the verdict, the task title, a table of flags and the rule violations. The task title, flag messages and evidence come from the pages the agent visited, so they are untrusted: the action redacts secrets and escapes all Markdown and HTML before writing them, and keeps them from being interpreted as workflow commands in the log.

## Example `steplight.rules.yml`

```yaml
max_steps: 40               # fail if the run took more steps than this
max_severity: medium        # fail on any flag more severe than this
must_visit:                 # each entry must appear in a visited URL path or query
  - /checkout
must_not_visit_domains:     # fail if the agent contacted these domains (or subdomains)
  - evil.example
  - analytics.example
no_stuck_loops: true        # fail if the agent repeated the same action
```

Unknown keys are rejected, so a typo cannot silently disable a check.

## Privacy

The action reads files from the runner's workspace and writes the report and job summary there. It does not send runs, reports or anything else off the runner, and it contains no analytics. Runs are redacted when they are recorded; the action redacts again before anything reaches the log or the summary. Encrypted runs are not supported by the action (decrypt them in a trusted step first).

## About

Part of [Steplight](https://github.com/steplight-dev/steplight), a flight recorder for AI agents that drive a browser: record, replay, and flag prompt injection and data exfiltration. Licensed under Apache-2.0. See [SECURITY.md](SECURITY.md) to report a vulnerability.
