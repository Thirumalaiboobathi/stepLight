# Security policy

Steplight records what an AI agent does in a browser, so it handles sensitive data by design. We take
vulnerabilities seriously and try to make reporting them easy.

## Supported versions

| Version | Supported |
|---|---|
| latest `0.x` release | ✅ security fixes |
| older `0.x` releases | ❌ please upgrade |

Steplight is pre-1.0: only the latest release receives fixes. Once `1.0` ships, the latest minor of the
current and previous major will be supported.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting:
**<https://github.com/steplight/steplight/security/advisories/new>** (Security tab → *Report a vulnerability*).
This creates a private advisory visible only to the maintainers and you.

Helpful details: affected package and version (`@steplight/core`, `sdk`, `cli`, `redteam`, or the Chrome extension),
what an attacker needs (a malicious web page? a local process? a malicious exported file?), steps to reproduce or a
proof of concept (a small HTML page is ideal — see `packages/redteam` for how we build attack pages), and the impact
you expect. If you are unsure whether something is a vulnerability, report it anyway.

## What to expect

| Step | Target |
|---|---|
| Acknowledgement that we received your report | within 3 business days |
| First assessment (accepted, need more information, or not a vulnerability) | within 7 days |
| Fix or mitigation for **critical** issues (data exposure, code execution) | within 14 days |
| Fix or mitigation for **high** issues | within 30 days |
| Fix for **medium / low** issues | within 90 days, in a regular release |
| Public disclosure | after a fix is released, coordinated with you; by default no later than 90 days after your report |

We will keep you informed, credit you in the advisory and release notes if you wish, and will not take legal action
against good-faith research that follows this policy (do not access other people's data, do not degrade services,
test against your own installation).

## Scope

In scope: the extension, CLI (including its local HTTP server and viewer), SDK, core library (redaction, detectors,
storage, encryption, exports), the HTML report, and the build and release workflows in this repository.

Particularly interesting to us:

- a page that makes the viewer, a report or the extension execute script or leak data (XSS, CSP bypass);
- anything that lets a web page or another local process read, write or delete Steplight data without the pairing token;
- secrets or personal data reaching disk, exports or logs unredacted, or password / card / OTP fields being captured;
- encryption or password-protected export flaws (nonce reuse, key exposure, downgrade);
- ways to make Steplight hang or crash the browser or agent (for example regular expressions with catastrophic backtracking);
- supply chain problems: unpinned actions, workflow permission escalation, malicious dependencies.

Out of scope: attacks that need full control of the user's account or machine (malware running as the user, a modified
build), social engineering, missed detections of new prompt-injection techniques (please file those with the
*New attack pattern* issue template instead — detectors are heuristic and English-only, and that is documented),
and findings in third-party dependencies that are not reachable from Steplight (report those upstream).

## Verifying what you install

- npm packages are published from GitHub Actions with **provenance**: run `npm audit signatures` to verify them.
- Each push to `main` and each release produces a **CycloneDX SBOM** (`sbom.yml` workflow artifact).
- All GitHub Actions in this repository are pinned to commit SHAs, workflows run with read-only permissions, and
  `pnpm audit --audit-level=high` runs on every dependency change and weekly.
- The design and its limits are described in [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md); organisation controls in
  [docs/enterprise.md](docs/enterprise.md); what the extension collects in [PRIVACY.md](PRIVACY.md).
