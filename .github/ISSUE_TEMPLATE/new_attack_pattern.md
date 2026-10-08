---
name: New attack pattern
about: A prompt-injection or exfiltration technique Steplight misses (or flags wrongly)
title: "[attack] "
labels: detector, red-team
---

**Technique**
<!-- One line, e.g. "instruction hidden in a CSS ::before content" -->

**How it hides the instruction**
<!-- Where does the text live and why can a human not see it, but an agent can? -->

**Minimal page** (harmless: it should only ask the agent to do something observable, such as opening a URL)
```html

```

**What Steplight does today**
- [ ] Not flagged (missed)
- [ ] Flagged at the wrong severity (expected: ____ , got: ____)
- [ ] False positive on a normal page (paste the page structure)

**Which agents read it this way**
<!-- Raw HTML / accessibility tree / screenshots / innerText / DOM serialisation -->

**Source or reference** (optional)

**Willing to contribute?**
- [ ] I can add a red-team page (`packages/redteam/src/attacks.ts`) and a detector test (see CONTRIBUTING.md)
