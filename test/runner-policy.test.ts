import { describe, expect, it } from "vitest";
import { REVIEW_RUN_POLICY, normalizeFindingPaths, reviewBrief, reviewCacheEnvironment, type PreparedReview } from "../src/runner.js";
import type { ParsedProgramResult } from "../src/verdict.js";

describe("review execution policy", () => {
  it("allows disposable local test writes while replacing source transport and GitHub access", () => {
    const prepared = {
      pins: [{ id: "repo", diffBriefing: "base → head" }],
    } as PreparedReview;

    expect(REVIEW_RUN_POLICY).toEqual({
      approvalMode: "auto",
      allowWrites: true,
      sandbox: true,
      networkAccess: false,
    });
    expect(reviewBrief(prepared, '{"pr":123,"checks":"passing"}')).toContain(
      "run tests and create build, cache, or temporary files inside the allowed workspace",
    );
    expect(reviewBrief(prepared)).toContain("Outbound network access is disabled");
    expect(reviewBrief(prepared, undefined, true)).toContain("use the internet and external documentation/tools");
    expect(reviewBrief(prepared, '{"pr":123,"checks":"passing"}')).toContain(
      "Return the requested structured result directly to the orchestrator",
    );
    expect(reviewBrief(prepared, '{"pr":123,"checks":"passing"}')).toContain(
      '{"pr":123,"checks":"passing"}',
    );
    expect(reviewBrief(prepared)).not.toContain("Never modify anything");
  });

  it("normalizes single-repo finding paths and drops locations outside the repo", () => {
    const result = {
      consolidated: {
        findings: [
          { id: "prefixed", severity: "warning", title: "a", path: "review-123/src/a.ts", line: 2, why: "a", reviewers: ["bot"] },
          { id: "absolute", severity: "warning", title: "b", path: "/tmp/review-123/src/b.ts", line: 3, why: "b", reviewers: ["bot"] },
          { id: "relative", severity: "warning", title: "c", path: "src/c.ts", line: 4, why: "c", reviewers: ["bot"] },
          { id: "outside", severity: "warning", title: "d", path: "/etc/passwd", line: 1, why: "d", reviewers: ["bot"] },
        ],
        coverage: [],
        omissions: [],
        readiness: "not_ready",
        summary: "",
      },
      laneOutcomes: { "bot/prompt": "ok" },
    } satisfies ParsedProgramResult;

    const normalized = normalizeFindingPaths(result, [{ id: "review-123", root: "/tmp/review-123" } as never]);
    expect(normalized?.consolidated.findings.map(({ path, line }) => ({ path, line }))).toEqual([
      { path: "src/a.ts", line: 2 },
      { path: "src/b.ts", line: 3 },
      { path: "src/c.ts", line: 4 },
      { path: undefined, line: undefined },
    ]);
  });

  it("keeps tool caches inside the composed disposable workspace", () => {
    expect(reviewCacheEnvironment("/tmp/review-workspace")).toEqual({
      TMPDIR: "/tmp/review-workspace/.cache/tmp",
      GOCACHE: "/tmp/review-workspace/.cache/go-build",
      GOMODCACHE: "/tmp/review-workspace/.cache/go-mod",
      npm_config_cache: "/tmp/review-workspace/.cache/npm",
      PIP_CACHE_DIR: "/tmp/review-workspace/.cache/pip",
      XDG_CACHE_HOME: "/tmp/review-workspace/.cache/xdg",
      GRADLE_USER_HOME: "/tmp/review-workspace/.cache/gradle",
    });
  });
});
