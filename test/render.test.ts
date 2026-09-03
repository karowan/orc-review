import { describe, expect, it } from "vitest";
import { render } from "../src/render.js";
import type { Evaluation } from "../src/verdict.js";

const FINDING = {
  id: "f1",
  severity: "blocking" as const,
  title: "Ticket lock does not cover concurrent description writers",
  path: "ensemble/intaketool.py",
  line: 547,
  why: "SlackDoor concurrently replaces descriptions without the lock.",
  fix: "Coordinate every read-modify-write path with the ticket lock.",
  reviewers: ["8b2d6d1c0ffee/karowan", "8b2d6d1c0ffee/devpatel"],
};

function evaluation(overrides: Partial<Evaluation> = {}): Evaluation {
  return {
    verdict: "CHANGES REQUESTED",
    action: "REQUEST_CHANGES",
    blocking: true,
    complete: true,
    failedLanes: [],
    failedRequired: [],
    findings: [FINDING],
    ...overrides,
  } as Evaluation;
}

const INPUT = {
  headSha: "89ab04d".padEnd(40, "0"),
  evaluation: evaluation(),
  consolidated: {
    summary: "The change is not ready until all competing description writers are coordinated.",
    findings: [], coverage: ["Intake inspection", "Locking and recovery"], omissions: [],
    readiness: "not_ready" as const,
  },
  reviewerNames: ["Karowan (frank)", "Dev Patel (frank)"],
  reviewerChange: false,
  changedPaths: ["ensemble/intaketool.py"],
  runDetails: [["run", "r_review-x"]] as Array<[string, string]>,
};

describe("render", () => {
  it("keeps the machine-read verdict line first and byte-stable", () => {
    const { body } = render(INPUT);
    expect(body.startsWith("orc-review · CHANGES REQUESTED · 89ab04d")).toBe(true);
  });

  it("reads top-down: summary, scannable finding lines, details folded", () => {
    const { body } = render(INPUT);
    const summaryAt = body.indexOf("not ready until");
    const listAt = body.indexOf("### Blocking (1)");
    const lineAt = body.indexOf("- **MUST FIX** Ticket lock does not cover");
    const detailsAt = body.indexOf("<summary>Details and fixes (1)</summary>");
    const coverageAt = body.indexOf("<summary>Review coverage</summary>");
    expect(summaryAt).toBeGreaterThan(-1);
    expect(listAt).toBeGreaterThan(summaryAt);
    expect(lineAt).toBeGreaterThan(listAt);
    expect(detailsAt).toBeGreaterThan(lineAt);
    expect(coverageAt).toBeGreaterThan(detailsAt);
  });

  it("attributes findings by persona, never by qualified hash ids", () => {
    const { body } = render(INPUT);
    expect(body).toContain("karowan, devpatel");
    expect(body).not.toContain("8b2d6d1c0ffee");
  });

  it("de-hashes failed-lane health notes", () => {
    const { body } = render({
      ...INPUT,
      evaluation: evaluation({ failedLanes: ["8b2d6d1c0ffee/security/prompt"] }),
    });
    expect(body).toContain("Partial lane coverage: security failed");
    expect(body).not.toContain("8b2d6d1c0ffee");
  });

  it("still anchors inline comments to changed-path findings", () => {
    const { inlineComments } = render(INPUT);
    expect(inlineComments).toHaveLength(1);
    expect(inlineComments[0].path).toBe("ensemble/intaketool.py");
    expect(inlineComments[0].body).toContain("#### Ticket lock");
  });
});
