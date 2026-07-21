import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseRepoArg, resolvePins } from "../src/sources.js";
import { qualifyReviewer, prepare } from "../src/runner.js";
import { loadConfig } from "../src/config.js";
import { fixtureFiles, memTree } from "./helpers.js";

describe("parseRepoArg", () => {
  const cases: Array<[string, object]> = [
    [".", { id: undefined, source: "git", spec: ".", base: undefined }],
    ["~/code/liba", { id: undefined, source: "git", spec: "~/code/liba", base: undefined }],
    ["liba=~/code/liba@origin/main", { id: "liba", source: "git", spec: "~/code/liba", base: "origin/main" }],
    ["github:acme/liba#412", { id: undefined, source: "github", spec: "acme/liba#412", base: undefined }],
    ["x=github:acme/liba#412@main", { id: "x", source: "github", spec: "acme/liba#412", base: "main" }],
    ["./a/b=c", { id: undefined, source: "git", spec: "./a/b=c", base: undefined }], // "=" after "/" is not an alias
  ];
  for (const [raw, want] of cases) {
    it(raw, () => expect(parseRepoArg(raw)).toEqual(want));
  }
});

describe("qualifyReviewer", () => {
  it("namespaces id, display, lane keys, and paths", () => {
    const bot = loadConfig(memTree(fixtureFiles())).reviewers[1]; // abhinav
    const q = qualifyReviewer("liba", bot);
    expect(q.id).toBe("liba/abhinav");
    expect(q.displayName).toBe("Abhinav (liba)");
    expect(q.lanes.map((l) => l.promptKey)).toEqual(["liba/abhinav/lanes/0", "liba/abhinav/lanes/1"]);
    expect(q.paths.every((p) => p.startsWith("liba/.orc-review/"))).toBe(true);
    expect(bot.id).toBe("abhinav"); // original untouched
  });
});

// --- two-repo integration through prepare (template path, no model) ---------

function sh(dir: string, args: string[]): void {
  execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
}

function makeRepo(name: string, withConfig: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `orc-review-${name}-`));
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  sh(dir, ["config", "user.email", "t@t"]);
  sh(dir, ["config", "user.name", "t"]);
  if (withConfig) {
    fs.mkdirSync(path.join(dir, ".orc-review", "reviewers"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".orc-review", "manifest.yaml"),
      `version: 1\nreviewers:\n  - id: security\n    source: reviewers/security.md\nselection:\n  always: [security]\n`,
    );
    fs.writeFileSync(
      path.join(dir, ".orc-review", "reviewers", "security.md"),
      `---\nmodel: claude-sonnet-5\n---\nReview ${name} for security defects.\n`,
    );
  }
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "a.ts"), "export const a = 1;\n");
  sh(dir, ["add", "-A"]);
  sh(dir, ["commit", "-qm", "base"]);
  sh(dir, ["branch", "base"]);
  fs.writeFileSync(path.join(dir, "src", "a.ts"), "export const a = 2;\n");
  sh(dir, ["add", "-A"]);
  sh(dir, ["commit", "-qm", "change"]);
  return dir;
}

describe("prepare over a repo set", () => {
  it("composes two covered repos into one qualified cohort and template plan", async () => {
    const liba = makeRepo("liba", true);
    const appb = makeRepo("appb", true);
    const prepared = await prepare({
      repos: [`la=${liba}@base`, `ab=${appb}@base`],
      planner: null,
    });
    expect(prepared.pins.map((p) => p.id)).toEqual(["la", "ab"]);
    expect(prepared.eligible.map((r) => r.id)).toEqual(["la/security", "ab/security"]);
    expect(prepared.facts.changedPaths).toEqual(["ab/src/a.ts", "la/src/a.ts"]);
    expect(prepared.changeId.startsWith("set-")).toBe(true);
    expect(prepared.dirty).toBe(false);
    expect(prepared.plannerUsed).toBe("template");
    expect(prepared.programSource).toContain('PROMPTS["la/security/prompt"]');
    expect(prepared.programSource).toContain('PROMPTS["ab/security/prompt"]');
  });

  it("fails on an uncovered repo by default, skips it with allowUncovered", async () => {
    const liba = makeRepo("liba", true);
    const bare = makeRepo("bare", false);
    await expect(
      prepare({ repos: [`la=${liba}@base`, `nb=${bare}@base`], planner: null }),
    ).rejects.toThrow(/repo "nb"/);
    const prepared = await prepare({
      repos: [`la=${liba}@base`, `nb=${bare}@base`],
      planner: null,
      allowUncovered: true,
    });
    expect(prepared.uncovered).toEqual(["nb"]);
    expect(prepared.eligible.map((r) => r.id)).toEqual(["la/security"]);
  });

  it("marks the set dirty when any pin is dirty", async () => {
    const liba = makeRepo("liba", true);
    const appb = makeRepo("appb", true);
    fs.appendFileSync(path.join(appb, "src", "a.ts"), "// wip\n");
    const prepared = await prepare({ repos: [`la=${liba}@base`, `ab=${appb}@base`], planOnly: true });
    expect(prepared.dirty).toBe(true);
    expect(prepared.pins[1].dirty).toBe(true);
    expect(prepared.changeId.endsWith("+dirty")).toBe(true);
  });

  it("resolvePins rejects duplicate ids and unknown schemes", async () => {
    const liba = makeRepo("liba", true);
    await expect(
      resolvePins([parseRepoArg(`x=${liba}@base`), parseRepoArg(`x=${liba}@base`)], "."),
    ).rejects.toThrow(/duplicate repo id/);
    await expect(resolvePins([parseRepoArg("warp:foo")], ".")).rejects.toThrow(/unknown repo source "warp"/);
  });
});
