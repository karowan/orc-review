/**
 * Fail-closed verdict algebra:
 * partial, failed, or unknown results never approve; a Reviewer Change is
 * never approved by automation. Finding severity is evidence and is preserved
 * independently from any publisher's authority to act on the verdict.
 */
import { z } from "zod";
import type {
  Action,
  ConsolidatedResult,
  Finding,
  Verdict,
} from "./contracts.js";

const FindingSchema = z.object({
  id: z.string(),
  severity: z.enum(["blocking", "warning", "consider", "nit"]),
  title: z.string(),
  path: z.string().optional(),
  line: z.number().int().positive().optional(),
  why: z.string(),
  fix: z.string().optional(),
  reviewers: z.array(z.string()).min(1),
});

const ConsolidatedSchema = z.object({
  findings: z.array(FindingSchema),
  coverage: z.array(z.string()).default([]),
  omissions: z
    .array(z.object({ kind: z.string(), subject: z.string(), reason: z.string() }))
    .default([]),
  readiness: z.enum(["ready", "not_ready", "unknown"]),
  summary: z.string().default(""),
});

const ProgramResultSchema = z.object({
  consolidated: ConsolidatedSchema,
  laneOutcomes: z.record(z.string(), z.enum(["ok", "error"])),
});

export interface ParsedProgramResult {
  consolidated: ConsolidatedResult;
  laneOutcomes: Record<string, "ok" | "error">;
}

/** Defensive parse of the program's return value; null = malformed (fail closed). */
export function parseProgramResult(body: unknown): ParsedProgramResult | null {
  const parsed = ProgramResultSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

export interface VerdictInput {
  runState: string; // orc terminal state: completed | failed | cancelled (or running)
  result: ParsedProgramResult | null;
  /** Eligible bots with their authority bits and declared lane keys. */
  eligible: Array<{ id: string; required: boolean; canBlock: boolean; laneKeys: string[] }>;
  reviewerChange: boolean;
  noEligibleReviewers: boolean;
  /** Repos in the set with no review configuration — their diffs went unjudged. */
  uncoveredRepos?: string[];
}

export interface Evaluation {
  verdict: Verdict;
  action: Action;
  complete: boolean;
  blocking: boolean;
  /** Findings sorted for rendering; source severity is never authority-capped. */
  findings: Finding[];
  /** Ids of required bots with zero surviving lanes (rev 2 completeness rule). */
  failedRequired: string[];
  /** Lane keys that errored or went unreported — degraded coverage, not failure. */
  failedLanes: string[];
}

import { SEVERITY_RANK } from "./contracts.js";

export function evaluate(input: VerdictInput): Evaluation {
  if (input.noEligibleReviewers) {
    return {
      verdict: "ABSTAINED",
      action: "COMMENT",
      complete: false,
      blocking: false,
      findings: [],
      failedRequired: [],
      failedLanes: [],
    };
  }

  const outcomes = input.result?.laneOutcomes ?? {};

  // Rev 2 completeness: a lane failure degrades coverage; a bot fails only
  // when NONE of its lanes survived (an unreported key counts as failed).
  const failedLanes = input.eligible
    .flatMap((r) => r.laneKeys)
    .filter((key) => outcomes[key] !== "ok");
  const failedRequired = input.eligible
    .filter((r) => r.required && !r.laneKeys.some((key) => outcomes[key] === "ok"))
    .map((r) => r.id);

  const complete =
    input.runState === "completed" &&
    input.result !== null &&
    failedRequired.length === 0 &&
    (input.uncoveredRepos?.length ?? 0) === 0 && // an unjudged repo is missing coverage
    input.result.consolidated.readiness !== "unknown";

  // Severity is review evidence, not publication authority. Publishers decide
  // separately whether they may enact the resulting action hint.
  const findings: Finding[] = [...(input.result?.consolidated.findings ?? [])];
  findings.sort((a, b) => {
    const d = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    return d !== 0 ? d : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const blocking = findings.some((f) => f.severity === "blocking");
  const ready = input.result?.consolidated.readiness === "ready";

  let verdict: Verdict = "REVIEWED";
  let action: Action = "COMMENT";
  if (blocking) {
    verdict = "CHANGES REQUESTED";
    action = "REQUEST_CHANGES";
  } else if (!complete) {
    verdict = "PARTIAL — NOT APPROVED";
  } else if (input.reviewerChange) {
    verdict = "ADVISORY — AUTOMATION CLEARED";
  } else if (ready) {
    verdict = "APPROVED";
    action = "APPROVE";
  }

  return { verdict, action, complete, blocking, findings, failedRequired, failedLanes };
}
