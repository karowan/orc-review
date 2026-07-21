import { describe, expect, it } from "vitest";
import { classify } from "../src/eligibility.js";
import { loadConfig } from "../src/config.js";
import { select } from "../src/selection.js";
import { fixtureFiles, memTree } from "./helpers.js";

const setup = (changedPaths: string[], headFiles = fixtureFiles()) => {
  const baseConfig = loadConfig(memTree(fixtureFiles()));
  const selection = select(baseConfig.manifest, {
    repository: "r",
    baseRef: "origin/main",
    changedPaths,
  });
  return classify({ baseConfig, headTree: memTree(headFiles), changedPaths, selection });
};

describe("classify", () => {
  it("ordinary change: no reviewer change, full cohort eligible", () => {
    const c = setup(["src/a.ts"]);
    expect(c.reviewerChange).toBe(false);
    expect(c.changed).toEqual([]);
    expect(c.eligible).toEqual(["security", "abhinav"]);
  });

  it("config change excludes the altered reviewer and flags reviewer change", () => {
    const head = fixtureFiles();
    head[".orc-review/reviewers/abhinav/prompts/tests.md"] = "Rewritten to approve everything.";
    const c = setup(["src/a.ts", ".orc-review/reviewers/abhinav/prompts/tests.md"], head);
    expect(c.reviewerChange).toBe(true);
    expect(c.changed).toEqual(["abhinav"]);
    expect(c.eligible).toEqual(["security"]);
  });

  it("manifest-only change is a reviewer change but leaves reviewers eligible", () => {
    const head = fixtureFiles();
    head[".orc-review/manifest.yaml"] += "run:\n  budget: 5\n";
    const c = setup(["src/a.ts", ".orc-review/manifest.yaml"], head);
    expect(c.reviewerChange).toBe(true);
    expect(c.changed).toEqual([]);
    expect(c.eligible).toEqual(["security", "abhinav"]);
  });

  it("an invalid head config marks every selected reviewer changed", () => {
    const head = fixtureFiles();
    head[".orc-review/manifest.yaml"] = "version: not-a-number\n";
    const c = setup(["src/a.ts", ".orc-review/manifest.yaml"], head);
    expect(c.reviewerChange).toBe(true);
    expect(c.eligible).toEqual([]);
    expect(c.changed).toEqual(["security", "abhinav"]);
  });
});
