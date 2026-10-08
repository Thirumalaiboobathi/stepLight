# steplight (CLI)

Command line for [Steplight](https://github.com/steplight-dev/steplight), a flight recorder for AI agents that drive a browser.

```bash
npm install -g @steplight/cli
steplight view                 # local replay viewer on 127.0.0.1
steplight check --latest       # fail CI when a run breaks your rules
steplight report <runId>       # single-file HTML report
```

Also: `diff`, `replay-script`, `export --otlp`, `redteam`, `purge`, `audit`, `decrypt`. The viewer is bundled; no network access is needed. Docs and security policy: https://github.com/steplight-dev/steplight. Apache-2.0.
