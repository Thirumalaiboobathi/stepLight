# Security policy

This repository holds only the built GitHub Action. The source lives in the Steplight monorepo, and so does the security policy.

- **Report a vulnerability** privately through GitHub's *Report a vulnerability* button on the [Security tab](../../security/advisories/new) of this repository, or follow the policy in the main project's `SECURITY.md` ([steplight-dev/steplight](https://github.com/steplight-dev/steplight)). Please do not open a public issue for a vulnerability.
- **What to expect:** acknowledgement within 3 days, an assessment within 7 days, and a fix target of 14 days (critical), 30 days (high) or 90 days (other), with coordinated disclosure after at most 90 days.
- **Supported versions:** the latest `v1.x` release.
- **Scope of this action:** it reads a runs folder inside the workspace and writes a report and job summary there. It makes no network calls. Inputs are validated, paths are confined to `GITHUB_WORKSPACE`, and all run content is redacted and escaped before it reaches the log or the job summary.
- **Pin by commit SHA:** reference the action with a full commit SHA, not a moving tag, if your threat model requires it. Releases are tagged `vX.Y.Z`; `v1` moves with each compatible release.
