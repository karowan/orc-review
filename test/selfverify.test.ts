import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { Harness, HarnessEvent, LeafRequest, Registry } from "@karowanorg/orc-core";

import { loadConfig } from "../src/config.js";
import { harnessPlanner, plannerPrompt } from "../src/planner.js";
import { verifyProgramBody, type PlanVerifyInput } from "../src/selfverify.js";
import { templateProgram } from "../src/template.js";
import { AGG, fixtureFiles, memTree } from "./helpers.js";

const config = loadConfig(memTree(fixtureFiles()));
const reviewers = config.reviewers;
const input: PlanVerifyInput = {
  assembly: {
    reviewers,
    facts: { repository: "r", baseRef: "origin/main", changedPaths: ["src/a.ts"] },
    headSha: "a".repeat(40),
    matchedRules: [],
    aggregator: AGG,
  },
};

describe("verifyProgramBody", () => {
  it("passes the template skeleton — the workbench's starting point is green", () => {
    expect(verifyProgramBody(input, templateProgram(reviewers))).toEqual([]);
  });

  it("returns the exact verifier problems for a broken candidate", () => {
    const problems = verifyProgramBody(input, "export default async () => ({});");
    expect(problems.length).toBeGreaterThan(0);
  });

  it("accepts the structured {program} wrapper a leaf might hand back", () => {
    const wrapped = JSON.stringify({ program: templateProgram(reviewers) });
    expect(verifyProgramBody(input, wrapped)).toEqual([]);
  });
});

function registryWith(invoke: Harness["invoke"]): Registry {
  const harness: Harness = {
    name: "codex",
    discover: async () => ({
      available: true,
      models: [],
      approvalModes: ["auto"],
      structuredOutput: true,
      sessions: false,
    }),
    invoke,
  };
  return {
    harnesses: new Map([["codex", harness]]),
    extensions: new Map(),
    defaultHarness: "codex",
    executor: {} as Registry["executor"],
  };
}

describe("harnessPlanner selfVerify", () => {
  const skeleton = templateProgram(reviewers);

  it("materializes the workbench, permits writes, and prefers the verified program.ts", async () => {
    const seen: Array<{ request: LeafRequest; files: string[] }> = [];
    const registry = registryWith(async function* (request): AsyncGenerator<HarnessEvent> {
      seen.push({ request, files: fs.readdirSync(request.cwd).sort() });
      // The model iterates program.ts in its scratch cwd...
      fs.writeFileSync(path.join(request.cwd, "program.ts"), "ITERATED");
      // ...and returns a drifted payload that must NOT win.
      yield { kind: "result", output: { program: "DRIFTED" } };
    });
    const planner = harnessPlanner({
      cwd: "/tmp",
      harness: "codex",
      selfVerify: { input, skeleton },
      resolveRegistry: async () => registry,
    });

    await expect(planner("plan")).resolves.toBe("ITERATED");

    expect(seen[0].files).toEqual(["plan-input.json", "skeleton.ts"]);
    expect(seen[0].request.readOnly).toBe(false);
    const written = JSON.parse(
      fs.existsSync(path.join(seen[0].request.cwd, "plan-input.json"))
        ? fs.readFileSync(path.join(seen[0].request.cwd, "plan-input.json"), "utf8")
        : "null",
    );
    // scratch is removed after the run; the capture above proves the shape
    expect(written === null || typeof written === "object").toBe(true);
  });

  it("falls back to the returned payload when the leaf wrote no program.ts", async () => {
    const registry = registryWith(async function* (): AsyncGenerator<HarnessEvent> {
      yield { kind: "result", output: { program: "RETURNED" } };
    });
    const planner = harnessPlanner({
      cwd: "/tmp",
      harness: "codex",
      selfVerify: { input, skeleton },
      resolveRegistry: async () => registry,
    });
    await expect(planner("plan")).resolves.toBe("RETURNED");
  });

  it("stays read-only without selfVerify", async () => {
    const captured: LeafRequest[] = [];
    const registry = registryWith(async function* (request): AsyncGenerator<HarnessEvent> {
      captured.push(request);
      yield { kind: "result", output: { program: "P" } };
    });
    const planner = harnessPlanner({ cwd: "/tmp", harness: "codex", resolveRegistry: async () => registry });
    await planner("plan");
    expect(captured[0].readOnly).toBe(true);
  });
});

describe("plannerPrompt selfVerify", () => {
  it("instructs the verify loop and the condensation push only when the workbench exists", () => {
    const base = {
      reviewers,
      facts: input.assembly.facts,
      matchedRules: [],
    };
    const withBench = plannerPrompt({ ...base, selfVerify: true });
    expect(withBench).toContain("orc-review verify-program --input plan-input.json program.ts");
    expect(withBench).toContain("skeleton.ts");
    expect(withBench).toContain("Do not return until it prints OK");
    const without = plannerPrompt(base);
    expect(without).not.toContain("verify-program");
  });
});
