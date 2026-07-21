/**
 * Repo sources: schemes that materialize one repository's change locally and
 * pin it. `git` (a local checkout) is built in; custom sources register via
 * `orc-review.config.(mjs|js)` — the one explicit extension seam, mirroring
 * orc's own no-ambient-scanning philosophy.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { RepoPin, RepoSource } from "./contracts.js";
import {
  baseSha,
  changedPaths,
  headSha,
  refTree,
  repoToplevel,
  worktreeState,
  worktreeTree,
} from "./git.js";

/** One parsed `--repo` argument: `[id=][scheme:]spec[@base]`. */
export interface RepoArg {
  id?: string;
  source: string;
  spec: string;
  base?: string;
}

const SCHEME_RE = /^([a-z][a-z0-9_-]*):(.*)$/;

/**
 * Parses `[id=][scheme:]spec[@base]`. Windows-style single-letter "schemes"
 * and plain paths fall through to the git source. `@base` splits on the LAST
 * `@` so specs like `github:org/repo` with an embedded `@` still work.
 */
export function parseRepoArg(raw: string): RepoArg {
  let rest = raw;
  let id: string | undefined;
  const eq = rest.indexOf("=");
  if (eq > 0 && !rest.slice(0, eq).includes("/") && !rest.slice(0, eq).includes(":")) {
    id = rest.slice(0, eq);
    rest = rest.slice(eq + 1);
  }
  let base: string | undefined;
  const at = rest.lastIndexOf("@");
  if (at > 0) {
    base = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }
  const m = SCHEME_RE.exec(rest);
  if (m && m[1].length > 1) return { id, source: m[1], spec: m[2], base };
  return { id, source: "git", spec: rest, base };
}

export function gitSource(): RepoSource {
  return {
    name: "git",
    resolve(spec, opts) {
      const toplevel = repoToplevel(spec);
      const baseLabel = opts.base ?? "origin/main";
      const state = worktreeState(toplevel);
      const pinned = baseSha(toplevel, baseLabel);
      const dirtyNote = state.dirty
        ? ` — INCLUDES uncommitted work; run \`git diff ${pinned.slice(0, 12)}\`${
            state.untracked.length > 0
              ? `; untracked files are part of the change: ${state.untracked.slice(0, 30).join(", ")}${state.untracked.length > 30 ? ", …" : ""}`
              : ""
          }`
        : ` — run \`git diff ${pinned.slice(0, 12)}...HEAD\``;
      return {
        id: opts.id ?? path.basename(toplevel),
        root: toplevel,
        baseLabel,
        baseSha: pinned,
        headSha: headSha(toplevel),
        fingerprint: state.fingerprint,
        dirty: state.dirty,
        untracked: state.untracked,
        changedPaths: changedPaths(toplevel, baseLabel),
        diffBriefing: `change from ${baseLabel} (pinned ${pinned.slice(0, 12)}) to the working tree${dirtyNote}`,
        configTree: refTree(toplevel, baseLabel),
        headTree: worktreeTree(toplevel),
      };
    },
  };
}

/** Loads `orc-review.config.(mjs|js)` from a directory, if present. */
export async function loadToolConfig(dir: string): Promise<{ repoSources?: RepoSource[] }> {
  for (const name of ["orc-review.config.mjs", "orc-review.config.js"]) {
    const abs = path.join(dir, name);
    if (fs.existsSync(abs)) {
      const mod = await import(pathToFileURL(abs).href);
      return (mod.default ?? mod) as { repoSources?: RepoSource[] };
    }
  }
  return {};
}

/** Identity helper for config authors. */
export function defineRepoSource(source: RepoSource): RepoSource {
  return source;
}

export async function sourceRegistry(cwd: string): Promise<Map<string, RepoSource>> {
  const registry = new Map<string, RepoSource>([["git", gitSource()]]);
  const config = await loadToolConfig(cwd);
  for (const source of config.repoSources ?? []) {
    if (registry.has(source.name) && source.name === "git") {
      throw new Error(`custom repo source may not shadow the built-in "git" source`);
    }
    registry.set(source.name, source);
  }
  return registry;
}

/** Resolves every `--repo` argument to a pin, erroring on unknown schemes and duplicate ids. */
export async function resolvePins(args: RepoArg[], cwd: string): Promise<RepoPin[]> {
  const registry = await sourceRegistry(cwd);
  const pins: RepoPin[] = [];
  const seen = new Set<string>();
  for (const arg of args) {
    const source = registry.get(arg.source);
    if (!source) {
      throw new Error(
        `unknown repo source "${arg.source}" (registered: ${[...registry.keys()].join(", ")})`,
      );
    }
    const pin = await source.resolve(arg.spec, { id: arg.id, base: arg.base });
    if (seen.has(pin.id)) throw new Error(`duplicate repo id "${pin.id}" — alias one with id=<spec>`);
    seen.add(pin.id);
    pins.push(pin);
  }
  return pins;
}
