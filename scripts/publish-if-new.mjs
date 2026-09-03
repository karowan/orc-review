#!/usr/bin/env node
// Publish this package if its package.json version is not on the npm registry
// yet. Idempotent: an already-published version is skipped, so a re-run after
// a failed publish just tries again.
//
//   node scripts/publish-if-new.mjs           # publish (CI runs this via `npm run release`)
//   node scripts/publish-if-new.mjs --plan    # say whether it would publish; publish nothing
//   node scripts/publish-if-new.mjs --dry-run # npm publish --dry-run
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = new Set(process.argv.slice(2));
const plan = args.has("--plan");
const dryRun = args.has("--dry-run");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

function publishedVersions(name) {
  try {
    const out = execFileSync("npm", ["view", name, "versions", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parsed = out.trim() ? JSON.parse(out) : [];
    return Array.isArray(parsed) ? parsed : [parsed]; // a single-version package comes back as a string
  } catch (err) {
    if (`${err.stdout ?? ""}${err.stderr ?? ""}`.includes("E404")) return []; // never published
    throw err;
  }
}

const pending = publishedVersions(pkg.name).includes(pkg.version) ? 0 : 1;
console.log(
  pending === 0
    ? `nothing to publish: ${pkg.name}@${pkg.version} is already on the registry`
    : `${plan ? "would publish" : "publishing"} ${pkg.name}@${pkg.version}`,
);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `count=${pending}\n`);
if (plan || pending === 0) process.exit(0);

const npmArgs = ["publish", "--access", "public"];
// In CI: provenance, and verbose logs so a refused OIDC token exchange shows
// its real reason instead of surfacing as a bare ENEEDAUTH.
if (process.env.GITHUB_ACTIONS === "true") npmArgs.push("--provenance", "--loglevel=verbose");
if (dryRun) npmArgs.push("--dry-run");
execFileSync("npm", npmArgs, { cwd: root, stdio: "inherit" });
