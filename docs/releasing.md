# Releasing the npm packages

`@steplight/core`, `@steplight/sdk`, `@steplight/redteam` and `@steplight/cli` are published by the **Release** workflow ([.github/workflows/release.yml](../.github/workflows/release.yml)) when a version tag is pushed. Nobody publishes from a laptop, and there is no npm token anywhere: the workflow uses npm **trusted publishing** (GitHub OIDC), which also attaches a signed provenance statement to every version.

(The GitHub Action is released separately: see [releasing-action.md](releasing-action.md).)

## One-time setup (done)

- On npmjs.com, each of the four packages has a Trusted Publisher: repository `steplight-dev/steplight`, workflow `release.yml`, environment `npm-release`. A newly added publisher stays "Pending validation" until the first successful CI publish uses it.
- On GitHub, the environment `npm-release` exists in `steplight-dev/steplight` and only deploys from tags matching `v*`. Add required reviewers there if you want a human approval before every publish.
- The repository has no secrets. A test (`packages/cli/src/supplychain.test.ts`) fails if a workflow references `secrets.*`, `NPM_TOKEN` or `NODE_AUTH_TOKEN`.

## Cutting a release

1. Decide the version. Final: `0.1.0`. Pre-release: `0.1.0-rc.1`, `0.1.0-rc.2`, …
2. Set it in **four** places (a test checks they agree): `version` in `packages/{core,sdk,cli,redteam}/package.json`, `VERSION` in `packages/core/src/index.ts`, and `.version(...)` in `packages/cli/src/index.ts`.
3. Verify locally: `pnpm lint && pnpm -r build && pnpm -r test`.
4. Check what would be published. Pack each package and look at the file list; only `dist/`, `package.json`, `README.md` and `LICENSE` may appear (plus `viewer-dist/` for the CLI):
   ```bash
   mkdir -p /tmp/tarballs && for p in core redteam sdk cli; do pnpm --filter @steplight/$p pack --pack-destination /tmp/tarballs; done
   for t in /tmp/tarballs/*.tgz; do tar -tzf "$t"; done
   ```
5. Commit, push `main`, wait for CI to be green, then tag and push the tag (the tag must be `v` plus the exact version):
   ```bash
   git tag v0.1.0-rc.2 && git push origin v0.1.0-rc.2
   ```
6. Watch it: `gh run watch` (Release workflow). The `verify` job lints, builds, tests and packs; the `publish` job (the only one with `id-token: write`, and the only one in the `npm-release` environment) publishes exactly those tarballs.
7. Check the result:
   ```bash
   for p in core sdk cli redteam; do npm view @steplight/$p dist-tags --json; done
   npm view @steplight/core@0.1.0-rc.2 dist.attestations   # provenance attestation
   ```

## Dist-tags

A tag that contains `-` (a pre-release) is published with `--tag next`, so `latest` keeps pointing at the last final release. A tag without `-` is published as `latest`. To move a dist-tag by hand later you need an npm session with publish rights; the workflow never does it.

## If a publish fails

Read the log (`gh run view --log-failed`), fix the cause, and release the **next** version (`rc.2`): a version that npm accepted can never be published again, and a partly published set (for example `core` published but `cli` failed) is completed by the next version, not by re-running. Typical causes: the trusted publisher on npmjs.com does not match the workflow file or environment name exactly; npm older than 11.5 (the workflow uses Node 24); the package's `repository.url` not matching the repository (provenance requires it).

## Rules of thumb

- Never run `npm publish` locally.
- Publish order is `core`, `redteam`, `sdk`, `cli`, so dependencies exist before the packages that need them.
- The extension and the viewer are private; the Chrome Web Store package is built with `pnpm --filter @steplight/extension package`.
