/**
 * prepack/postpack hook: the repo keeps file:../orc links for sibling-checkout
 * development (npm forbids overrides that conflict with direct deps), but the
 * published tarball must depend on the registry packages. `prepack` swaps
 * file: specs for semver and backs up the original; `postpack` restores it.
 */
import * as fs from "node:fs";

const PKG = new URL("../package.json", import.meta.url);
const BAK = new URL("../package.json.prepack-backup", import.meta.url);
const RANGES = {
  "@karowanorg/orc-core": "^0.1.2",
  "@karowanorg/orc-harness-claude": "^0.1.3",
  "@karowanorg/orc-harness-codex": "^0.1.3",
  "@karowanorg/orc-ops": "^0.1.2",
  "@karowanorg/orc-sdk": "^0.1.2",
};

const mode = process.argv[2];
if (mode === "swap") {
  fs.copyFileSync(PKG, BAK);
  const pkg = JSON.parse(fs.readFileSync(PKG, "utf8"));
  for (const [name, spec] of Object.entries(pkg.dependencies)) {
    if (name.startsWith("@karowanorg/orc-") && String(spec).startsWith("file:")) {
      pkg.dependencies[name] = RANGES[name] ?? "^0.1.1";
    }
  }
  fs.writeFileSync(PKG, `${JSON.stringify(pkg, null, 2)}\n`);
} else if (mode === "restore") {
  if (fs.existsSync(BAK)) {
    fs.copyFileSync(BAK, PKG);
    fs.rmSync(BAK);
  }
} else {
  console.error("usage: publish-deps.mjs swap|restore");
  process.exit(1);
}
