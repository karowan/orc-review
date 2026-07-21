/**
 * The composed review workspace: one directory of symlinks, one per repo pin.
 * Uniform for N = 1 — there is no single-vs-multi mode anywhere. Lanes run
 * read-only with this directory as cwd and address repos as `<id>/…`.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RepoPin } from "./contracts.js";

export function composeWorkspace(pins: RepoPin[], changeId: string): string {
  const dir = path.join(os.homedir(), ".orc-review", "workspaces", changeId.replace(/[^a-zA-Z0-9_+-]/g, "_"));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const pin of pins) {
    fs.symlinkSync(pin.root, path.join(dir, pin.id), "dir");
  }
  return dir;
}
