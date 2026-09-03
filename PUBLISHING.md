# Publishing orc-review to npm

`orc-review` publishes publicly (unscoped — the name is free on npm). The
tarball ships built `dist/` only; the bin is `dist/cli.js`.

## Publish

CI publishes. Bump `version` in `package.json` in a PR; when it merges to
`main`, the `publish` workflow (`.github/workflows/publish.yml`):

1. compares the version with the registry
   (`node scripts/publish-if-new.mjs --plan`),
2. if it is new, runs `npm run build && npm test`,
3. publishes with a provenance attestation (`npm run release`; `prepack`
   rebuilds `dist/`).

Re-running is safe: a version already on the registry is skipped. Trigger it
by hand from the Actions tab (`workflow_dispatch`) if a push was missed.

Auth is npm trusted publishing: the workflow presents its GitHub OIDC token
and npm mints a short-lived publish credential, so no token is stored
anywhere. One-time setup at `https://www.npmjs.com/package/orc-review/access`:

- Trusted Publisher → GitHub Actions
- Organization or user: `karowan`; Repository: `orc-review`;
  Workflow filename: `publish.yml`; Environment: leave blank
- Then set Publishing access to "Require two-factor authentication and
  disallow tokens" so trusted publishing is the only publish path.

Manual fallback from a logged-in machine (`npm login` first; same skip logic,
no provenance):

```sh
npm test
npm run release       # node scripts/publish-if-new.mjs → npm publish (prepack builds)
```

## Versioning

Manual: bump `version` and keep the runtime `@karowanorg/orc-*` dependency
ranges in `package.json` in step with the published orc line — when the
ranges move, orc publishes first (see orc's PUBLISHING.md). Registry ranges
must remain in the checked-in manifest: npm reads publish metadata before
`prepack` runs.
