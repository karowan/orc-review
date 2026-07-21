/**
 * Git-backed facts and trees. orc-review never materializes checkouts — it
 * reads the worktree it is given and pinned refs of that same repository.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Tree } from "./contracts.js";

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

export function headSha(dir: string): string {
  return git(dir, ["rev-parse", "HEAD"]).trim();
}

/** Resolves the pinned diff base: merge-base(baseRef, HEAD) — a SHA, never a branch name. */
export function baseSha(dir: string, baseRef: string): string {
  return git(dir, ["merge-base", baseRef, "HEAD"]).trim();
}

export interface WorktreeState {
  /** True when the worktree differs from HEAD (staged, unstaged, or untracked). */
  dirty: boolean;
  /** Digest over HEAD + index/worktree diff + untracked contents — the change identity. */
  fingerprint: string;
  untracked: string[];
}

/** Fingerprints the working tree so dirty reviews get their own identity. */
export function worktreeState(dir: string): WorktreeState {
  const head = headSha(dir);
  const diff = git(dir, ["diff", "HEAD"]);
  const untracked = git(dir, ["ls-files", "--others", "--exclude-standard"])
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .sort();
  const hash = createHash("sha256").update(head).update("\0").update(diff);
  for (const p of untracked) {
    hash.update(p).update("\0");
    try {
      hash.update(fs.readFileSync(path.join(repoToplevel(dir), p)));
    } catch {
      hash.update("<unreadable>");
    }
    hash.update("\0");
  }
  return {
    dirty: diff.trim().length > 0 || untracked.length > 0,
    fingerprint: hash.digest("hex"),
    untracked,
  };
}

export function repoToplevel(dir: string): string {
  return git(dir, ["rev-parse", "--show-toplevel"]).trim();
}

/** Merge-base–relative changed paths (base...HEAD plus uncommitted worktree changes). */
export function changedPaths(dir: string, baseRef: string): string[] {
  const committed = git(dir, ["diff", "--name-only", `${baseRef}...HEAD`]);
  const uncommitted = git(dir, ["diff", "--name-only", "HEAD"]);
  const untracked = git(dir, ["ls-files", "--others", "--exclude-standard"]);
  const all = new Set(
    [committed, uncommitted, untracked]
      .flatMap((s) => s.split("\n"))
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return [...all].sort();
}

/** A Tree view of a pinned ref (e.g. the trusted base). */
export function refTree(dir: string, ref: string): Tree {
  return {
    read(relPath) {
      try {
        return git(dir, ["show", `${ref}:${relPath}`]);
      } catch {
        return null;
      }
    },
    list(prefix) {
      try {
        return git(dir, ["ls-tree", "-r", "--name-only", ref, "--", prefix])
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean)
          .sort();
      } catch {
        return [];
      }
    },
  };
}

/** A Tree view of the working tree (used by `validate` while editing config). */
export function worktreeTree(dir: string): Tree {
  const root = repoToplevel(dir);
  return {
    read(relPath) {
      const abs = path.join(root, relPath);
      try {
        const st = fs.lstatSync(abs);
        if (st.isSymbolicLink() || !st.isFile()) return null; // symlinks rejected (ported)
        return fs.readFileSync(abs, "utf8");
      } catch {
        return null;
      }
    },
    list(prefix) {
      const out: string[] = [];
      const walk = (rel: string) => {
        const abs = path.join(root, rel);
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(abs, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          const childRel = path.posix.join(rel, e.name);
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
