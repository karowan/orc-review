/**
 * The local bot registry: personal reviewer profiles under
 * `~/.orc-review/registry/`, called onto a run with `--with <name>`. Same
 * authoring formats as repo reviewers (`<name>.md` or `<name>/reviewer.yaml`
 * + prompts). Registry bots are advisory by construction — never required and
 * never granted publication authority by the repo. Their finding severities
 * remain intact so dry-run reviews preserve their full judgment.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ConfigError, compileReviewer } from "./config.js";
import type { CompiledReviewer, Tree } from "./contracts.js";

export function defaultRegistryDir(): string {
  return path.join(os.homedir(), ".orc-review", "registry");
}

const ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** A plain directory Tree (no git, symlinks skipped — same posture as worktreeTree). */
function dirTree(root: string): Tree {
  return {
    read(relPath) {
      const abs = path.join(root, relPath);
      try {
        const st = fs.lstatSync(abs);
        if (st.isSymbolicLink() || !st.isFile()) return null;
        return fs.readFileSync(abs, "utf8");
      } catch {
        return null;
      }
    },
    list(prefix) {
      const out: string[] = [];
      const walk = (rel: string) => {
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          const childRel = rel ? path.posix.join(rel, e.name) : e.name;
          if (e.isSymbolicLink()) continue;
          if (e.isDirectory()) walk(childRel);
          else if (e.isFile()) out.push(childRel);
        }
      };
      walk(prefix);
      return out.sort();
    },
  };
}

/** Lists the bot names available in a registry directory. */
export function listRegistry(registryDir = defaultRegistryDir()): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(registryDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = new Set<string>();
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith(".md")) names.add(e.name.slice(0, -3));
    else if (e.isDirectory()) names.add(e.name);
  }
  return [...names].filter((n) => ID_RE.test(n)).sort();
}

/**
 * Loads the named bots from the registry, forced advisory and labeled
 * "(local)". Throws ConfigError on unknown names or compile problems.
 */
export function loadLocalReviewers(
  names: string[],
  registryDir = defaultRegistryDir(),
): CompiledReviewer[] {
  const problems: string[] = [];
  const tree = dirTree(registryDir);
  const out: CompiledReviewer[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (!ID_RE.test(name)) {
      problems.push(`registry bot name "${name}" must match [a-z0-9][a-z0-9_-]*`);
      continue;
    }
    const source =
      tree.read(`${name}.md`) !== null
        ? `${name}.md`
        : tree.read(`${name}/reviewer.yaml`) !== null
          ? name
          : null;
    if (source === null) {
      problems.push(
        `registry bot "${name}" not found in ${registryDir} (expected ${name}.md or ${name}/reviewer.yaml)`,
      );
      continue;
    }
    const compiled = compileReviewer(tree, name, source, false, problems);
    if (!compiled) continue;
    out.push({
      ...compiled,
      displayName: `${compiled.displayName} (local)`,
      required: false, // no repo-granted authority, ever
      canBlock: false,
    });
  }
  if (problems.length > 0) throw new ConfigError(problems);
  return out;
}
