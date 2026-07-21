import { describe, expect, it } from "vitest";
import { matchChangedPath, select } from "../src/selection.js";
import { loadConfig } from "../src/config.js";
import { fixtureFiles, memTree } from "./helpers.js";

describe("matchChangedPath", () => {
  const cases: Array<[string, string, boolean]> = [
    ["**/*.go", "internal/api/server.go", true],
    ["**/*.go", "main.go", true], // ** spans zero segments
    ["**/*.go", "main.rs", false],
    ["src/**", "src/a/b/c.ts", true],
    ["docs/*.md", "docs/readme.md", true],
    ["docs/*.md", "docs/deep/readme.md", false], // * does not cross segments
    ["**/auth*/**", "internal/authz/rules.go", true],
    ["a/?/c", "a/b/c", true],
    ["a/[bc]/d", "a/c/d", true],
    ["a/[!bc]/d", "a/b/d", false],
    [".orc-review/**", ".orc-review/manifest.yaml", true],
  ];
  for (const [pattern, changed, want] of cases) {
    it(`${pattern} vs ${changed} → ${want}`, () => {
      expect(matchChangedPath(pattern, changed)).toBe(want);
    });
  }

  it("matches src/** against src itself via zero-span", () => {
    // Go semantics: ["src","**"] vs ["src"] — "**" spans zero segments, then
    // both are exhausted ⇒ true. Pin the ported behavior explicitly.
    expect(matchChangedPath("src/**", "src")).toBe(true);
  });
});

describe("select", () => {
  const config = loadConfig(memTree(fixtureFiles()));
  const facts = (paths: string[]) => ({ repository: "r", baseRef: "origin/main", changedPaths: paths });

  it("always-only cohort when no rule matches", () => {
    const result = select(config.manifest, facts(["docs/readme.md"]));
    expect(result.reviewers).toEqual([{ id: "security", reasons: ["always"] }]);
    expect(result.matchedRules).toEqual([]);
  });

  it("union of always and matching rules, declaration order, sorted reasons", () => {
    const result = select(config.manifest, facts(["src/a.ts"]));
    expect(result.reviewers.map((r) => r.id)).toEqual(["security", "abhinav"]);
    expect(result.reviewers[1].reasons).toEqual(["rule:backend"]);
    expect(result.matchedRules).toEqual(["backend"]);
  });

  it("ignores unknown affinity ids, records known ones", () => {
    const result = select(config.manifest, facts([]), ["ghost", "abhinav"]);
    expect(result.reviewers.map((r) => r.id)).toEqual(["security", "abhinav"]);
    expect(result.reviewers[1].reasons).toEqual(["affinity"]);
  });
});
