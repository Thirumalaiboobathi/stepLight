# Releasing the GitHub Action

The Action ships from a **separate public repository**, [steplight-dev/steplight-check-action](https://github.com/steplight-dev/steplight-check-action), which holds only built files. The source of truth is [packages/check-action](../packages/check-action) in this monorepo. GitHub Marketplace requires a public repository with one `action.yml` at its root and no workflow files, so nothing else lives there.

What the public repository contains (enforced by the assemble script):

```
action.yml          name, description (≤ 125 chars), author, branding, inputs, outputs, runs
dist/index.js       the whole Action as one CommonJS bundle (esbuild, target node24)
dist/licenses.txt   licenses of the third-party code inside the bundle
README.md  LICENSE  SECURITY.md
```

## Release checklist

1. **Change the source** in `packages/check-action/src` (or `publish/` for the README, `action.yml`, `SECURITY.md`). Keep `runs.using` in `publish/action.yml` and `TARGET` in `scripts/build.mjs` equal (a test checks this).
2. **Verify** from the repository root:
   ```bash
   pnpm lint && pnpm -r build && pnpm --filter @steplight/check-action test
   ```
3. **Assemble** the public repository contents:
   ```bash
   pnpm --filter @steplight/check-action assemble
   ```
   It rebuilds the bundle, validates `action.yml`, writes `out/check-action/`, deletes anything not on the allow-list (a `.git` folder is kept) and prints every file with its size. It fails if a workflow file or any other stray file would end up in the output.
4. **Push** the result. The first time: `git init -b main` inside `out/check-action/`, add the remote `https://github.com/steplight-dev/steplight-check-action.git`. Afterwards, from `out/check-action/`:
   ```bash
   git add -A && git commit -m "Steplight Agent Check vX.Y.Z" && git push origin main
   ```
5. **Tag** the commit with the exact version and move the major tag:
   ```bash
   git tag vX.Y.Z
   git tag -f vMAJOR              # e.g. v1: always the newest compatible release
   git push origin vX.Y.Z
   git push -f origin vMAJOR      # the only force-push in the process
   ```
6. **Create the GitHub release** for `vX.Y.Z` with notes (what changed, any input or output change):
   ```bash
   gh release create vX.Y.Z --repo steplight-dev/steplight-check-action --title vX.Y.Z --notes-file notes.md --verify-tag
   ```
   The CLI cannot publish to the Marketplace; that is step 8.
7. **Prove it on GitHub.** Update the SHA in the throwaway test repository `Thirumalaiboobathi/steplight-action-test` (`.github/workflows/test.yml`, pinned by commit SHA) and run `gh workflow run test.yml`. All jobs (clean run passes, hijacked run fails, `fail-on`, SARIF/JUnit files, traversal rejected) must be green.
8. **Marketplace (web UI, once per release you want listed):** on GitHub open the repository, then **Releases → Draft a new release** (or edit the `vX.Y.Z` release), tick **Publish this Action to the GitHub Marketplace**, fix any warnings shown about `action.yml`, choose the primary category (for example *Security*) and optionally a second one, check the box accepting the Marketplace Developer Agreement (first time only), and click **Publish release** (two-factor authentication is required).

## Rules of thumb

- **Never edit `out/check-action` by hand.** Change the source and assemble again; the output is reproducible (two builds of the same source give a byte-identical `dist/index.js`).
- **A published tag is permanent.** Fix a bad release with a new patch version; only the moving major tag (`v1`) is ever re-pointed.
- **No secrets, no tokens** are involved: the Action reads files in the workspace and makes no network calls (a test inspects the bundle for network modules).
- **The README example needs a real commit SHA.** The release commit cannot contain its own SHA, so the README tells users how to resolve it (`git ls-remote … vX.Y.Z`); the release notes and the test repository show the concrete SHA.
- **Name and branding:** the Marketplace name is "Steplight Agent Check" (checked as unused on 2026-10-08; it must not equal a GitHub user or organisation name, and `steplight` already exists as a user, so the bare name would not do). Icon `shield`, colour `purple` (Feather icon set).
- **Moving the repository** to a Steplight organisation later: GitHub redirects the old URL, but update the `uses:` lines in the README, this document and the test repository.
