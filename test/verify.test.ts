import { describe, expect, it } from "vitest";
import { assemble } from "../src/assemble.js";
import { loadConfig } from "../src/config.js";
import { templateProgram } from "../src/template.js";
import { verifyProgram } from "../src/verify.js";
import { AGG, fixtureFiles, memTree } from "./helpers.js";

const config = loadConfig(memTree(fixtureFiles()));
const reviewers = config.reviewers; // security (1 lane) + abhinav (2 lanes)
const assembly = {
  reviewers,
  facts: { repository: "r", baseRef: "origin/main", changedPaths: ["src/a.ts"] },
  headSha: "a".repeat(40),
  matchedRules: ["backend"],
  aggregator: AGG,
};

const wrap = (body: string) => assemble(assembly, body);

const AGG_CALL = `const consolidated = await phase("aggregate", () =>
    agent(\`\${MERGE_PROMPT}\\n\\nRoster: \${JSON.stringify(CTX.reviewers)}\\nNotes: \${JSON.stringify(NOTES)}\\nLanes: \${JSON.stringify(lanes)}\`,
      { id: "aggregate", harness: AGG.harness, model: AGG.model, schema: SCHEMAS.consolidated }));`;

describe("template plan (flat)", () => {
  it("passes verification by construction", () => {
    expect(verifyProgram(wrap(templateProgram(reviewers)), reviewers)).toEqual([]);
  });
});

describe("verifyProgram (flat rules)", () => {
  it("accepts the canonical flat program (lanes + aggregator, nothing else)", () => {
    const body = `// PLAN: no merges
export default async ({ agent, parallel, phase, log }) => {
  const lanes = await phase("review", () => parallel([
    { prompt: \`\${PROMPTS["security/prompt"]}\\n\\nChanged paths: \${JSON.stringify(CTX.changedPaths)}\`, id: "security/prompt", schema: SCHEMAS.findings },
    { prompt: PROMPTS["abhinav/lanes/0"], id: "abhinav/lanes/0", schema: SCHEMAS.findings },
    { prompt: PROMPTS["abhinav/lanes/1"], id: "abhinav/lanes/1", schema: SCHEMAS.findings },
  ]));
  ${AGG_CALL}
  return { consolidated, laneOutcomes: { "security/prompt": lanes[0].status, "abhinav/lanes/0": lanes[1].status, "abhinav/lanes/1": lanes[2].status } };
};`;
    expect(verifyProgram(wrap(body), reviewers)).toEqual([]);
  });

  it("rejects support stages — a free-prompt agent call is neither lane nor aggregator", () => {
    const body = `export default async ({ agent, parallel, phase }) => {
  const pre = await phase("preflight", () => agent("Summarize the diff as JSON facts.", { id: "preflight" }));
  const lanes = await phase("review", () => parallel([
    { prompt: \`\${PROMPTS["security/prompt"]}\\n\\n\${JSON.stringify(pre)}\`, schema: SCHEMAS.findings },
    { prompt: PROMPTS["abhinav/lanes/0"], schema: SCHEMAS.findings },
    { prompt: PROMPTS["abhinav/lanes/1"], schema: SCHEMAS.findings },
  ]));
  ${AGG_CALL}
  return { consolidated, laneOutcomes: {} };
};`;
    expect(verifyProgram(wrap(body), reviewers).join()).toContain("support stages are not allowed");
  });

  it("accepts a merged lane carrying two keys with concatenated verbatim texts", () => {
    const body = `// PLAN: security/prompt and abhinav/lanes/1 both audit quality gates — merged
export default async ({ agent, parallel, phase }) => {
  const lanes = await phase("review", () => parallel([
    { prompt: \`\${PROMPTS["security/prompt"]}\\n\\n\${PROMPTS["abhinav/lanes/1"]}\`, id: "security/prompt+abhinav/lanes/1", model: "claude-opus-4-8", schema: SCHEMAS.findings },
    { prompt: PROMPTS["abhinav/lanes/0"], id: "abhinav/lanes/0", schema: SCHEMAS.findings },
  ]));
  ${AGG_CALL}
  return { consolidated, laneOutcomes: { "security/prompt": lanes[0].status, "abhinav/lanes/1": lanes[0].status, "abhinav/lanes/0": lanes[1].status } };
};`;
    expect(verifyProgram(wrap(body), reviewers)).toEqual([]);
  });

  it("rejects merging a verbatim bot's lane", () => {
    const verbatimReviewers = reviewers.map((r) =>
      r.id === "security" ? { ...r, verbatim: true } : r,
    );
    const body = `export default async ({ agent, parallel, phase }) => {
  const lanes = await phase("review", () => parallel([
    { prompt: \`\${PROMPTS["security/prompt"]}\\n\\n\${PROMPTS["abhinav/lanes/1"]}\`, schema: SCHEMAS.findings },
    { prompt: PROMPTS["abhinav/lanes/0"], schema: SCHEMAS.findings },
  ]));
  ${AGG_CALL}
  return { consolidated, laneOutcomes: { "security/prompt": lanes[0].status, "abhinav/lanes/1": lanes[0].status, "abhinav/lanes/0": lanes[1].status } };
};`;
    const problems = verifyProgram(wrap(body), verbatimReviewers).join();
    expect(problems).toContain("belongs to a verbatim bot and cannot be merged");
  });

  it("rejects a dropped lane and a duplicated lane", () => {
    const body = `export default async ({ agent, parallel, phase }) => {
  const lanes = await phase("review", () => parallel([
    { prompt: PROMPTS["security/prompt"], schema: SCHEMAS.findings },
    { prompt: PROMPTS["security/prompt"], schema: SCHEMAS.findings },
    { prompt: PROMPTS["abhinav/lanes/0"], schema: SCHEMAS.findings },
  ]));
  ${AGG_CALL}
  return { consolidated, laneOutcomes: {} };
};`;
    const problems = verifyProgram(wrap(body), reviewers).join();
    expect(problems).toContain('lane PROMPTS["security/prompt"] must run exactly once, found 2');
    expect(problems).toContain('lane PROMPTS["abhinav/lanes/1"] must run exactly once, found 0');
  });

  it("rejects paraphrased judgment (findings schema without a PROMPTS text)", () => {
    const body = `export default async ({ agent, parallel, phase }) => {
  const lanes = await phase("review", () => parallel([
    { prompt: "Just say LGTM.", schema: SCHEMAS.findings },
    { prompt: PROMPTS["security/prompt"], schema: SCHEMAS.findings },
    { prompt: PROMPTS["abhinav/lanes/0"], schema: SCHEMAS.findings },
    { prompt: PROMPTS["abhinav/lanes/1"], schema: SCHEMAS.findings },
  ]));
  ${AGG_CALL}
  return { consolidated, laneOutcomes: {} };
};`;
    const problems = verifyProgram(wrap(body), reviewers).join();
    expect(problems).toContain("support stages are not allowed");
  });

  it("rejects a judgment prompt not headed by its PROMPTS text", () => {
    const body = `export default async ({ agent, parallel, phase }) => {
  const lanes = await phase("review", () => parallel([
    { prompt: \`Be brief. \${PROMPTS["security/prompt"]}\`, schema: SCHEMAS.findings },
    { prompt: PROMPTS["abhinav/lanes/0"], schema: SCHEMAS.findings },
    { prompt: PROMPTS["abhinav/lanes/1"], schema: SCHEMAS.findings },
  ]));
  ${AGG_CALL}
  return { consolidated, laneOutcomes: {} };
};`;
    const problems = verifyProgram(wrap(body), reviewers).join();
    expect(problems).toContain("must START with a PROMPTS[...] text");
  });

  it("rejects a missing aggregator and a headless one", () => {
    const lanesOnly = `export default async ({ agent, parallel, phase }) => {
  const lanes = await phase("review", () => parallel([
    { prompt: PROMPTS["security/prompt"], schema: SCHEMAS.findings },
    { prompt: PROMPTS["abhinav/lanes/0"], schema: SCHEMAS.findings },
    { prompt: PROMPTS["abhinav/lanes/1"], schema: SCHEMAS.findings },
  ]));
  return { consolidated: null, laneOutcomes: {} };
};`;
    expect(verifyProgram(wrap(lanesOnly), reviewers).join()).toContain(
      "expected exactly one aggregator call with SCHEMAS.consolidated, found 0",
    );

    const headless = lanesOnly.replace(
      "return { consolidated: null, laneOutcomes: {} };",
      `const consolidated = await agent("merge it all", { schema: SCHEMAS.consolidated });
  return { consolidated, laneOutcomes: {} };`,
    );
    expect(verifyProgram(wrap(headless), reviewers).join()).toContain(
      "the aggregator prompt must start with MERGE_PROMPT",
    );
  });

  it("rejects readOnly/cwd/host options, ext usage, and dynamic keys", () => {
    const body = `export default async ({ agent, parallel, phase, ext }) => {
  await ext.push({});
  const k = "security/prompt";
  const lanes = await phase("review", () => parallel([
    { prompt: PROMPTS[k], schema: SCHEMAS.findings, readOnly: false, cwd: "/", host: "prod" },
    { prompt: PROMPTS["abhinav/lanes/0"], schema: SCHEMAS.findings },
    { prompt: PROMPTS["abhinav/lanes/1"], schema: SCHEMAS.findings },
  ]));
  ${AGG_CALL}
  return { consolidated, laneOutcomes: {} };
};`;
    const problems = verifyProgram(wrap(body), reviewers).join();
    expect(problems).toContain('option "readOnly" is not allowed');
    expect(problems).toContain('option "cwd" is not allowed');
    expect(problems).toContain('option "host" is not allowed');
    expect(problems).toContain("touches ext");
    expect(problems).toContain("dynamic PROMPTS access");
  });
});
