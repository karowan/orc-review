import { describe, expect, it } from "vitest";
import { REVIEW_RUN_POLICY, reviewBrief, type PreparedReview } from "../src/runner.js";

describe("review execution policy", () => {
  it("allows disposable local test writes while replacing source transport and GitHub access", () => {
    const prepared = {
      pins: [{ id: "repo", diffBriefing: "base → head" }],
    } as PreparedReview;

    expect(REVIEW_RUN_POLICY).toEqual({ approvalMode: "auto", allowWrites: true, sandbox: true });
    expect(reviewBrief(prepared, '{"pr":123,"checks":"passing"}')).toContain(
      "You may run tests and create build, cache, or temporary files inside the allowed workspace",
    );
    expect(reviewBrief(prepared, '{"pr":123,"checks":"passing"}')).toContain(
      "Return the requested structured result directly to the orchestrator",
    );
    expect(reviewBrief(prepared, '{"pr":123,"checks":"passing"}')).toContain(
      '{"pr":123,"checks":"passing"}',
    );
    expect(reviewBrief(prepared)).not.toContain("Never modify anything");
  });
});
