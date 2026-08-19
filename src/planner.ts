/**
 * The planner: a model authors the flat review program — the "craft" step
 * between two deterministic "law" steps. Its craft is exactly one thing:
 * merging same-mandate lanes across bots (and repos) into single executions
 * with union attribution. There is no support tier — every call is a judgment
 * lane or the aggregator. The verifier decides whether its program runs; the
 * template generator is the fallback.
 *
 * The planner runs THROUGH THE HARNESS REGISTRY — the same seam every lane
 * uses. On a workstation that resolves to the bundled claude/codex harnesses
 * (the same CLIs and auth the lanes use); on an embedding host it resolves to
 * whatever exec-harness the host registered, so the planner automatically
 * follows the lanes onto the host's serving path. There is no separate
 * "planner transport": a host that can run one lane can plan.
 *
 * The program travels as STRUCTURED OUTPUT ({"program": "..."} against a
 * JSON Schema), not as fenced free text — the same enforcement that makes
 * lane output reliable across serving backends.
 */
import * as fs from "node:fs";
import os from "node:os";
import * as path from "node:path";
import type { HarnessContext, Json, LeafRequest, Registry } from "@karowanorg/orc-core";
import { buildRegistry } from "@karowanorg/orc-ops";
import {
  DEFAULT_CODEX_PLANNER_EFFORT,
  DEFAULT_CODEX_PLANNER_MODEL,
  DEFAULT_PLANNER_MODEL,
  type CompiledReviewer,
  type Facts,
  type ModelPolicy,
} from "./contracts.js";

export { DEFAULT_CODEX_PLANNER_EFFORT, DEFAULT_CODEX_PLANNER_MODEL, DEFAULT_PLANNER_MODEL };

/** Pluggable plan model: planner prompt in, program body (or wrapped text) out. */
export type PlanModel = (prompt: string) => Promise<string>;

/** Structured-output contract for the planner leaf. */
export const PROGRAM_SCHEMA: Json = {
  type: "object",
  properties: {
    program: {
      type: "string",
      description:
        "The complete orc program body, starting exactly with: export default async ({ agent, parallel, phase, settle, log }) => {",
    },
  },
  required: ["program"],
  additionalProperties: false,
};

/** Total wall clock for one planner attempt (mirrors a generous lane budget). */
const PLANNER_TIMEOUT_MS = 900_000;
/** Idle cutoff between planner output events. */
const PLANNER_IDLE_MS = 300_000;

export interface PlannerSelfVerify {
  /** Serialized contract for `orc-review verify-program` (JSON-safe). */
  input: unknown;
  /** A verifier-valid 1:1 starting program (the deterministic template). */
  skeleton: string;
}

export interface HarnessPlannerOptions {
  /** Directory whose orc configuration resolves the harness registry (the run's cwd). */
  cwd: string;
  /** Registered harness name; omitted → the registry's default harness. */
  harness?: string;
  /** Host-resolved model id (resolution happens before planning). */
  model?: string;
  reasoningEffort?: string;
  /** Manifest default harness, forwarded to registry discovery. */
  defaultHarness?: string;
  onLog?: (message: string) => void;
  /**
   * Materializes the verifier as a tool in the leaf's scratch cwd
   * (plan-input.json + skeleton.ts) and lets the model iterate program.ts
   * to green before returning. The scratch program.ts, when present, is
   * preferred over the returned payload — it is the artifact the model
   * actually verified.
   */
  selfVerify?: PlannerSelfVerify;
  /** Test seam: replaces buildRegistry. */
  resolveRegistry?: () => Promise<Registry>;
}

/**
 * Runs the planner as one read-only leaf through the host's harness registry —
 * the exact path lanes take, whatever that path is on this host.
 */
export function harnessPlanner(opts: HarnessPlannerOptions): PlanModel {
  return async (prompt) => {
    const registry = await (opts.resolveRegistry?.() ??
      buildRegistry({ cwd: opts.cwd, defaultHarness: opts.defaultHarness }));
    const name = opts.harness ?? registry.defaultHarness;
    const harness = registry.harnesses.get(name);
    if (!harness) {
      throw new Error(
        `planner harness "${name}" is not registered (available: ${[...registry.harnesses.keys()].join(", ") || "none"})`,
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PLANNER_TIMEOUT_MS);
    // A private scratch cwd: harnesses may treat the leaf cwd as owned
    // scratch space, and the planner must never point one at a shared dir.
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "orc-review-plan-"));
    if (opts.selfVerify) {
      fs.writeFileSync(path.join(scratch, "plan-input.json"), JSON.stringify(opts.selfVerify.input));
      fs.writeFileSync(path.join(scratch, "skeleton.ts"), opts.selfVerify.skeleton);
    }
    const request: LeafRequest = {
      runId: `plan-${process.pid.toString(36)}-${process.hrtime.bigint().toString(36)}`,
      seq: 0,
      id: "planner",
      prompt,
      system: "",
      brief: "",
      schema: PROGRAM_SCHEMA,
      model: opts.model,
      reasoningEffort: opts.reasoningEffort,
      // Self-verifying planners write and re-verify program.ts in scratch.
      readOnly: !opts.selfVerify,
      cwd: scratch,
      approvalMode: "auto",
      idleTimeoutMs: PLANNER_IDLE_MS,
    };
    const context: HarnessContext = {
      executor: registry.executor,
      // The planner is prompt-in/program-out; it has no business escalating.
      requestApproval: async () => ({ behavior: "deny", message: "the planner leaf takes no approvals" }),
      signal: controller.signal,
      log: opts.onLog ?? (() => {}),
    };
    try {
      let result: Json | undefined;
      let text = "";
      let failure: string | undefined;
      for await (const event of harness.invoke(request, context)) {
        if (event.kind === "text") text += event.delta;
        else if (event.kind === "result") result = event.output;
        else if (event.kind === "error") failure = event.message;
      }
      if (failure !== undefined) throw new Error(`planner model failed: ${failure}`);
      if (opts.selfVerify) {
        // Prefer the file the model iterated against the verifier: the
        // returned payload can drift from the artifact it validated.
        try {
          const iterated = fs.readFileSync(path.join(scratch, "program.ts"), "utf8");
          if (iterated.trim()) return iterated;
        } catch {
          /* no file — fall through to the returned payload */
        }
      }
      const program =
        result && typeof result === "object" && !Array.isArray(result)
          ? (result as { program?: unknown }).program
          : undefined;
      if (typeof program === "string" && program.trim()) return program;
      if (typeof result === "string" && result.trim()) return result;
      if (text.trim()) return text;
      throw new Error("planner model returned no program");
    } finally {
      clearTimeout(timer);
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  };
}

/**
 * Extracts the program body from a planner response: a structured
 * {"program": "..."} JSON payload, a fenced code block, or the raw text.
 */
export function extractProgramBody(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { program?: unknown };
      if (parsed && typeof parsed.program === "string" && parsed.program.trim()) {
        return parsed.program.trim();
      }
    } catch {
      /* not JSON — fall through to fences */
    }
  }
  const fences = [...trimmed.matchAll(/```(?:ts|typescript|js|javascript|json)?\n([\s\S]*?)```/g)];
  if (fences.length > 0) {
    const body = fences[fences.length - 1][1].trim();
    // A fenced JSON wrapper still carries the program field.
    if (body.startsWith("{")) {
      try {
        const parsed = JSON.parse(body) as { program?: unknown };
        if (parsed && typeof parsed.program === "string" && parsed.program.trim()) {
          return parsed.program.trim();
        }
      } catch {
        /* fenced code, not JSON */
      }
    }
    return body;
  }
  return trimmed;
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
  /** The planner leaf has the verifier as a tool in its cwd — instruct the loop. */
  selfVerify?: boolean;
}): string {
  const { reviewers, facts, matchedRules, feedback, priorBody, maxCalls, modelPolicy, selfVerify } = args;
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
- MERGING (your key judgment call): minimize the number of judgment agent calls while preserving every requested lane. Merge compatible lanes from the SAME bot or DIFFERENT bots into ONE agent call whenever one workspace investigation can satisfy their prompts. Mandates may be complementary rather than identical (for example correctness + backcompat + security, or product + UX + design-system); the merged leaf returns the union of their findings. Its prompt starts with one PROMPTS ref and appends every other merged key's full PROMPTS ref (template interpolation — verbatim texts concatenate), then any CTX facts. HARNESS PINNING: a lane's declared harness is a pin, not a preference — never merge lanes whose declared harnesses differ, and the merged call's harness must equal its lanes' declared harness (lanes declaring none may join any bundle). Within that harness, pick the strongest declared model/effort among the merged lanes. One overloaded or rate-limited provider must only ever take down the lanes that chose it. The merged call settles once; report its status under EVERY constituent key in laneOutcomes. Never merge lanes of a [VERBATIM] bot.
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

${selfVerify ? `SELF-VALIDATE BEFORE RETURNING — your working directory is a workbench:
- skeleton.ts is a VERIFIER-VALID starting program that runs every lane 1:1 with no merges. It always passes; it is also the most expensive possible plan.
- Write your candidate to program.ts and run: orc-review verify-program --input plan-input.json program.ts
  It prints OK, or the exact deterministic problems the engine would reject you with.
- Iterate: merge harder, verify, fix, verify again. Do not return until it prints OK.
- CONDENSE: a good plan lands well under the ceiling. Start from the skeleton and pack compatible lanes; the verifier loop means bold merging costs you nothing.
- Return the final program.ts content as {"program": ...} exactly as verified.

` : ""}${feedback?.length ? `YOUR PRIOR ATTEMPT WAS REJECTED. Problems:\n${feedback.map((p) => `- ${p}`).join("\n")}\n\nPrior attempt:\n\`\`\`ts\n${priorBody}\n\`\`\`\n\nFix every problem and output the corrected program.\n` : ""}Return the result as {"program": "<the program body>"} matching the response schema. The program body must start exactly with:
export default async ({ agent, parallel, phase, settle, log }) => {`;
}
