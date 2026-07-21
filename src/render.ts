/**
 * Consolidated Review rendering — one markdown document per attempt. Layer 1
 * never publishes; inline-comment anchoring is still computed so a future
 * service layer can use it as-is.
 */
import {
  SEVERITY_LABEL,
  type ConsolidatedResult,
  type Finding,
} from "./contracts.js";
import type { Evaluation } from "./verdict.js";

export interface InlineComment {
  path: string;
  line: number;
  body: string;
}

export interface RenderInput {
  headSha: string;
  /** Marks a review of uncommitted worktree state in the header. */
  dirty?: boolean;
  evaluation: Evaluation;
  consolidated: ConsolidatedResult | null;
  reviewerNames: string[]; // eligible cohort display names, declaration order
  reviewerChange: boolean;
  changedPaths: string[];
  /** Repos in the set whose changes were not judged (no config, allowUncovered). */
  uncoveredRepos?: string[];
  runDetails: Array<[string, string]>; // label → value, e.g. runId, program sha256
}

export interface RenderedReview {
  body: string;
  inlineComments: InlineComment[];
}

function renderFinding(f: Finding): string {
  const loc = f.path ? ` — \`${f.path}${f.line ? `:${f.line}` : ""}\`` : "";
  let out = `**${SEVERITY_LABEL[f.severity]}** ${f.title}${loc}\n${f.why}`;
  if (f.fix) out += `\nSuggested fix: ${f.fix}`;
  out += `\n_(${f.reviewers.join(", ")})_`;
  return out;
}

export function render(input: RenderInput): RenderedReview {
  const { evaluation: ev, consolidated } = input;
  const lines: string[] = [];
  lines.push(`orc-review · ${ev.verdict} · ${input.headSha.slice(0, 7)}${input.dirty ? "+dirty" : ""}`);
  lines.push("");

  if (ev.verdict === "ABSTAINED") {
    lines.push(
      "No Eligible Reviewers can judge this Reviewer Change: every selected reviewer is altered by it.",
      "orc-review cannot approve changes to review authority.",
    );
    lines.push(...renderDetails(input.runDetails));
    return { body: lines.join("\n"), inlineComments: [] };
  }

  lines.push(`Reviewed by: ${input.reviewerNames.join(", ")}`);
  const coverage = consolidated?.coverage ?? [];
  if (coverage.length > 0) lines.push(`Coverage: ${coverage.join(", ")}`);
  if (consolidated?.summary) lines.push("", consolidated.summary);

  if (input.reviewerChange) {
    lines.push("", "> orc-review cannot approve changes to review authority.");
  }
  for (const repo of input.uncoveredRepos ?? []) {
    lines.push("", `> Repo ${repo} has no review configuration; its changes were NOT judged.`);
  }
  if (!ev.complete) {
    lines.push("", "> Review coverage is incomplete; treat this result as partial with unknown readiness.");
    if (ev.failedRequired.length > 0) {
      lines.push(`> No surviving lanes for required reviewer(s): ${ev.failedRequired.join(", ")}`);
    }
  } else if (ev.failedLanes.length > 0) {
    lines.push(
      "",
      `> Partial lane coverage: ${ev.failedLanes.join(", ")} failed; judged from the remaining lanes.`,
    );
  }
  for (const title of ev.capped) {
    lines.push("", `> Severity capped to SHOULD FIX (no blocking-authority reviewer sourced it): ${title}`);
  }

  const counts = { blocking: 0, warning: 0, consider: 0, nit: 0 };
  for (const f of ev.findings) counts[f.severity]++;
  lines.push(
    "",
    "## Findings",
    `MUST FIX (${counts.blocking}) · SHOULD FIX (${counts.warning}) · CONSIDER (${counts.consider}) · NIT (${counts.nit})`,
  );

  const changed = new Set(input.changedPaths);
  const inline: InlineComment[] = [];
  for (const f of ev.findings) {
    const rendered = renderFinding(f);
    if (f.path && f.line && changed.has(f.path)) {
      inline.push({ path: f.path, line: f.line, body: rendered });
    }
    lines.push("", rendered); // layer 1 keeps every finding in the body
  }
  if (ev.findings.length === 0 && ev.complete) {
    lines.push("", "No findings survived scrutiny.");
  }

  for (const o of consolidated?.omissions ?? []) {
    lines.push("", `> Omitted coverage (${o.kind} ${o.subject}): ${o.reason}`);
  }

  lines.push(...renderDetails(input.runDetails));
  return { body: lines.join("\n"), inlineComments: inline };
}

function renderDetails(details: Array<[string, string]>): string[] {
  if (details.length === 0) return [];
  const rows = details.map(([k, v]) => `${k}: \`${v}\``);
  return ["", "<details><summary>Run details</summary>", "", ...rows, "", "</details>"];
}
