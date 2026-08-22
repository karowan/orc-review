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

/**
 * A lane/reviewer id's readable segment. Keys come in several shapes —
 * `<pin>/<persona>/prompt`, `<pin>/<persona>/lanes/N`, `<persona>/lanes/N`,
 * bare `<persona>` — so the persona is found structurally: strip the
 * lane-machinery tail (prompt/lanes/indices) and take the last segment.
 */
function persona(id: string): string {
  const parts = id.split("/");
  while (parts.length > 1 && (/^\d+$/.test(parts[parts.length - 1])
         || parts[parts.length - 1] === "prompt" || parts[parts.length - 1] === "lanes")) {
    parts.pop();
  }
  return parts[parts.length - 1];
}

function location(f: Finding): string {
  return f.path ? `\`${f.path}${f.line ? `:${f.line}` : ""}\`` : "";
}

/** One scannable line per finding: severity, title, location. */
function findingLine(f: Finding): string {
  const loc = location(f);
  return `- **${SEVERITY_LABEL[f.severity]}** ${f.title}${loc ? ` — ${loc}` : ""}`;
}

/** The full finding, for the details section and inline anchors. */
function renderFinding(f: Finding): string {
  const loc = location(f);
  const meta = [loc, SEVERITY_LABEL[f.severity],
                [...new Set(f.reviewers.map(persona))].join(", ")]
    .filter(Boolean).join(" · ");
  let out = `#### ${f.title}\n${meta}\n\n${f.why}`;
  if (f.fix) out += `\n\nFix: ${f.fix}`;
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

  // The reader's path: summary, then a scannable finding list, then depth
  // behind <details>. Health caveats that change how to READ the verdict
  // stay above the fold; everything else folds.
  if (consolidated?.summary) lines.push(consolidated.summary, "");

  if (input.reviewerChange) {
    lines.push("> orc-review cannot approve changes to review authority.", "");
  }
  for (const repo of input.uncoveredRepos ?? []) {
    lines.push(`> Repo ${repo} has no review configuration; its changes were NOT judged.`, "");
  }
  if (!ev.complete) {
    lines.push("> Review coverage is incomplete; treat this result as partial with unknown readiness.");
    if (ev.failedRequired.length > 0) {
      lines.push(`> No surviving lanes for required reviewer(s): ${[...new Set(ev.failedRequired.map(persona))].join(", ")}`);
    }
    lines.push("");
  } else if (ev.failedLanes.length > 0) {
    lines.push(
      `> Partial lane coverage: ${[...new Set(ev.failedLanes.map(persona))].join(", ")} failed; judged from the remaining lanes.`,
      "",
    );
  }

  const blocking = ev.findings.filter((f) => f.severity === "blocking");
  const rest = ev.findings.filter((f) => f.severity !== "blocking");
  if (blocking.length > 0) {
    lines.push(`### Blocking (${blocking.length})`, "", ...blocking.map(findingLine), "");
  }
  if (rest.length > 0) {
    lines.push(`### Non-blocking (${rest.length})`, "", ...rest.map(findingLine), "");
  }
  if (ev.findings.length === 0 && ev.complete) {
    lines.push("No findings survived scrutiny.", "");
  }

  const changed = new Set(input.changedPaths);
  const inline: InlineComment[] = [];
  for (const f of ev.findings) {
    if (f.path && f.line && changed.has(f.path)) {
      inline.push({ path: f.path, line: f.line, body: renderFinding(f) });
    }
  }
  if (ev.findings.length > 0) {
    lines.push("<details>", `<summary>Details and fixes (${ev.findings.length})</summary>`, "");
    for (const f of ev.findings) lines.push(renderFinding(f), "");
    lines.push("</details>", "");
  }

  const coverage = consolidated?.coverage ?? [];
  const omissions = consolidated?.omissions ?? [];
  lines.push("<details>", "<summary>Review coverage</summary>", "");
  lines.push(`Reviewed by: ${input.reviewerNames.join(", ")}`, "");
  if (coverage.length > 0) {
    lines.push(...coverage.map((c) => `- ${c}`), "");
  }
  for (const o of omissions) {
    lines.push(`> Omitted coverage (${o.kind} ${persona(o.subject)}): ${o.reason}`, "");
  }
  lines.push("</details>");

  lines.push(...renderDetails(input.runDetails));
  return { body: lines.join("\n"), inlineComments: inline };
}

function renderDetails(details: Array<[string, string]>): string[] {
  if (details.length === 0) return [];
  const rows = details.map(([k, v]) => `${k}: \`${v}\``);
  return ["", "<details><summary>Run details</summary>", "", ...rows, "", "</details>"];
}
