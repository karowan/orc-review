/**
 * Deterministic template generator (rev 2, flat model) — the fail-closed
 * fallback plan. No lane merging, no support stages: every declared lane of
 * every eligible bot runs once in one concurrent layer, then the single
 * aggregator consolidates. Always passes the verifier by construction.
 */
import { flatLanes, type CompiledReviewer, type FlatLane } from "./contracts.js";

function laneSpec(lane: FlatLane): string {
  const opts: string[] = [
    `prompt: PROMPTS[${JSON.stringify(lane.promptKey)}]`,
    `id: ${JSON.stringify(lane.promptKey)}`,
  ];
  if (lane.harness) opts.push(`harness: ${JSON.stringify(lane.harness)}`);
  if (lane.model) opts.push(`model: ${JSON.stringify(lane.model)}`);
  if (lane.reasoningEffort) opts.push(`reasoningEffort: ${JSON.stringify(lane.reasoningEffort)}`);
  opts.push("schema: SCHEMAS.findings");
  return `{ ${opts.join(", ")} }`;
}

export function templateProgram(reviewers: CompiledReviewer[]): string {
  const lanes = flatLanes(reviewers);
  const specs = lanes.map((l) => `    ${laneSpec(l)},`).join("\n");
  const keys = lanes.map((l) => JSON.stringify(l.promptKey));
  const envelopeObj = keys.map((k, i) => `${k}: lanes[${i}]`).join(", ");
  const outcomesObj = keys.map((k, i) => `${k}: lanes[${i}].status`).join(", ");
  return `export default async ({ agent, parallel, phase, log }) => {
  const lanes = await phase("review", () => parallel([
${specs}
  ]));
  log("flat lane layer settled; aggregating");
  const consolidated = await phase("aggregate", () =>
    agent(\`\${MERGE_PROMPT}

Reviewer roster:
\${JSON.stringify(CTX.reviewers)}

Aggregation notes by bot:
\${JSON.stringify(NOTES)}

Lane envelopes by key:
\${JSON.stringify({ ${envelopeObj} })}\`, { id: "aggregate", harness: AGG.harness, model: AGG.model, reasoningEffort: AGG.reasoningEffort, schema: SCHEMAS.consolidated }));
  return { consolidated, laneOutcomes: { ${outcomesObj} } };
};`;
}
