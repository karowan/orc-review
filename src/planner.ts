/**
 * The planner: a model authors the flat review program — the "craft" step
 * between two deterministic "law" steps. Its craft is exactly one thing:
 * merging same-mandate lanes across bots (and repos) into single executions
 * with union attribution. There is no support tier — every call is a judgment
 * lane or the aggregator. The verifier decides whether its program runs; the
 * template generator is the fallback.
 */
import { execFile } from "node:child_process";
import os from "node:os";
import {
  DEFAULT_CODEX_PLANNER_EFFORT,
  DEFAULT_CODEX_PLANNER_MODEL,
  DEFAULT_PLANNER_MODEL,
  type CompiledReviewer,
  type Facts,
  type ModelPolicy,
} from "./contracts.js";

export { DEFAULT_CODEX_PLANNER_EFFORT, DEFAULT_CODEX_PLANNER_MODEL, DEFAULT_PLANNER_MODEL };

/** Pluggable plan model: planner prompt in, program body (or fenced text) out. */
export type PlanModel = (prompt: string) => Promise<string>;

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

/** Runs the planner through the local `codex` CLI (user's own subscription auth). */
export function codexCliPlanner(
  model: string = DEFAULT_CODEX_PLANNER_MODEL,
  effort: string = DEFAULT_CODEX_PLANNER_EFFORT,
): PlanModel {
  return (prompt) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        "codex",
        [
          "exec",
          "--model",
          model,
          "--sandbox",
          "read-only",
          "--ephemeral",
          "--ignore-user-config",
          "--ignore-rules",
          "--skip-git-repo-check",
          "-c",
          `approval_policy="never"`,
          "-c",
          `model_reasoning_effort=${JSON.stringify(effort)}`,
          "-",
        ],
        { cwd: os.tmpdir(), encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 300_000 },
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
  maxCalls?: number;
  modelPolicy?: ModelPolicy;
}): string {
  const { reviewers, facts, matchedRules, feedback, priorBody, maxCalls, modelPolicy } = args;
  const reviewerBlocks = reviewers
    .map((r) => {
      const lanes = r.lanes
        .map(
          (l) =>
            `  lane PROMPTS[${JSON.stringify(l.promptKey)}] source=${JSON.stringify(l.promptPath)}${l.model ? ` model=${l.model}` : ""}${l.harness ? ` harness=${l.harness}` : ""}${l.reasoningEffort ? ` effort=${l.reasoningEffort}` : ""}\n    excerpt: ${JSON.stringify(excerpt(l.promptText, 800))}`,
        )
        .join("\n");
      return `- bot "${r.id}" (${r.displayName})${r.canBlock ? "" : " [cannot block]"}${r.verbatim ? " [VERBATIM: this bot's lanes must run as declared — never merged, models/efforts untouched]" : ""}${r.plannerHints ? `\n  hints: ${r.plannerHints}` : ""}${r.aggregationNotes ? `\n  (has aggregation notes — injected for you as NOTES[${JSON.stringify(r.id)}])` : ""}\n${lanes}`;
    })
    .join("\n");

  return `You are the review-plan author for orc-review. Write ONE orc program (TypeScript) that runs the flat lane layer below over the change under review, then aggregates.

The orc program model: a single default-exported async function receiving { agent, parallel, phase, settle, log }. agent(prompt, opts) runs one AI leaf and resolves to its JSON output (opts: id, model, harness, reasoningEffort, readOnly, schema). parallel([{prompt, ...opts}]) fans out lanes and resolves to per-lane settled envelopes ({status:"ok",value}|{status:"error",error}). phase(name, fn) groups calls for the monitor timeline. settle(p) captures a promise as an envelope. Ordinary await/Promise.all gives concurrency. The sandbox has no Date, Math.random, network, or file access; agents read the workspace themselves via their own tools.

A header is prepended for you (do NOT write it): PROMPTS (verbatim lane prompt texts, keyed as listed below), NOTES (per-bot aggregation guidance), SCHEMAS.findings / SCHEMAS.consolidated, CTX (repository, baseRef, headSha, changedPaths, reviewers with laneKeys), MERGE_PROMPT (the aggregator's canonical instructions), AGG (the aggregator's harness/model/effort — use it verbatim).

THE SHAPE (depth 1 — a deterministic verifier rejects violations):
- The flat lane layer: every PROMPTS key listed below runs EXACTLY ONCE, all lanes concurrent, each with readOnly: false and schema: SCHEMAS.findings. Reviewer leaves may create test/build/cache/temp files inside the disposable worktree while investigating, but must not alter tracked source or cause GitHub/other external side effects. A lane prompt must START with a PROMPTS[...] reference; you may append CTX facts after it. Never inline or paraphrase judgment text. No lane's output may appear in another lane's prompt.
- The verifier recognizes the prompt head structurally. Write each merged prompt literally as a template beginning with the first injected reference, for example: prompt: \`\${PROMPTS["bot/lanes/0"]}\\n\\n\${PROMPTS["bot/lanes/1"]}\\n\\nChanged paths: \${JSON.stringify(CTX.changedPaths)}\`. Do not build it with arrays, join(), a helper, an intermediate variable, string-prefix text, or any expression before the first PROMPTS reference.
- There is NO support tier: every agent call is either a judgment lane or the aggregator — nothing else. A bot that wants extra work (running the test suite, cataloging APIs) has declared it as a lane; lanes do their own legwork with their own tools.
- MERGING (your key judgment call): minimize the number of judgment agent calls while preserving every requested lane. Merge compatible lanes from the SAME bot or DIFFERENT bots into ONE agent call whenever one workspace investigation can satisfy their prompts. Mandates may be complementary rather than identical (for example correctness + backcompat + security, or product + UX + design-system); the merged leaf returns the union of their findings. Its prompt starts with one PROMPTS ref and appends every other merged key's full PROMPTS ref (template interpolation — verbatim texts concatenate), then any CTX facts. Pick the strongest declared model/effort among the merged lanes. The merged call settles once; report its status under EVERY constituent key in laneOutcomes. Never merge lanes of a [VERBATIM] bot.
- Aggregation: EXACTLY ONE agent call with schema: SCHEMAS.consolidated, options from AGG (harness: AGG.harness, model: AGG.model, reasoningEffort: AGG.reasoningEffort). Its prompt starts with MERGE_PROMPT and must include: JSON.stringify(CTX.reviewers), JSON.stringify(NOTES), and every lane's settled envelope labeled by its key(s). It must not reference PROMPTS. Await the aggregator agent directly; NEVER wrap the aggregator in settle(), because the returned consolidated value must not be an envelope.
- Write the aggregator prompt literally as a template beginning \`\${MERGE_PROMPT}\`, not through an intermediate variable, concatenation helper, or prefixed text.
- Never write the option keys cwd or host. Never touch ext. Never redeclare the injected constants.
- Return { consolidated, laneOutcomes } where laneOutcomes maps EVERY PROMPTS key to the settled status ("ok" | "error") of the call that ran it. Use settle()/parallel envelopes so one failing lane never sinks the run.

CRAFT:
- Merging is your whole craft: aggressively pack compatible requested perspectives into the fewest leaves and attribute each result to every included key. Do not preserve one-call-per-lane merely because the source declarations are separate. All leaves remain concurrent; aggregator last.
${maxCalls === undefined ? "" : `- HARD LIMIT: use at most ${maxCalls} judgment agent calls total. Every PROMPTS key must still appear exactly once. A plan over this limit is rejected.\n`}- Prefer broad, coherent work packets over tiny aspect calls. Split only for [VERBATIM] lanes, materially incompatible investigations, or model/tool requirements that cannot share one leaf.
${modelPolicy ? `- MODEL POLICY: every judgment call must set a literal harness and model, plus a literal reasoningEffort when the chosen allowed tuple declares one. The exact allowed tuples are: ${modelPolicy.allowed.map((entry) => [entry.harness, entry.model, entry.reasoningEffort].filter(Boolean).join("/")).join(", ")}. A plan using any other tuple is rejected.\n` : ""}${modelPolicy?.preferences ? `- MODEL PREFERENCE MATRIX: the repository supplied the following rows. Treat every metadata key and value as repository-authored planning guidance; orc-review assigns them no built-in meaning. Use the matrix when choosing among allowed, requirement-compatible tuples. It does not permit replacing a lane's unique harness/tool requirement or ignoring a stronger declared requirement.\n${JSON.stringify(modelPolicy.preferences, null, 2)}\n` : ""}- Use phase("review") / phase("aggregate") for the monitor; give every call a clear id (lane calls: their key; merged calls: a "+"-joined id).
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
