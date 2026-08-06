/**
 * The composed review workspace: one directory of symlinks, one per repo pin,
 * plus the per-review tool caches. Uniform for N = 1 — there is no
 * single-vs-multi mode anywhere. Lanes run read-only with this directory as
 * cwd and address repos as `<id>/…`.
 *
 * A workspace is scratch. It has to be removable when the review ends and
 * re-creatable if the same change is reviewed again, and neither held: Go
 * installs its module cache read-only, `fs.rmSync` will not delete a read-only
 * tree, and the directory is named after the change. So a single review that
 * fetched Go modules left a workspace that could never be cleared and a change
 * that could never be reviewed again — every retry died on ENOTEMPTY — while
 * abandoned workspaces grew to 211 GB on one host.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RepoPin } from "./contracts.js";

export function workspaceRoot(): string {
  return path.join(os.homedir(), ".orc-review", "workspaces");
}

/**
 * Remove a workspace, including trees a package manager made read-only.
 *
 * `fs.rmSync` does not chmod, so one read-only entry stops the whole removal
 * with ENOTEMPTY. Restore write permission first, skipping symlinks: a
 * workspace is mostly symlinks to the caller's real checkouts, and `chmod`
 * follows them, so relaxing one would change permissions outside the
 * workspace — on the reviewed repository itself.
 */
export function discardWorkspace(dir: string): void {
  if (!fs.existsSync(dir)) return;
  const relax = (target: string): void => {
    let entries: fs.Dirent[];
    try {
      fs.chmodSync(target, 0o700);
      entries = fs.readdirSync(target, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const child = path.join(target, entry.name);
      if (entry.isDirectory()) relax(child);
      else {
        try {
          fs.chmodSync(child, 0o600);
        } catch {
          /* best effort — rmSync still reports whatever it cannot remove */
        }
      }
    }
  };
  relax(dir);
  fs.rmSync(dir, { recursive: true, force: true });
}

export function composeWorkspace(pins: RepoPin[], changeId: string): string {
  const dir = path.join(workspaceRoot(), changeId.replace(/[^a-zA-Z0-9_+-]/g, "_"));
  // Re-creatable: a leftover from an earlier attempt at this same change must
  // never make the change permanently unreviewable.
  discardWorkspace(dir);
  fs.mkdirSync(dir, { recursive: true });
  for (const pin of pins) {
    fs.symlinkSync(pin.root, path.join(dir, pin.id), "dir");
  }
  return dir;
}
