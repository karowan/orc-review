import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";
import { fixtureFiles, memTree } from "./helpers.js";

const problemsOf = (files: Record<string, string>): string[] => {
  try {
    loadConfig(memTree(files));
    return [];
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
};

describe("loadConfig", () => {
  it("compiles the fixture", () => {
    const config = loadConfig(memTree(fixtureFiles()));
    expect(config.reviewers.map((r) => r.id)).toEqual(["security", "abhinav"]);
    const security = config.reviewers[0];
    expect(security.lanes).toHaveLength(1);
    expect(security.lanes[0].model).toBe("claude-fable-5");
    expect(security.lanes[0].promptKey).toBe("security/prompt");
    expect(security.canBlock).toBe(true);
    const abhinav = config.reviewers[1];
    expect(abhinav.displayName).toBe("Abhinav");
    expect(abhinav.lanes.map((l) => l.promptKey)).toEqual(["abhinav/lanes/0", "abhinav/lanes/1"]);
    expect(abhinav.aggregationNotes).toContain("Adjudicate");
    expect(abhinav.paths.length).toBeGreaterThan(2);
  });

  it("accepts rev 1's synthesis: block as an aggregation_notes alias", () => {
    const files = fixtureFiles();
    files[".orc-review/reviewers/abhinav/reviewer.yaml"] = files[
      ".orc-review/reviewers/abhinav/reviewer.yaml"
    ].replace("aggregation_notes: prompts/adjudicate.md", "synthesis:\n  prompt: prompts/adjudicate.md");
    const config = loadConfig(memTree(files));
    expect(config.reviewers[1].aggregationNotes).toContain("Adjudicate");
  });

  it("multi-lane composites no longer require adjudication", () => {
    const files = fixtureFiles();
    files[".orc-review/reviewers/abhinav/reviewer.yaml"] = files[
      ".orc-review/reviewers/abhinav/reviewer.yaml"
    ].replace(/aggregation_notes:.*\n/, "");
    const config = loadConfig(memTree(files));
    expect(config.reviewers[1].aggregationNotes).toBeUndefined();
  });

  it("rejects unknown fields (closed schema)", () => {
    const files = fixtureFiles();
    files[".orc-review/manifest.yaml"] += "\nmystery: true\n";
    expect(problemsOf(files).join()).toMatch(/mystery|unrecognized/i);
  });

  it("requires fail-closed planning when max_calls is configured", () => {
    const files = fixtureFiles();
    files[".orc-review/manifest.yaml"] += "\nplanner:\n  max_calls: 2\n";
    expect(problemsOf(files).join()).toContain("planner.max_calls requires planner.required: true");
  });

  it("rejects duplicate reviewer ids", () => {
    const files = fixtureFiles();
    files[".orc-review/manifest.yaml"] = files[".orc-review/manifest.yaml"].replace(
      "  - id: abhinav",
      "  - id: security\n    source: reviewers/security.md\n  - id: abhinav",
    );
    expect(problemsOf(files).join()).toContain("duplicate reviewer id security");
  });

  it("rejects rules referencing unknown reviewers", () => {
    const files = fixtureFiles();
    files[".orc-review/manifest.yaml"] = files[".orc-review/manifest.yaml"].replace(
      "add: [abhinav]",
      "add: [ghost]",
    );
    expect(problemsOf(files).join()).toContain("rule backend adds unknown reviewer ghost");
  });

  it("rejects unconfined source paths", () => {
    const files = fixtureFiles();
    files[".orc-review/manifest.yaml"] = files[".orc-review/manifest.yaml"].replace(
      "source: reviewers/security.md",
      "source: ../../etc/passwd.md",
    );
    expect(problemsOf(files).join()).toContain("not confined");
  });

  it("rejects multi-document manifests", () => {
    const files = fixtureFiles();
    files[".orc-review/manifest.yaml"] += "\n---\nversion: 2\n";
    expect(problemsOf(files).join()).toContain("exactly one YAML document");
  });

  it("rejects prompt paths escaping the reviewer directory", () => {
    const files = fixtureFiles();
    files[".orc-review/reviewers/abhinav/reviewer.yaml"] = files[
      ".orc-review/reviewers/abhinav/reviewer.yaml"
    ].replace("prompts/correctness.md", "../security.md");
    expect(problemsOf(files).join()).toContain("escapes the reviewer directory");
  });

  it("rejects a missing manifest", () => {
    expect(problemsOf({})).toEqual([".orc-review/manifest.yaml not found"]);
  });

  it("content hashes differ when a prompt changes", () => {
    const a = loadConfig(memTree(fixtureFiles())).reviewers[1].contentHash;
    const files = fixtureFiles();
    files[".orc-review/reviewers/abhinav/prompts/tests.md"] += " Also check flaky retries.";
    const b = loadConfig(memTree(files)).reviewers[1].contentHash;
    expect(a).not.toBe(b);
  });
});
