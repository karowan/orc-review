/**
 * The planner: a model authors the flat review program — the "craft" step
 * between two deterministic "law" steps. Its craft is exactly one thing:
 * merging same-mandate lanes across bots (and repos) into single executions
 * with union attribution. There is no support tier — every call is a judgment
 * lane or the aggregator. The verifier decides whether its program runs; the
 * template generator is the fallback.
 */
import { execFile } from "node:child_process";
import type { CompiledReviewer, Facts } from "./contracts.js";

/** Pluggable plan model: planner prompt in, program body (or fenced text) out. */
export type PlanModel = (prompt: string) => Promise<string>;

export const DEFAULT_PLANNER_MODEL = "claude-fable-5";

/** Runs the planner through the local `claude` CLI (user's own auth). */
export function claudeCliPlanner(model: string = DEFAULT_PLANNER_MODEL): PlanModel {
  return (prompt) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        "claude",
        ["-p", "--model", model, "--output-format", "text"],
        { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 300_000 },
        (err, stdout, stderr) => {
          if (err) reject(new Error(`planner model failed: ${err.message}\n${stderr.slice(0, 2000)}`));
          else resolve(stdout);
        },
      );
      child.stdin?.write(prompt);
      child.stdin?.end();
    });
}

/** Extracts the last fenced code block, or returns the text as-is. */
export function extractProgramBody(text: string): string {
  const fences = [...text.matchAll(/```(?:ts|typescript|js|javascript)?\n([\s\S]*?)```/g)];
  if (fences.length > 0) return fences[fences.length - 1][1].trim();
  return text.trim();
}

const excerpt = (s: string, n = 1500) => (s.length <= n ? s : `${s.slice(0, n)}\n…[truncated]`);

export function plannerPrompt(args: {
  reviewers: CompiledReviewer[]; // eligible cohort
  facts: Facts;
  matchedRules: string[];
  feedback?: string[]; // verifier problems from a prior attempt
  priorBody?: string;
}): string {
  const { reviewers, facts, matchedRules, feedback, priorBody } = args;
  const reviewerBlocks = reviewers
    .map((r) => {
      const lanes = r.lanes
        .map(
          (l) =>
            `  lane PROMPTS[${JSON.stringify(l.promptKey)}]${l.model ? ` model=${l.model}` : ""}${l.harness ? ` harness=${l.harness}` : ""}${l.reasoningEffort ? ` effort=${l.reasoningEffort}` : ""}\n    excerpt: ${JSON.stringify(excerpt(l.promptText, 800))}`,
        )
        .join("\n");
      return `- bot "${r.id}" (${r.displayName})${r.canBlock ? "" : " [cannot block]"}${r.verbatim ? " [VERBATIM: this bot's lanes must run as declared — never merged, models/efforts untouched]" : ""}${r.plannerHints ? `\n  hints: ${r.plannerHints}` : ""}${r.aggregationNotes ? `\n  (has aggregation notes — injected for you as NOTES[${JSON.stringify(r.id)}])` : ""}\n${lanes}`;
    })
    .join("\n");

  return `You are the review-plan author for orc-review. Write ONE orc program (TypeScript) that runs the flat lane layer below over the change under review, then aggregates.

The orc program model: a single default-exported async function receiving { agent, parallel, phase, settle, log }. agent(prompt, opts) runs one AI leaf and resolves to its JSON output (opts: id, model, harness, reasoningEffort, schema). parallel([{prompt, ...opts}]) fans out lanes and resolves to per-lane settled envelopes ({status:"ok",value}|{status:"error",error}). phase(name, fn) groups calls for the monitor timeline. settle(p) captures a promise as an envelope. Ordinary await/Promise.all gives concurrency. The sandbox has no Date, Math.random, network, or file access; agents read the workspace themselves via their own tools.

A header is prepended for you (do NOT write it): PROMPTS (verbatim lane prompt texts, keyed as listed below), NOTES (per-bot aggregation guidance), SCHEMAS.findings / SCHEMAS.consolidated, CTX (repository, baseRef, headSha, changedPaths, reviewers with laneKeys), MERGE_PROMPT (the aggregator's canonical instructions), AGG (the aggregator's harness/model/effort — use it verbatim).

THE SHAPE (depth 1 — a deterministic verifier rejects violations):
- The flat lane layer: every PROMPTS key listed below runs EXACTLY ONCE, all lanes concurrent, each with schema: SCHEMAS.findings. A lane prompt must START with a PROMPTS[...] reference; you may append CTX facts after it. Never inline or paraphrase judgment text. No lane's output may appear in another lane's prompt.
- There is NO support tier: every agent call is either a judgment lane or the aggregator — nothing else. A bot that wants extra work (running the test suite, cataloging APIs) has declared it as a lane; lanes do their own legwork with their own tools.
- MERGING (your key judgment call): when lanes from DIFFERENT bots pursue the same review mandate (e.g. two security reviews, two test-run lanes — including across repos), merge them into ONE agent call: its prompt starts with one PROMPTS ref and appends each other merged key's full PROMPTS ref (template interpolation — the verbatim texts concatenate), then any CTX facts. Pick the strongest declared model/effort among the merged lanes. The merged call settles once; report its status under EVERY constituent key in laneOutcomes. Never merge lanes of a [VERBATIM] bot. When in doubt, don't merge.
- Aggregation: EXACTLY ONE agent call with schema: SCHEMAS.consolidated, options from AGG (harness: AGG.harness, model: AGG.model, reasoningEffort: AGG.reasoningEffort). Its prompt starts with MERGE_PROMPT and must include: JSON.stringify(CTX.reviewers), JSON.stringify(NOTES), and every lane's settled envelope labeled by its key(s). It must not reference PROMPTS.
- Never write these option keys: readOnly, cwd, host. Never touch ext. Never redeclare the injected constants.
- Return { consolidated, laneOutcomes } where laneOutcomes maps EVERY PROMPTS key to the settled status ("ok" | "error") of the call that ran it. Use settle()/parallel envelopes so one failing lane never sinks the run.

CRAFT:
- Merging is your whole craft: find the same-mandate lanes, run them once, attribute to everyone. All lanes concurrent, aggregator last.
- Use phase("review") / phase("aggregate") for the monitor; give every call a clear id (lane calls: their key; merged calls: a "+"-joined id).
- Open with a // PLAN: comment stating each merge and why (or "no merges").

THE CHANGE UNDER REVIEW:
repository: ${facts.repository}
base: ${facts.baseRef}
matched selection rules: ${matchedRules.join(", ") || "(none)"}
changed paths (${facts.changedPaths.length}):
${facts.changedPaths.slice(0, 200).join("\n")}${facts.changedPaths.length > 200 ? "\n…[truncated]" : ""}

THE LANES (every key below runs exactly once):
${reviewerBlocks}

${feedback?.length ? `YOUR PRIOR ATTEMPT WAS REJECTED. Problems:\n${feedback.map((p) => `- ${p}`).join("\n")}\n\nPrior attempt:\n\`\`\`ts\n${priorBody}\n\`\`\`\n\nFix every problem and output the corrected program.\n` : ""}Output ONLY a single fenced \`\`\`ts code block with the program body, starting exactly with:
export default async ({ agent, parallel, phase, settle, log }) => {`;
}
