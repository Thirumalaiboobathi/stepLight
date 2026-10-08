# @steplight/sdk

Record a Playwright-driven AI agent with [Steplight](https://github.com/steplight-dev/steplight): every page read, click, form submit and network request becomes a step, with prompt-injection and data-exfiltration flags.

```bash
npm install @steplight/sdk playwright
```

```js
import { steplight } from "@steplight/sdk";
const run = await steplight.record(page, { task: "Book the cheapest flight" });
// ... drive the page ...
await run.end("success");
```

Runs are redacted and stored as files under `.steplight/runs` on your machine (optionally encrypted). Nothing leaves the device. Docs: https://github.com/steplight-dev/steplight. Apache-2.0.
