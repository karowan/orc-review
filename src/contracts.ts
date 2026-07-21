/**
 * Shared types for the orc-review engine. Config lives in the reviewed repo
 * under `.orc-review/` and is trusted only from the base tree.
 */

export const CONFIG_ROOT = ".orc-review";
export const MANIFEST_PATH = `${CONFIG_ROOT}/manifest.yaml`;
/** Manifests larger than this are rejected (ported cap). */
export const MANIFEST_MAX_BYTES = 256 * 1024;

/** A minimal read-only view over a repo tree (worktree or a pinned git ref). */
export interface Tree {
  /** Returns file content for a repo-relative path, or null if absent. */
  read(relPath: string): string | null;
  /** Lists all file paths under a repo-relative prefix (recursive). */
  list(prefix: string): string[];
}

// --- manifest (closed schema; see config.ts for validation) -----------------

export interface SelectionRule {
  id: string;
  anyChangedPath: string[];
  add: string[];
}

export interface ManifestReviewerEntry {
  id: string;
  /** Path under .orc-review/: a .md file (simple) or a directory (composite). */
  source: string;
  required: boolean;
}

export interface Manifest {
  version: number;
  reviewers: ManifestReviewerEntry[]; // declaration order is authoritative
  selection: { always: string[]; rules: SelectionRule[] };
  run: {
    budgetUsd?: number;
    maxParallel?: number;
    sandbox?: boolean;
    defaultHarness?: string;
    aggregatorModel?: string;
    aggregatorHarness?: string;
    aggregatorEffort?: string;
  };
  planner: { model?: string; disabled?: boolean };
}

// --- compiled reviewers -----------------------------------------------------

export interface CompiledLane {
  /** Key into the injected PROMPTS constant, e.g. "abhinav/lanes/0". */
  promptKey: string;
  promptText: string;
  /** Repo-relative source path (provenance). */
  promptPath: string;
  harness?: string;
  model?: string;
  reasoningEffort?: string;
}

export interface CompiledReviewer {
  id: string;
  displayName: string;
  canBlock: boolean;
  required: boolean;
  /** true exempts this bot's lanes from planner merging/restructuring. */
  verbatim: boolean;
  lanes: CompiledLane[]; // simple reviewer = exactly one lane
  /** The bot's adjudication voice, injected into the aggregator prompt (rev 2). */
  aggregationNotes?: string;
  plannerHints?: string;
  /** sha256 over every file of this reviewer — eligibility compares base vs head. */
  contentHash: string;
  /** Repo-relative files making up this reviewer. */
  paths: string[];
}

/** One entry of the flat execution layer: a lane plus its owning bot. */
export interface FlatLane extends CompiledLane {
  botId: string;
  botVerbatim: boolean;
}

/** The ordered lane union across eligible bots (declaration order). */
export function flatLanes(reviewers: CompiledReviewer[]): FlatLane[] {
  return reviewers.flatMap((r) =>
    r.lanes.map((lane) => ({ ...lane, botId: r.id, botVerbatim: r.verbatim })),
  );
}

/** Aggregator lane configuration (rev 2 default: gpt-5.6-sol on codex). */
export interface AggregatorOptions {
  harness: string;
  model: string;
  reasoningEffort?: string;
}

export const DEFAULT_AGGREGATOR: AggregatorOptions = {
  harness: "codex",
  model: "gpt-5.6-sol",
  reasoningEffort: "high",
};

export interface ReviewConfig {
  manifest: Manifest;
  reviewers: CompiledReviewer[]; // declaration order
}

// --- repo pins (the change under review is always a set of these) -----------

/** One repository's pinned change. A review runs over N ≥ 1 pins. */
export interface RepoPin {
  /** Caller-assigned alias (default: directory basename). Namespaces paths, bots, lanes. */
  id: string;
  /** Local checkout the lanes will read. */
  root: string;
  /** What the caller asked for ("origin/main"). */
  baseLabel: string;
  /** Resolved merge-base — pinned SHA, never a branch name. */
  baseSha: string;
  headSha: string;
  /** HEAD + index/worktree diff + untracked contents digest — the change identity. */
  fingerprint: string;
  dirty: boolean;
  untracked: string[];
  /** Repo-relative changed paths (selection facts for this pin). */
  changedPaths: string[];
  /** How an agent views this repo's change (one line for the brief). */
  diffBriefing: string;
  /** Trusted side for this repo's .orc-review (base tree). */
  configTree: Tree;
  headTree: Tree;
}

/** A repo source materializes one repo's change locally and pins it. */
export interface RepoSource {
  /** Scheme name: "git" (default), or custom — "github", "brazil", … */
  name: string;
  resolve(spec: string, opts: { id?: string; base?: string }): Promise<RepoPin> | RepoPin;
  /** Re-fingerprint the same pin. Monotonic: stale never returns to valid. */
  refresh?(pin: RepoPin): Promise<{ state: "valid" | "stale" | "unknown"; reason?: string }>;
}

// --- selection / eligibility ------------------------------------------------

/** The only inputs selection may consult (ported invariant). */
export interface Facts {
  repository: string;
  baseRef: string;
  changedPaths: string[];
}

export interface SelectedReviewer {
  id: string;
  reasons: string[]; // sorted; "always" | "rule:<id>" | "affinity"
}

export interface SelectionResult {
  reviewers: SelectedReviewer[]; // declaration order
  matchedRules: string[];
}

export interface Classification {
  /** Any changed path under .orc-review/ — verdict capped at ADVISORY. */
  reviewerChange: boolean;
  /** Cohort members altered by this change (excluded from execution). */
  changed: string[];
  /** Cohort members that will actually run, declaration order. */
  eligible: string[];
}

// --- results ----------------------------------------------------------------

export type Severity = "blocking" | "warning" | "consider" | "nit";

export const SEVERITY_RANK: Record<Severity, number> = {
  blocking: 4,
  warning: 3,
  consider: 2,
  nit: 1,
};

export const SEVERITY_LABEL: Record<Severity, string> = {
  blocking: "MUST FIX",
  warning: "SHOULD FIX",
  consider: "CONSIDER",
  nit: "NIT",
};

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  path?: string;
  line?: number;
  why: string;
  fix?: string;
  /** Reviewer ids whose judgment sourced this finding. */
  reviewers: string[];
}

export interface Omission {
  kind: string;
  subject: string;
  reason: string;
}

export type Readiness = "ready" | "not_ready" | "unknown";

/** The synthesis lane's structured output (SCHEMAS.consolidated). */
export interface ConsolidatedResult {
  findings: Finding[];
  coverage: string[];
  omissions: Omission[];
  readiness: Readiness;
  summary: string;
}

export type Verdict =
  | "APPROVED"
  | "CHANGES REQUESTED"
  | "PARTIAL — NOT APPROVED"
  | "ADVISORY — AUTOMATION CLEARED"
  | "ABSTAINED"
  | "REVIEWED";

/** Full review conclusion for a service layer; layer 1 never publishes. */
export type Action = "APPROVE" | "REQUEST_CHANGES" | "COMMENT" | "NONE";
