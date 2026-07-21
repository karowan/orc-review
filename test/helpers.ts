import type { Tree } from "../src/contracts.js";

export function memTree(files: Record<string, string>): Tree {
  return {
    read: (p) => (p in files ? files[p] : null),
    list: (prefix) =>
      Object.keys(files)
        .filter((p) => p === prefix || p.startsWith(`${prefix}/`))
        .sort(),
  };
}

export const SIMPLE_REVIEWER = `---
model: claude-fable-5
can_block: true
---
You are the security reviewer. Hunt for injection, authz, and secret handling defects.`;

export const COMPOSITE_YAML = `display_name: Abhinav
can_block: true
planner_hints: escalate disagreements before synthesizing
lanes:
  - prompt: prompts/correctness.md
    model: claude-opus-4-8
  - prompt: prompts/tests.md
    model: claude-sonnet-5
aggregation_notes: prompts/adjudicate.md
`;

export const AGG = { harness: "codex", model: "gpt-5.6-sol", reasoningEffort: "high" };

export const MANIFEST = `version: 1
reviewers:
  - id: security
    source: reviewers/security.md
  - id: abhinav
    source: reviewers/abhinav
selection:
  always: [security]
  rules:
    - id: backend
      when:
        any_changed_path: ["**/*.go", "src/**"]
      add: [abhinav]
`;

export function fixtureFiles(): Record<string, string> {
  return {
    ".orc-review/manifest.yaml": MANIFEST,
    ".orc-review/reviewers/security.md": SIMPLE_REVIEWER,
    ".orc-review/reviewers/abhinav/reviewer.yaml": COMPOSITE_YAML,
    ".orc-review/reviewers/abhinav/prompts/correctness.md": "Review correctness of the change; run the test suite and inspect failures.",
    ".orc-review/reviewers/abhinav/prompts/tests.md": "Review test coverage; run the test suite and report gaps.",
    ".orc-review/reviewers/abhinav/prompts/adjudicate.md": "Adjudicate the lanes as Abhinav would.",
  };
}
