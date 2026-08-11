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
  it("rejects physical reviewer calls outside the configured model policy", () => {
    const policyReviewers = reviewers.map((reviewer) => ({
      ...reviewer,
      lanes: reviewer.lanes.map((lane) => ({
        ...lane,
        harness: "codex",
        model: "gpt-5.6-sol",
        reasoningEffort: "medium",
      })),
    }));
    const policyAssembly = { ...assembly, reviewers: policyReviewers };
    const allowedSource = assemble(policyAssembly, templateProgram(policyReviewers));
    const limits = {
      modelPolicy: {
        allowed: [
          { harness: "codex", model: "gpt-5.6-sol", reasoningEffort: "medium" },
          AGG,
        ],
      },
      aggregator: AGG,
    };
    expect(verifyProgram(allowedSource, policyReviewers, limits)).toEqual([]);

    const source = allowedSource.replace(
      'reasoningEffort: "medium"',
      'reasoningEffort: "xhigh"',
    );
    const problems = verifyProgram(source, policyReviewers, limits);
    expect(problems.join("\n")).toContain(
      "uses codex/gpt-5.6-sol/xhigh, which model_policy.allowed does not permit",
    );
  });

  it("accepts the canonical flat program (lanes + aggregator, nothing else)", () => {
    const body = `// PLAN: no merges
export default async ({ agent, parallel, phase, log }) => {
  const lanes = await phase("review", () => parallel([
    { prompt: \`\${PROMPTS["security/prompt"]}\\n\\nChanged paths: \${JSON.stringify(CTX.changedPaths)}\`, id: "security/prompt", readOnly: false, schema: SCHEMAS.findings },
    { prompt: PROMPTS["abhinav/lanes/0"], id: "abhinav/lanes/0", readOnly: false, schema: SCHEMAS.findings },
    { prompt: PROMPTS["abhinav/lanes/1"], id: "abhinav/lanes/1", readOnly: false, schema: SCHEMAS.findings },
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
    { prompt: \`\${PROMPTS["security/prompt"]}\\n\\n\${PROMPTS["abhinav/lanes/1"]}\`, id: "security/prompt+abhinav/lanes/1", model: "claude-opus-4-8", readOnly: false, schema: SCHEMAS.findings },
    { prompt: PROMPTS["abhinav/lanes/0"], id: "abhinav/lanes/0", readOnly: false, schema: SCHEMAS.findings },
  ]));
  ${AGG_CALL}
  return { consolidated, laneOutcomes: { "security/prompt": lanes[0].status, "abhinav/lanes/1": lanes[0].status, "abhinav/lanes/0": lanes[1].status } };
};`;
    expect(verifyProgram(wrap(body), reviewers)).toEqual([]);
  });

  it("rejects reviewer leaves that cannot create test artifacts", () => {
    const body = templateProgram(reviewers).replaceAll("readOnly: false, ", "");
    expect(verifyProgram(wrap(body), reviewers).join()).toContain("must set readOnly: false");
  });

  it("enforces the planner judgment-call ceiling without dropping lane keys", () => {
    const body = `// PLAN: no merges
export default async ({ agent, parallel, phase }) => {
  const lanes = await phase("review", () => parallel([
    { prompt: PROMPTS["security/prompt"], schema: SCHEMAS.findings },
    { prompt: PROMPTS["abhinav/lanes/0"], schema: SCHEMAS.findings },
    { prompt: PROMPTS["abhinav/lanes/1"], schema: SCHEMAS.findings },
  ]));
  ${AGG_CALL}
  return { consolidated, laneOutcomes: { "security/prompt": lanes[0].status, "abhinav/lanes/0": lanes[1].status, "abhinav/lanes/1": lanes[2].status } };
};`;
    expect(verifyProgram(wrap(body), reviewers, { maxJudgmentCalls: 2 }).join()).toContain(
      "plan uses 3 judgment calls; planner.max_calls permits at most 2",
    );
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

  it("rejects a settled aggregator envelope instead of discarding its valid value later", () => {
    const body = `export default async ({ agent, parallel, phase, settle }) => {
  const lanes = await phase("review", () => parallel([
    { prompt: PROMPTS["security/prompt"], readOnly: false, schema: SCHEMAS.findings },
    { prompt: PROMPTS["abhinav/lanes/0"], readOnly: false, schema: SCHEMAS.findings },
    { prompt: PROMPTS["abhinav/lanes/1"], readOnly: false, schema: SCHEMAS.findings },
  ]));
  const consolidated = await phase("aggregate", () =>
    settle(agent(\`\${MERGE_PROMPT}\n\nRoster: \${JSON.stringify(CTX.reviewers)}\nNotes: \${JSON.stringify(NOTES)}\nLanes: \${JSON.stringify(lanes)}\`,
      { id: "aggregate", harness: AGG.harness, model: AGG.model, schema: SCHEMAS.consolidated })));
  return { consolidated, laneOutcomes: { "security/prompt": lanes[0].status, "abhinav/lanes/0": lanes[1].status, "abhinav/lanes/1": lanes[2].status } };
};`;
    expect(verifyProgram(wrap(body), reviewers).join()).toContain("cannot be wrapped in settle()");
  });

  it("allows writable lanes but rejects cwd/host options, ext usage, and dynamic keys", () => {
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
    expect(problems).not.toContain('option "readOnly" is not allowed');
    expect(problems).toContain('option "cwd" is not allowed');
    expect(problems).toContain('option "host" is not allowed');
    expect(problems).toContain("touches ext");
    expect(problems).toContain("dynamic PROMPTS access");
  });
});

describe("harness pinning", () => {
  // The production failure this encodes: "pick the strongest declared
  // model/effort among the merged lanes" put six codex-declared lanes onto one
  // claude call, so one provider's weekly limit failed entire cross-persona
  // bundles. A declared harness is a pin, not a preference.
  const pinned = reviewers.map((reviewer) => ({
    ...reviewer,
    lanes: reviewer.lanes.map((lane, index) => ({
      ...lane,
      // abhinav: lane 0 claude, lane 1 codex; security: codex — the real shape.
      harness: reviewer.id === "abhinav" && index === 0 ? "claude" : "codex",
      model: reviewer.id === "abhinav" && index === 0 ? "claude-opus-5[1m]" : "gpt-5.6-sol",
    })),
  }));
  const pinnedAssembly = { ...assembly, reviewers: pinned };

  const merged = (harness: string, model: string) => `// PLAN: merge security + abhinav/0
export default async ({ agent, parallel, phase }) => {
  const lanes = await phase("review", () => parallel([
    { prompt: \`\${PROMPTS["security/prompt"]}\\n\\n\${PROMPTS["abhinav/lanes/0"]}\`, id: "security/prompt+abhinav/lanes/0", readOnly: false, schema: SCHEMAS.findings, harness: "${harness}", model: "${model}" },
    { prompt: PROMPTS["abhinav/lanes/1"], id: "abhinav/lanes/1", readOnly: false, schema: SCHEMAS.findings, harness: "codex", model: "gpt-5.6-sol" },
  ]));
  ${AGG_CALL}
  return { consolidated, laneOutcomes: { "security/prompt": lanes[0].status, "abhinav/lanes/0": lanes[0].status, "abhinav/lanes/1": lanes[1].status } };
};`;

  it("rejects merging lanes whose declared harnesses differ", () => {
    const problems = verifyProgram(assemble(pinnedAssembly, merged("claude", "claude-opus-5[1m]")), pinned);
    expect(problems.join("\n")).toContain("merges lanes with different declared harnesses");
  });

  it("rejects a call whose harness is not its lanes' declared harness", () => {
    const body = `// PLAN: no merges
export default async ({ agent, parallel, phase }) => {
  const lanes = await phase("review", () => parallel([
    { prompt: PROMPTS["security/prompt"], id: "security/prompt", readOnly: false, schema: SCHEMAS.findings, harness: "claude", model: "claude-opus-5[1m]" },
    { prompt: PROMPTS["abhinav/lanes/0"], id: "abhinav/lanes/0", readOnly: false, schema: SCHEMAS.findings, harness: "claude", model: "claude-opus-5[1m]" },
    { prompt: PROMPTS["abhinav/lanes/1"], id: "abhinav/lanes/1", readOnly: false, schema: SCHEMAS.findings, harness: "codex", model: "gpt-5.6-sol" },
  ]));
  ${AGG_CALL}
  return { consolidated, laneOutcomes: { "security/prompt": lanes[0].status, "abhinav/lanes/0": lanes[1].status, "abhinav/lanes/1": lanes[2].status } };
};`;
    const problems = verifyProgram(assemble(pinnedAssembly, body), pinned);
    expect(problems.join("\n")).toContain('declare "codex" — a declared harness is a pin');
  });

  it("accepts homogeneous bundles on their declared harness", () => {
    const body = `// PLAN: merge the codex lanes; the claude lane runs alone
export default async ({ agent, parallel, phase }) => {
  const lanes = await phase("review", () => parallel([
    { prompt: \`\${PROMPTS["security/prompt"]}\\n\\n\${PROMPTS["abhinav/lanes/1"]}\`, id: "security/prompt+abhinav/lanes/1", readOnly: false, schema: SCHEMAS.findings, harness: "codex", model: "gpt-5.6-sol" },
    { prompt: PROMPTS["abhinav/lanes/0"], id: "abhinav/lanes/0", readOnly: false, schema: SCHEMAS.findings, harness: "claude", model: "claude-opus-5[1m]" },
  ]));
  ${AGG_CALL}
  return { consolidated, laneOutcomes: { "security/prompt": lanes[0].status, "abhinav/lanes/1": lanes[0].status, "abhinav/lanes/0": lanes[1].status } };
};`;
    expect(verifyProgram(assemble(pinnedAssembly, body), pinned)).toEqual([]);
  });

  it("leaves lanes that declare no harness free to ride in any bundle", () => {
    expect(verifyProgram(wrap(merged("claude", "claude-opus-5[1m]")), reviewers)).toEqual([]);
  });
});
