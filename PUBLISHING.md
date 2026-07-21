# Publishing orc-review to npm

`orc-review` publishes publicly (unscoped — the name is free on npm). The
tarball ships built `dist/` only; the bin is `dist/cli.js`.

## The file:/semver dance

The repo keeps `file:../orc/packages/*` dependencies so sibling-checkout
development works with zero setup. npm's `prepack`/`postpack` hooks
(`scripts/publish-deps.mjs`) swap them to `^0.1.1` inside the tarball and
restore the working copy afterward — `npm publish` does the right thing with
no manual step. Consumers therefore install the published `@karowanorg/orc-*` packages;
only this repo's own checkout needs `../orc`.

## Publish

1. Publish the orc workspace first (see orc's PUBLISHING.md) — this package
   depends on `@karowanorg/orc-*@^0.1.1` existing on the registry.
2. Here:

   ```sh
   npm test
   npm publish        # prepack builds + swaps deps; postpack restores
   ```

## Versioning

Manual: bump `version`, keep the `^0.1.1` range in `scripts/publish-deps.mjs`
in step with the published orc line.
