# Publishing orc-review to npm

`orc-review` publishes publicly (unscoped — the name is free on npm). The
tarball ships built `dist/` only; the bin is `dist/cli.js`.

## The file:/semver dance

The repo keeps `file:../orc/packages/*` dependencies so sibling-checkout
development works with zero setup. npm's `prepack`/`postpack` hooks
(`scripts/publish-deps.mjs`) swap them to `^0.1.0` inside the tarball and
restore the working copy afterward — `npm publish` does the right thing with
no manual step. Consumers therefore install the published `@orc/*` packages;
only this repo's own checkout needs `../orc`.

## Publish

1. Publish the orc workspace first (see orc's PUBLISHING.md) — this package
   depends on `@orc/*@^0.1.0` existing on the registry.
2. Here:

   ```sh
   npm test
   npm publish        # prepack builds + swaps deps; postpack restores
   ```

If the `@orc` scope ends up renamed at publish time, the same rename sweep in
orc's PUBLISHING.md covers this repo's imports and dependencies.

## Versioning

Manual: bump `version`, keep the `^0.1.0` range in `scripts/publish-deps.mjs`
in step with the published orc line.
