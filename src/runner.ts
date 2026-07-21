/**
 * The engine: resolve pins → select → classify → plan → verify → launch →
 * collect → render. One invocation = one attempt over one repo set (N ≥ 1 —
 * there is no single-vs-multi mode). Everything outside this file's inputs
 * (publication, humans, PR lineage) is a future service layer's problem.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { Orc } from "@orc/sdk";
import { assemble, type AssemblyInput } from "./assemble.js";
import { ConfigError, loadConfig } from "./config.js";
import {
  DEFAULT_AGGREGATOR,
  type AggregatorOptions,
  type Classification,
  type CompiledReviewer,
  type Facts,
  type Manifest,
  type RepoPin,
  type ReviewConfig,
  type SelectionResult,
} from "./contracts.js";
import { classify } from "./eligibility.js";
import { claudeCliPlanner, extractProgramBody, plannerPrompt, DEFAULT_PLANNER_MODEL, type PlanModel } from "./planner.js";
import { render, type RenderedReview } from "./render.js";
import { loadLocalReviewers } from "./registry.js";
import { select } from "./selection.js";
import { parseRepoArg, resolvePins, type RepoArg } from "./sources.js";
import { templateProgram } from "./template.js";
import { evaluate, parseProgramResult, type Evaluation } from "./verdict.js";
import { verifyProgram } from "./verify.js";
import { composeWorkspace } from "./workspace.js";

const PLAN_ATTEMPTS = 2;

export interface ReviewOptions {
  /** Repo set. Empty/omitted → one git pin from `dir`@`baseRef`. */
  repos?: Array<RepoArg | string>;
  /** Sugar for the single-repo case (and the cwd for source/config discovery). */
  dir?: string;
  baseRef?: string;
  /** Skip (and note) repos without .orc-review instead of failing. */
  allowUncovered?: boolean;
  /** Explicit plan model; null forces the deterministic template. */
  planner?: PlanModel | null;
  budgetUsd?: number;
  affinity?: string[];
  /** Local-registry bots to call onto this run (always advisory). */
  withBots?: string[];
  registryDir?: string;
  /** Stop after selection/classification (no program generation). */
  planOnly?: boolean;
  onProgress?: (message: string) => void;
}

export interface RepoReview {
  pin: RepoPin;
  config?: ReviewConfig; // absent when uncovered (allowUncovered)
  selection?: SelectionResult;
  classification?: Classification;
}

export interface PreparedReview {
  pins: RepoPin[];
  perRepo: RepoReview[];
  /** Repos in the set with no .orc-review config (only with allowUncovered). */
  uncovered: string[];
  /** Composed, namespaced facts (`<repoId>/<path>`). */
  facts: Facts;
  /** Attempt identity across the set (dirty-aware). */
  changeId: string;
  dirty: boolean;
  /** True if ANY pin's change touches its .orc-review/ (advisory cap). */
  reviewerChange: boolean;
  /** Qualified ids (`repoId/botId`) excluded as changed, across the set. */
  changed: string[];
  /** Qualified eligible bots (declaration order per pin, pin order) + local bots. */
  eligible: CompiledReviewer[];
  localBots: string[];
  programSource?: string;
  programPath?: string;
  programSha256?: string;
  plannerUsed: "model" | "template" | "none";
  rejectedPlans: string[][];
}

export interface ReviewOutcome {
  prepared: PreparedReview;
  runId?: string;
  monitorUrl?: string;
  reportPath?: string;
  runState: string;
  evaluation: Evaluation;
  rendered: RenderedReview;
}

/** Namespaces a bot into the composed review: ids, display, lane keys, paths. */
export function qualifyReviewer(pinId: string, bot: CompiledReviewer): CompiledReviewer {
  const prefix = (s: string) => `${pinId}/${s}`;
  return {
    ...bot,
    id: prefix(bot.id),
    displayName: `${bot.displayName} (${pinId})`,
    lanes: bot.lanes.map((l) => ({ ...l, promptKey: prefix(l.promptKey), promptPath: prefix(l.promptPath) })),
    paths: bot.paths.map(prefix),
  };
}

export function aggregatorOptions(manifest: Manifest | undefined): AggregatorOptions {
  return {
    harness: manifest?.run.aggregatorHarness ?? DEFAULT_AGGREGATOR.harness,
    model: manifest?.run.aggregatorModel ?? DEFAULT_AGGREGATOR.model,
    reasoningEffort: manifest?.run.aggregatorEffort ?? DEFAULT_AGGREGATOR.reasoningEffort,
  };
}

function plansDir(): string {
  const dir = path.join(os.homedir(), ".orc-review", "plans");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function setChangeId(pins: RepoPin[]): { changeId: string; dirty: boolean } {
  const dirty = pins.some((p) => p.dirty);
  if (pins.length === 1) {
    const p = pins[0];
    return { changeId: p.dirty ? `${p.headSha.slice(0, 12)}+${p.fingerprint.slice(0, 12)}` : p.headSha, dirty };
  }
  const digest = createHash("sha256")
    .update(pins.map((p) => `${p.id}\0${p.fingerprint}`).join("\n"))
    .digest("hex");
  return { changeId: `set-${digest.slice(0, 16)}${dirty ? "+dirty" : ""}`, dirty };
}

export async function prepare(opts: ReviewOptions): Promise<PreparedReview> {
  const progress = opts.onProgress ?? (() => {});
  const cwd = opts.dir ?? ".";
  const args = (opts.repos?.length ? opts.repos : [{ source: "git", spec: cwd, base: opts.baseRef } as RepoArg]).map(
    (r) => (typeof r === "string" ? parseRepoArg(r) : r),
  );
  const pins = await resolvePins(args, cwd);

  const perRepo: RepoReview[] = [];
  const uncovered: string[] = [];
  const eligible: CompiledReviewer[] = [];
  const changed: string[] = [];
  let reviewerChange = false;

  for (const pin of pins) {
    progress(`compiling ${pin.id} review configuration from ${pin.baseLabel}`);
    let config: ReviewConfig;
    try {
      config = loadConfig(pin.configTree);
    } catch (err) {
      if (opts.allowUncovered && err instanceof ConfigError && err.problems.some((p) => p.includes("not found"))) {
        uncovered.push(pin.id);
        perRepo.push({ pin });
        continue;
      }
      const message = err instanceof ConfigError ? err.problems.join("; ") : String(err);
      throw new ConfigError([
        `repo "${pin.id}": ${message}`,
        `every repo in the set needs .orc-review at its base ref (or pass --allow-uncovered to skip it, noted as an omission)`,
      ]);
    }
    const facts: Facts = { repository: pin.id, baseRef: pin.baseLabel, changedPaths: pin.changedPaths };
    const selection = select(config.manifest, facts, opts.affinity ?? []);
    const classification = classify({
      baseConfig: config,
      headTree: pin.headTree,
      changedPaths: pin.changedPaths,
      selection,
    });
    reviewerChange ||= classification.reviewerChange;
    const byId = new Map(config.reviewers.map((r) => [r.id, r]));
    for (const id of classification.changed) changed.push(`${pin.id}/${id}`);
    for (const id of classification.eligible) {
      const bot = byId.get(id);
      if (bot) eligible.push(qualifyReviewer(pin.id, bot));
    }
    perRepo.push({ pin, config, selection, classification });
  }

  const localBots: string[] = [];
  if (opts.withBots?.length) {
    const locals = loadLocalReviewers(opts.withBots, opts.registryDir);
    const known = new Set(eligible.map((r) => r.id));
    for (const bot of locals) {
      if (known.has(bot.id)) {
        throw new ConfigError([`--with ${bot.id}: id collides with a repo reviewer`]);
      }
      eligible.push(bot);
      localBots.push(bot.id);
    }
  }

  const { changeId, dirty } = setChangeId(pins);
  const facts: Facts = {
    repository: pins.map((p) => p.id).join("+"),
    baseRef: pins.map((p) => `${p.id}@${p.baseLabel}`).join(", "),
    changedPaths: pins.flatMap((p) => p.changedPaths.map((c) => `${p.id}/${c}`)).sort(),
  };
  const matchedRules = perRepo.flatMap((r) => (r.selection?.matchedRules ?? []).map((m) => `${r.pin.id}:${m}`));

  const base: PreparedReview = {
    pins,
    perRepo,
    uncovered,
    facts,
    changeId,
    dirty,
    reviewerChange,
    changed,
    eligible,
    localBots,
    plannerUsed: "none",
    rejectedPlans: [],
  };
  if (eligible.length === 0 || opts.planOnly) return base;

  const primaryManifest = perRepo.find((r) => r.config)?.config?.manifest;
  const assembly: AssemblyInput = {
    reviewers: eligible,
    facts,
    headSha: changeId,
    matchedRules,
    aggregator: aggregatorOptions(primaryManifest),
  };

  const rejectedPlans: string[][] = [];
  let source: string | undefined;
  let plannerUsed: "model" | "template" = "template";

  const planModel =
    opts.planner === null || primaryManifest?.planner.disabled
      ? null
      : (opts.planner ?? claudeCliPlanner(primaryManifest?.planner.model ?? DEFAULT_PLANNER_MODEL));

  if (planModel) {
    let feedback: string[] | undefined;
    let priorBody: string | undefined;
    for (let attempt = 0; attempt < PLAN_ATTEMPTS; attempt++) {
      progress(attempt === 0 ? "planning the review program" : "re-planning after verifier feedback");
      try {
        const raw = await planModel(
          plannerPrompt({ reviewers: eligible, facts, matchedRules, feedback, priorBody }),
        );
        const body = extractProgramBody(raw);
        const candidate = assemble(assembly, body);
        const problems = verifyProgram(candidate, eligible);
        if (problems.length === 0) {
          source = candidate;
          plannerUsed = "model";
          break;
        }
        rejectedPlans.push(problems);
        feedback = problems;
        priorBody = body;
      } catch (err) {
        rejectedPlans.push([String(err instanceof Error ? err.message : err)]);
        break;
      }
    }
  }

  if (!source) {
    progress(planModel ? "planner rejected; falling back to the template plan" : "using the template plan");
    source = assemble(assembly, templateProgram(eligible));
    const problems = verifyProgram(source, eligible);
    if (problems.length > 0) {
      throw new Error(`template plan failed verification (bug):\n  ${problems.join("\n  ")}`);
    }
    plannerUsed = "template";
  }

  const sha = createHash("sha256").update(source).digest("hex");
  const programPath = path.join(
    plansDir(),
    `${facts.repository.replace(/[^a-zA-Z0-9_+-]/g, "_").slice(0, 40)}-${changeId.slice(0, 24)}-${sha.slice(0, 8)}.orc.ts`,
  );
  fs.writeFileSync(programPath, source);

  return { ...base, programSource: source, programPath, programSha256: sha, plannerUsed, rejectedPlans };
}

function brief(p: PreparedReview): string {
  const repoLines = p.pins
    .map((pin) => `- ${pin.id}/: ${pin.diffBriefing}`)
    .join("\n");
  return `You are one lane of an automated code review over ${p.pins.length} repositor${p.pins.length === 1 ? "y" : "ies"}.
Your working directory mounts each repo by id:
${repoLines}
Review ONLY those changes; the working trees are their authoritative state. Run the git commands above INSIDE the repo's directory. Read surrounding files as needed.
Reference every file in findings as <repoId>/<path> (e.g. ${p.pins[0].id}/src/main.ts).
Never modify anything. Report genuine findings only — do not pad; an empty findings list is a valid result.`;
}

export async function execute(p: PreparedReview, opts: ReviewOptions): Promise<ReviewOutcome> {
  const progress = opts.onProgress ?? (() => {});

  if (!p.programPath) {
    const evaluation = evaluate({
      runState: "none",
      result: null,
      eligible: [],
      reviewerChange: p.reviewerChange,
      noEligibleReviewers: true,
      uncoveredRepos: p.uncovered,
    });
    return {
      prepared: p,
      runState: "none",
      evaluation,
      rendered: render({
        headSha: p.changeId,
        dirty: p.dirty,
        evaluation,
        consolidated: null,
        reviewerNames: [],
        reviewerChange: p.reviewerChange,
        changedPaths: p.facts.changedPaths,
        uncoveredRepos: p.uncovered,
        runDetails: p.pins.map((pin): [string, string] => [`repo ${pin.id}`, `${pin.baseLabel} → ${pin.headSha.slice(0, 12)}`]),
      }),
    };
  }

  const workspaceDir = composeWorkspace(p.pins, p.changeId);
  const primaryManifest = p.perRepo.find((r) => r.config)?.config?.manifest;
  const orc = new Orc({ cwd: workspaceDir, defaultHarness: primaryManifest?.run.defaultHarness });

  progress("validating plan against live harness capabilities");
  const validation = await orc.validate({ programPath: p.programPath });
  if (validation.problems.length > 0) {
    throw new Error(`orc rejected the plan:\n  ${validation.problems.join("\n  ")}`);
  }

  progress("launching review run");
  const run = await orc.launch({
    programPath: p.programPath,
    cwd: workspaceDir,
    brief: brief(p),
    approvalMode: "auto",
    allowWrites: false,
    sandbox: primaryManifest?.run.sandbox ?? false,
    maxParallel: primaryManifest?.run.maxParallel,
    budget: opts.budgetUsd ?? primaryManifest?.run.budgetUsd,
    name: `review-${p.facts.repository.slice(0, 40)}-${p.changeId.slice(0, 12)}`,
  });
  progress(`monitor: ${run.info.monitorUrl}`);

  let status = await run.status();
  while (status.state === "running") {
    status = await run.wait(300);
  }

  let result = null;
  if (status.state === "completed") {
    try {
      result = parseProgramResult(await run.result());
    } catch {
      result = null; // fail closed
    }
  }

  const evaluation = evaluate({
    runState: status.state,
    result,
    eligible: p.eligible.map((r) => ({
      id: r.id,
      required: r.required,
      canBlock: r.canBlock,
      laneKeys: r.lanes.map((l) => l.promptKey),
    })),
    reviewerChange: p.reviewerChange,
    noEligibleReviewers: false,
    uncoveredRepos: p.uncovered,
  });

  const agg = aggregatorOptions(primaryManifest);
  const rendered = render({
    headSha: p.changeId,
    dirty: p.dirty,
    evaluation,
    consolidated: result?.consolidated ?? null,
    reviewerNames: p.eligible.map((r) => r.displayName),
    reviewerChange: p.reviewerChange,
    changedPaths: p.facts.changedPaths,
    uncoveredRepos: p.uncovered,
    runDetails: [
      ["run", run.runId],
      ...p.pins.map((pin): [string, string] => [
        `repo ${pin.id}`,
        `${pin.baseLabel} (${pin.baseSha.slice(0, 12)}) → ${pin.headSha.slice(0, 12)}${pin.dirty ? "+dirty" : ""}`,
      ]),
      ["plan", `${p.plannerUsed} · sha256:${p.programSha256}`],
      ["aggregator", `${agg.harness} · ${agg.model}`],
      ...p.eligible.map((r): [string, string] => [
        `reviewer ${r.id}`,
        `${p.localBots.includes(r.id) ? "local · " : ""}sha256:${r.contentHash.slice(0, 16)}`,
      ]),
      ["monitor", run.info.monitorUrl],
      ["report", run.info.reportPath],
    ],
  });

  return {
    prepared: p,
    runId: run.runId,
    monitorUrl: run.info.monitorUrl,
    reportPath: run.info.reportPath,
    runState: status.state,
    evaluation,
    rendered,
  };
}

/** One-call engine entry: prepare + execute. */
export async function review(opts: ReviewOptions): Promise<ReviewOutcome> {
  return execute(await prepare(opts), opts);
}
