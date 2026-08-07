/**
 * A workspace must be removable and re-creatable. Go installs its module cache
 * read-only, and `fs.rmSync` will not delete a read-only tree — so without a
 * chmod pass one review that fetched Go modules made its change permanently
 * unreviewable (every retry died on ENOTEMPTY) and leaked its cache forever.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { composeWorkspace, discardWorkspace } from "../src/workspace.js";
import type { RepoPin } from "../src/contracts.js";

function readOnlyCache(dir: string): void {
  const cache = path.join(dir, ".cache", "go-mod", "github.com", "aws@v1.42.1");
  fs.mkdirSync(cache, { recursive: true });
  const file = path.join(cache, "modman.toml");
  fs.writeFileSync(file, "readonly");
  fs.chmodSync(file, 0o444);
  fs.chmodSync(cache, 0o555);
}

function pin(root: string, id = "repo"): RepoPin {
  return { id, root } as RepoPin;
}

describe("workspace lifecycle", () => {
  it("discards a workspace whose Go module cache is read-only", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orc-ws-"));
    readOnlyCache(dir);
    expect(() => fs.rmSync(dir, { recursive: true, force: true })).toThrow(/ENOTEMPTY|EACCES/);
    discardWorkspace(dir);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("re-composes over a leftover workspace for the same change", () => {
    const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "orc-repo-"));
    const change = `retry-${process.pid}`;
    const first = composeWorkspace([pin(checkout)], change);
    readOnlyCache(first);
    // Same change again: the leftover must not make it unreviewable.
    const second = composeWorkspace([pin(checkout)], change);
    expect(second).toBe(first);
    expect(fs.existsSync(path.join(second, ".cache"))).toBe(false);
    expect(fs.lstatSync(path.join(second, "repo")).isSymbolicLink()).toBe(true);
    discardWorkspace(second);
    // The symlinked checkout itself must survive teardown untouched.
    expect(fs.existsSync(checkout)).toBe(true);
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  it("never follows a symlink out of the workspace when relaxing permissions", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "orc-outside-"));
    const guarded = path.join(outside, "keep");
    fs.writeFileSync(guarded, "precious");
    fs.chmodSync(guarded, 0o444);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orc-ws-"));
    fs.symlinkSync(outside, path.join(dir, "repo"), "dir");
    discardWorkspace(dir);
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(guarded)).toBe(true);
    expect(fs.statSync(guarded).mode & 0o200).toBe(0);  // still read-only
    fs.chmodSync(guarded, 0o600);
    fs.rmSync(outside, { recursive: true, force: true });
  });
});
