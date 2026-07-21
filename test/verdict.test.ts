import { describe, expect, it } from "vitest";
import { evaluate, parseProgramResult, type ParsedProgramResult } from "../src/verdict.js";
import { render } from "../src/render.js";
import type { ConsolidatedResult } from "../src/contracts.js";

const ELIGIBLE = [
  { id: "security", required: true, canBlock: true, laneKeys: ["security/prompt"] },
  { id: "abhinav", required: true, canBlock: true, laneKeys: ["abhinav/lanes/0", "abhinav/lanes/1"] },
  { id: "docs", required: false, canBlock: false, laneKeys: ["docs/prompt"] },
];

const ALL_OK: Record<string, "ok" | "error"> = {
  "security/prompt": "ok",
  "abhinav/lanes/0": "ok",
  "abhinav/lanes/1": "ok",
  "docs/prompt": "ok",
};

const consolidated = (over: Partial<ConsolidatedResult> = {}): ConsolidatedResult => ({
  findings: [],
  coverage: ["correctness"],
  omissions: [],
  readiness: "ready",
  summary: "Looks solid.",
  ...over,
});

const result = (
  c: ConsolidatedResult,
  outcomes: Record<string, "ok" | "error"> = ALL_OK,
): ParsedProgramResult => ({ consolidated: c, laneOutcomes: outcomes });

const run = (r: ParsedProgramResult | null, over: Partial<Parameters<typeof evaluate>[0]> = {}) =>
  evaluate({
    runState: "completed",
    result: r,
    eligible: ELIGIBLE,
    reviewerChange: false,
    noEligibleReviewers: false,
    ...over,
  });

describe("evaluate (rev 2 lane semantics)", () => {
  it("approves a clean, complete, ready run", () => {
    const ev = run(result(consolidated()));
    expect(ev.verdict).toBe("APPROVED");
    expect(ev.action).toBe("APPROVE");
    expect(ev.complete).toBe(true);
    expect(ev.failedLanes).toEqual([]);
  });

  it("one failed lane of a multi-lane bot degrades coverage but still approves", () => {
    const ev = run(result(consolidated(), { ...ALL_OK, "abhinav/lanes/1": "error" }));
    expect(ev.complete).toBe(true);
    expect(ev.verdict).toBe("APPROVED");
    expect(ev.failedLanes).toEqual(["abhinav/lanes/1"]);
    expect(ev.failedRequired).toEqual([]);
  });

  it("a required bot with zero surviving lanes forces PARTIAL", () => {
    const ev = run(
      result(consolidated(), {
        ...ALL_OK,
        "abhinav/lanes/0": "error",
        "abhinav/lanes/1": "error",
      }),
    );
    expect(ev.verdict).toBe("PARTIAL — NOT APPROVED");
    expect(ev.failedRequired).toEqual(["abhinav"]);
  });

  it("everything failing forces PARTIAL", () => {
    const ev = run(
      result(consolidated({ readiness: "unknown" }), {
        "security/prompt": "error",
        "abhinav/lanes/0": "error",
        "abhinav/lanes/1": "error",
        "docs/prompt": "error",
      }),
    );
    expect(ev.verdict).toBe("PARTIAL — NOT APPROVED");
    expect(ev.failedRequired).toEqual(["security", "abhinav"]);
  });

  it("an unreported lane key counts as failed (fail closed)", () => {
    const { "security/prompt": _, ...missing } = ALL_OK;
    const ev = run(result(consolidated(), missing as Record<string, "ok" | "error">));
    expect(ev.verdict).toBe("PARTIAL — NOT APPROVED");
    expect(ev.failedRequired).toEqual(["security"]);
  });

  it("a failed advisory bot stays complete with a coverage note", () => {
    const ev = run(result(consolidated(), { ...ALL_OK, "docs/prompt": "error" }));
    expect(ev.verdict).toBe("APPROVED");
    expect(ev.failedLanes).toEqual(["docs/prompt"]);
  });

  it("requests changes on a surviving blocking finding", () => {
    const ev = run(
      result(
        consolidated({
          readiness: "not_ready",
          findings: [
            { id: "f-1", severity: "blocking", title: "SQLi", why: "raw concat", reviewers: ["security"] },
          ],
        }),
      ),
    );
    expect(ev.verdict).toBe("CHANGES REQUESTED");
    expect(ev.action).toBe("REQUEST_CHANGES");
  });

  it("preserves blocking findings without publication authority", () => {
    const ev = run(
      result(
        consolidated({
          findings: [{ id: "f-1", severity: "blocking", title: "typo", why: "docs", reviewers: ["docs"] }],
        }),
      ),
    );
    expect(ev.blocking).toBe(true);
    expect(ev.findings[0].severity).toBe("blocking");
    expect(ev.verdict).toBe("CHANGES REQUESTED");
    expect(ev.action).toBe("REQUEST_CHANGES");
  });

  it("a merged-lane finding blocks if any contributing bot can block", () => {
    const ev = run(
      result(
        consolidated({
          readiness: "not_ready",
          findings: [
            { id: "f-1", severity: "blocking", title: "bad", why: "x", reviewers: ["docs", "security"] },
          ],
        }),
      ),
    );
    expect(ev.blocking).toBe(true);
    expect(ev.verdict).toBe("CHANGES REQUESTED");
  });

  it("never approves a failed/cancelled run", () => {
    for (const runState of ["failed", "cancelled"]) {
      expect(run(null, { runState }).verdict).toBe("PARTIAL — NOT APPROVED");
    }
  });

  it("blocking beats incomplete (ported ordering)", () => {
    const ev = run(
      result(
        consolidated({
          readiness: "unknown",
          findings: [{ id: "f-1", severity: "blocking", title: "bad", why: "x", reviewers: ["security"] }],
        }),
      ),
    );
    expect(ev.verdict).toBe("CHANGES REQUESTED");
  });

  it("reviewer change is advisory at best", () => {
    const ev = run(result(consolidated()), { reviewerChange: true });
    expect(ev.verdict).toBe("ADVISORY — AUTOMATION CLEARED");
    expect(ev.action).toBe("COMMENT");
  });

  it("abstains on an empty cohort", () => {
    const ev = run(null, { eligible: [], noEligibleReviewers: true, runState: "none" });
    expect(ev.verdict).toBe("ABSTAINED");
  });

  it("parseProgramResult fails closed on malformed and rev 1 bodies", () => {
    expect(parseProgramResult(null)).toBeNull();
    expect(parseProgramResult({ consolidated: {} })).toBeNull();
    expect(
      parseProgramResult({ consolidated: consolidated(), reviewerOutcomes: { security: "ok" } }),
    ).toBeNull(); // rev 1 shape no longer parses
  });
});

describe("render (rev 2)", () => {
  it("renders an advisory reviewer's blocker as MUST FIX", () => {
    const c = consolidated({
      readiness: "not_ready",
      findings: [
        { id: "f-1", severity: "blocking", title: "Broken contract", why: "unsafe", reviewers: ["docs"] },
      ],
    });
    const ev = run(result(c));
    const out = render({
      headSha: "abc1234def",
      evaluation: ev,
      consolidated: c,
      reviewerNames: ["Docs (local)"],
      reviewerChange: false,
      changedPaths: [],
      runDetails: [],
    });
    expect(out.body).toContain("orc-review · CHANGES REQUESTED");
    expect(out.body).toContain("MUST FIX (1) · SHOULD FIX (0)");
    expect(out.body).not.toContain("Severity capped");
  });

  it("renders findings, counts, inline anchors, and run details", () => {
    const c = consolidated({
      readiness: "not_ready",
      findings: [
        { id: "f-1", severity: "blocking", title: "SQLi", path: "src/db.ts", line: 12, why: "raw concat", fix: "parameterize", reviewers: ["security"] },
        { id: "f-2", severity: "nit", title: "naming", why: "meh", reviewers: ["docs"] },
      ],
    });
    const ev = run(result(c));
    const out = render({
      headSha: "abc1234def",
      evaluation: ev,
      consolidated: c,
      reviewerNames: ["Security", "Abhinav", "Docs"],
      reviewerChange: false,
      changedPaths: ["src/db.ts"],
      runDetails: [["run", "r_x_123"]],
    });
    expect(out.body).toContain("orc-review · CHANGES REQUESTED · abc1234");
    expect(out.body).toContain("MUST FIX (1) · SHOULD FIX (0) · CONSIDER (0) · NIT (1)");
    expect(out.inlineComments).toHaveLength(1);
    expect(out.body).toContain("run: `r_x_123`");
  });

  it("marks dirty reviews in the header", () => {
    const c = consolidated();
    const ev = run(result(c));
    const out = render({
      headSha: "abc1234def",
      dirty: true,
      evaluation: ev,
      consolidated: c,
      reviewerNames: ["Security"],
      reviewerChange: false,
      changedPaths: [],
      runDetails: [],
    });
    expect(out.body).toContain("orc-review · APPROVED · abc1234+dirty");
  });

  it("notes degraded lane coverage on a complete run", () => {
    const c = consolidated();
    const ev = run(result(c, { ...ALL_OK, "abhinav/lanes/1": "error" }));
    const out = render({
      headSha: "abc1234def",
      evaluation: ev,
      consolidated: c,
      reviewerNames: ["Security", "Abhinav", "Docs"],
      reviewerChange: false,
      changedPaths: [],
      runDetails: [],
    });
    expect(out.body).toContain("Partial lane coverage: abhinav/lanes/1 failed");
    expect(out.body).toContain("No findings survived scrutiny.");
  });
});
