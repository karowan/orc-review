import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";
import { plannerPrompt } from "../src/planner.js";
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

  it("compiles and exposes an exact model allowlist", () => {
    const files = fixtureFiles();
    files[".orc-review/manifest.yaml"] += `
model_policy:
  allowed:
    - { harness: claude, model: claude-fable-5 }
    - { harness: claude, model: claude-opus-4-8 }
    - { harness: claude, model: claude-sonnet-5 }
    - { harness: codex, model: gpt-5.6-sol, effort: high }
  preferences:
    - harness: codex
      model: gpt-5.6-sol
      effort: high
      metadata:
        speed: fast
        cost: medium
        intelligence: high
        best_for: deep review
        custom: { cache_affinity: warm }
`;
    files[".orc-review/reviewers/security.md"] = files[".orc-review/reviewers/security.md"].replace(
      "model: claude-fable-5",
      "harness: claude\nmodel: claude-fable-5",
    );
    files[".orc-review/reviewers/abhinav/reviewer.yaml"] = files[
      ".orc-review/reviewers/abhinav/reviewer.yaml"
    ].replaceAll("    model:", "    harness: claude\n    model:");

    const config = loadConfig(memTree(files));
    expect(config.manifest.modelPolicy?.allowed).toContainEqual({
      harness: "codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    });
    expect(config.manifest.modelPolicy?.preferences).toEqual([
      {
        harness: "codex",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        metadata: {
          speed: "fast",
          cost: "medium",
          intelligence: "high",
          best_for: "deep review",
          custom: { cache_affinity: "warm" },
        },
      },
    ]);
    expect(
      plannerPrompt({
        reviewers: config.reviewers,
        facts: { repository: "repo", baseRef: "main", changedPaths: ["src/a.ts"] },
        matchedRules: [],
        modelPolicy: config.manifest.modelPolicy,
      }),
    ).toContain('"cache_affinity": "warm"');
  });

  it("requires every model preference to be allowed", () => {
    const files = fixtureFiles();
    files[".orc-review/manifest.yaml"] += `
model_policy:
  allowed:
    - { harness: codex, model: gpt-5.6-sol, effort: high }
  preferences:
    - harness: codex
      model: gpt-5.6-sol
      effort: xhigh
      metadata: { speed: slow }
`;
    expect(problemsOf(files).join("\n")).toContain(
      "model_policy.preferences uses codex/gpt-5.6-sol/xhigh, which model_policy.allowed does not permit",
    );
  });

  it("rejects configured model calls outside model_policy.allowed", () => {
    const files = fixtureFiles();
    files[".orc-review/manifest.yaml"] += `
model_policy:
  allowed:
    - { harness: codex, model: gpt-5.6-sol, effort: high }
`;
    expect(problemsOf(files).join("\n")).toContain(
      "reviewer security lane security/prompt uses <unset harness>/claude-fable-5, which model_policy.allowed does not permit",
    );
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
