/**
 * Host model resolution: canonical manifest names vs gateway catalogs.
 * The fixture catalog is a real internal deployment's `orc capabilities`
 * output shape: every id namespaced (global.anthropic.*, openai.*).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ConfigError } from "../src/config.js";
import {
  parseHostCatalog,
  resolveModelName,
  resolveReviewModels,
  versionedCoverage,
  type HostModelCatalog,
} from "../src/models.js";
import { prepare } from "../src/runner.js";
import type { AggregatorOptions, CompiledReviewer, Manifest } from "../src/contracts.js";

const GATEWAY: HostModelCatalog = {
  defaultHarness: "codex",
  harnesses: {
    claude: [
      "global.anthropic.claude-opus-5",
      "global.anthropic.claude-fable-5[1m]",
      "global.anthropic.claude-sonnet-5",
      "global.anthropic.claude-opus-5[1m]",
      "global.anthropic.claude-opus-4-8",
    ],
    codex: ["openai.gpt-5.6-sol", "openai.gpt-5.6-terra", "openai.gpt-5.5"],
  },
};

function aggregator(): AggregatorOptions {
  return { harness: "codex", model: "gpt-5.6-sol", reasoningEffort: "high" };
}

describe("resolveModelName", () => {
  it("passes through ids the host lists natively", () => {
    expect(resolveModelName("global.anthropic.claude-opus-5", GATEWAY.harnesses.claude, "claude")).toBe(
      "global.anthropic.claude-opus-5",
    );
  });

  it("matches canonical names by namespace-stripped equality, dots in names included", () => {
    expect(resolveModelName("claude-opus-5[1m]", GATEWAY.harnesses.claude, "claude")).toBe(
      "global.anthropic.claude-opus-5[1m]",
    );
    expect(resolveModelName("gpt-5.6-sol", GATEWAY.harnesses.codex, "codex")).toBe("openai.gpt-5.6-sol");
  });

  it("rejects truncated or partial names instead of resolving them", () => {
    // "6-sol" is a dotted suffix of openai.gpt-5.6-sol but NOT the full
    // model name after the namespace — a typo must fail closed, not run an
    // unintended model.
    expect(() => resolveModelName("6-sol", GATEWAY.harnesses.codex, "codex")).toThrow(ConfigError);
    expect(() => resolveModelName("5", GATEWAY.harnesses.codex, "codex")).toThrow(ConfigError);
    expect(() => resolveModelName("opus-5", GATEWAY.harnesses.claude, "claude")).toThrow(ConfigError);
  });

  it("covers versioned gateway ids (Bedrock, ARN, Vertex)", () => {
    const bedrock = ["us.anthropic.claude-opus-5-20260115-v1:0[1m]", "us.anthropic.claude-sonnet-5-20260201-v1:0"];
    expect(resolveModelName("claude-opus-5[1m]", bedrock, "claude")).toBe(
      "us.anthropic.claude-opus-5-20260115-v1:0[1m]",
    );
    expect(resolveModelName("claude-sonnet-5-20260201", bedrock, "claude")).toBe(
      "us.anthropic.claude-sonnet-5-20260201-v1:0",
    );
    const arn = ["arn:aws:bedrock:us-west-2:123456789012:inference-profile/us.anthropic.claude-opus-5-20260115-v1:0"];
    expect(resolveModelName("claude-opus-5", arn, "claude")).toBe(arn[0]);
    expect(versionedCoverage("claude-opus-5@20260115")).toEqual(["claude-opus-5", "claude-opus-5-20260115"]);
  });

  it("fails closed on a model this host cannot serve, naming the catalog", () => {
    expect(() => resolveModelName("claude-haiku-4-5", GATEWAY.harnesses.claude, "claude")).toThrow(
      /not available on this host/,
    );
    try {
      resolveModelName("claude-haiku-4-5", GATEWAY.harnesses.claude, "claude");
    } catch (err) {
      expect((err as ConfigError).message).toContain("global.anthropic.claude-opus-5");
    }
  });

  it("fails closed on ambiguity instead of picking a region", () => {
    const multi = ["us.anthropic.claude-opus-5-20260115-v1:0", "eu.anthropic.claude-opus-5-20260115-v1:0"];
    expect(() => resolveModelName("claude-opus-5", multi, "claude")).toThrow(/ambiguous on this host/);
  });
});

function reviewer(model: string | undefined, harness: string | undefined): CompiledReviewer {
  return {
    id: "sec",
    displayName: "Security",
    canBlock: true,
    required: true,
    verbatim: false,
    lanes: [{ promptKey: "sec/prompt", promptText: "p", promptPath: "reviewers/sec.md", model, harness }],
    contentHash: "0".repeat(64),
    paths: ["reviewers/sec.md"],
  };
}

function manifest(): Manifest {
  return {
    version: 1,
    reviewers: [{ id: "sec", source: "reviewers/sec.md", required: true }],
    selection: { always: ["sec"], rules: [] },
    modelPolicy: {
      allowed: [
        { harness: "codex", model: "gpt-5.6-sol", reasoningEffort: "medium" },
        { harness: "claude", model: "claude-opus-5[1m]", reasoningEffort: "xhigh" },
      ],
      preferences: [{ harness: "codex", model: "gpt-5.6-sol", reasoningEffort: "medium", metadata: {} }],
    },
    run: { defaultHarness: "codex", aggregatorModel: "gpt-5.6-sol", aggregatorHarness: "codex" },
    planner: { harness: "codex", model: "gpt-5.6-sol", effort: "medium", required: true },
  };
}

describe("resolveReviewModels", () => {
  it("rewrites lanes, policy, planner, and aggregator to host ids and reports every rewrite", () => {
    const m = manifest();
    const agg = aggregator();
    const bots = [reviewer("claude-opus-5[1m]", "claude"), reviewer("gpt-5.6-sol", undefined)];
    const notes = resolveReviewModels({ eligible: bots, manifest: m, aggregator: agg, catalog: GATEWAY });

    expect(bots[0].lanes[0].model).toBe("global.anthropic.claude-opus-5[1m]");
    // Lane without a harness resolves through the manifest default harness.
    expect(bots[1].lanes[0].model).toBe("openai.gpt-5.6-sol");
    expect(m.modelPolicy!.allowed.map((a) => a.model)).toEqual(["openai.gpt-5.6-sol", "global.anthropic.claude-opus-5[1m]"]);
    expect(m.modelPolicy!.preferences![0].model).toBe("openai.gpt-5.6-sol");
    expect(m.planner.model).toBe("openai.gpt-5.6-sol");
    expect(agg.model).toBe("openai.gpt-5.6-sol");
    // The manifest's run section is never touched: the derived aggregator is
    // the resolved surface.
    expect(m.run.aggregatorModel).toBe("gpt-5.6-sol");

    const byDeclared = Object.fromEntries(notes.map((n) => [n.declared, n]));
    expect(byDeclared["claude-opus-5[1m]"].resolved).toBe("global.anthropic.claude-opus-5[1m]");
    expect(byDeclared["gpt-5.6-sol"].resolved).toBe("openai.gpt-5.6-sol");
    expect(byDeclared["gpt-5.6-sol"].surfaces).toContain("planner");
    expect(byDeclared["gpt-5.6-sol"].surfaces).toContain("aggregator");
  });

  it("drops a policy-only entry the host cannot serve instead of aborting the review", () => {
    const m = manifest();
    // Non-empty claude catalog that cannot serve the allowed claude entry.
    const catalog: HostModelCatalog = {
      defaultHarness: "codex",
      harnesses: { claude: ["global.anthropic.claude-opus-4-8"], codex: GATEWAY.harnesses.codex },
    };
    const bots = [reviewer("gpt-5.6-sol", "codex")];
    const notes = resolveReviewModels({ eligible: bots, manifest: m, aggregator: aggregator(), catalog });
    // The unusable entry is gone from the policy (and so from the planner
    // menu); the usable one is rewritten.
    expect(m.modelPolicy!.allowed.map((a) => a.model)).toEqual(["openai.gpt-5.6-sol"]);
    const dropped = notes.find((n) => n.dropped);
    expect(dropped?.declared).toBe("claude-opus-5[1m]");
    expect(dropped?.surfaces).toContain("model_policy.allowed");
  });

  it("still fails closed when a lane itself is unservable", () => {
    const catalog: HostModelCatalog = {
      defaultHarness: "codex",
      harnesses: { claude: ["global.anthropic.claude-opus-4-8"], codex: GATEWAY.harnesses.codex },
    };
    const bots = [reviewer("claude-sonnet-5", "claude")];
    expect(() => resolveReviewModels({ eligible: bots, aggregator: aggregator(), catalog })).toThrow(
      /not available on this host/,
    );
  });

  it("is a no-op on a first-party host and skips harnesses with an empty catalog", () => {
    const firstParty: HostModelCatalog = {
      defaultHarness: "codex",
      harnesses: { claude: ["claude-opus-5[1m]", "claude-sonnet-5"], codex: [] },
    };
    const m = manifest();
    const agg = aggregator();
    const bots = [reviewer("claude-opus-5[1m]", "claude"), reviewer("gpt-5.6-sol", "codex")];
    const notes = resolveReviewModels({ eligible: bots, manifest: m, aggregator: agg, catalog: firstParty });
    expect(notes).toEqual([]);
    expect(bots[0].lanes[0].model).toBe("claude-opus-5[1m]");
    expect(bots[1].lanes[0].model).toBe("gpt-5.6-sol");
    expect(m.planner.model).toBe("gpt-5.6-sol");
    expect(agg.model).toBe("gpt-5.6-sol");
  });

  it("materializes a planner default only when resolution changes it, independent of run options", () => {
    const m = manifest();
    delete m.planner.model; // fall back to the codex planner default
    resolveReviewModels({ eligible: [], manifest: m, aggregator: aggregator(), catalog: GATEWAY });
    expect(m.planner.model).toBe("openai.gpt-5.6-sol");
  });

  it("resolves the aggregator even without any manifest", () => {
    const agg = aggregator();
    resolveReviewModels({ eligible: [], aggregator: agg, catalog: GATEWAY });
    expect(agg.model).toBe("openai.gpt-5.6-sol");
  });
});

describe("parseHostCatalog", () => {
  it("keeps only string ids and tolerates junk", () => {
    const parsed = parseHostCatalog({
      defaultHarness: "codex",
      harnesses: {
        claude: { available: true, models: [{ id: "a" }, { id: 7 }, "junk", null] },
        broken: null,
      },
    });
    expect(parsed.harnesses.claude).toEqual(["a"]);
    expect(parsed.harnesses.broken).toEqual([]);
    expect(parseHostCatalog(undefined)).toEqual({ defaultHarness: undefined, harnesses: {} });
  });
});

// --- prepare integration: a gateway host resolves the whole template plan ----

function sh(dir: string, args: string[]): void {
  execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
}

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orc-review-models-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  sh(dir, ["config", "user.email", "t@t"]);
  sh(dir, ["config", "user.name", "t"]);
  fs.mkdirSync(path.join(dir, ".orc-review", "reviewers"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".orc-review", "manifest.yaml"),
    `version: 1\nreviewers:\n  - id: security\n    source: reviewers/security.md\nselection:\n  always: [security]\n`,
  );
  fs.writeFileSync(
    path.join(dir, ".orc-review", "reviewers", "security.md"),
    `---\nmodel: claude-sonnet-5\nharness: claude\n---\nReview for security defects.\n`,
  );
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "a.ts"), "export const a = 1;\n");
  sh(dir, ["add", "-A"]);
  sh(dir, ["commit", "-qm", "base"]);
  sh(dir, ["branch", "base"]);
  fs.writeFileSync(path.join(dir, "src", "a.ts"), "export const a = 2;\n");
  sh(dir, ["add", "-A"]);
  sh(dir, ["commit", "-qm", "change"]);
  return dir;
}

describe("prepare on a gateway host", () => {
  it("plans with host ids and records the resolution", async () => {
    const repo = makeRepo();
    const prepared = await prepare({ dir: repo, baseRef: "base", planner: null, hostCatalog: GATEWAY });
    expect(prepared.eligible[0].lanes[0].model).toBe("global.anthropic.claude-sonnet-5");
    expect(prepared.programSource).toContain('"global.anthropic.claude-sonnet-5"');
    // The aggregator default resolves too — it runs in every program.
    expect(prepared.programSource).toContain('"openai.gpt-5.6-sol"');
    expect(prepared.modelResolution).toEqual([
      {
        harness: "claude",
        declared: "claude-sonnet-5",
        resolved: "global.anthropic.claude-sonnet-5",
        // The lane key is qualified with the pin id (directory basename here).
        surfaces: [expect.stringMatching(/^lane .*security\/prompt$/)],
      },
      {
        harness: "codex",
        declared: "gpt-5.6-sol",
        resolved: "openai.gpt-5.6-sol",
        surfaces: ["aggregator"],
      },
    ]);
  }, 30_000);

  it("computes the same plan contract whatever the planner option is", async () => {
    const repo = makeRepo();
    const withoutPlanner = await prepare({ dir: repo, baseRef: "base", planner: null, hostCatalog: GATEWAY });
    const reused = await prepare({
      dir: repo,
      baseRef: "base",
      preparedPlan: JSON.parse(JSON.stringify(withoutPlanner)),
      // A different planner option than the plan was produced with must not
      // change the contract: resolution depends only on repo + catalog.
      planner: async () => {
        throw new Error("the planner must not run when a verified plan is supplied");
      },
      hostCatalog: GATEWAY,
    });
    expect(reused.planContractSha256).toBe(withoutPlanner.planContractSha256);
    expect(reused.programSource).toBe(withoutPlanner.programSource);
  }, 30_000);

  it("fails the review, not silently, when the host cannot serve a declared model", async () => {
    const repo = makeRepo();
    const noClaude: HostModelCatalog = {
      defaultHarness: "codex",
      harnesses: { claude: ["global.anthropic.claude-opus-5"], codex: GATEWAY.harnesses.codex },
    };
    await expect(prepare({ dir: repo, baseRef: "base", planner: null, hostCatalog: noClaude })).rejects.toThrow(
      /claude-sonnet-5.*not available on this host/s,
    );
  }, 30_000);
});
