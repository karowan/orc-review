# Publishing orc-review to npm

`orc-review` publishes publicly (unscoped — the name is free on npm). The
tarball ships built `dist/` only; the bin is `dist/cli.js`.

## Publish

1. Publish the orc workspace first (see orc's PUBLISHING.md) — this package
   depends on `@karowanorg/orc-*@^0.1.1` existing on the registry.
2. Here:

   ```sh
   npm test
   npm publish        # prepack builds; package metadata already uses registry ranges
   ```

## Versioning

Manual: bump `version` and keep the runtime dependency ranges in `package.json`
in step with the published orc line. Registry ranges must remain in the checked-in
manifest: npm reads publish metadata before `prepack` runs.
