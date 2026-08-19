import { describe, expect, it } from "vitest";
import type { Harness, HarnessEvent, LeafRequest, Registry } from "@karowanorg/orc-core";

import { PROGRAM_SCHEMA, extractProgramBody, harnessPlanner } from "../src/planner.js";

const PROGRAM =
  "export default async ({ agent, parallel, phase, settle, log }) => {\n  return { consolidated: null, laneOutcomes: {} };\n};";

function fakeRegistry(events: HarnessEvent[], captured: LeafRequest[]): Registry {
  const harness: Harness = {
    name: "codex",
    discover: async () => ({
      available: true,
      models: [],
      approvalModes: ["auto"],
      structuredOutput: true,
      sessions: false,
    }),
    async *invoke(request) {
      captured.push(request);
      yield* events;
    },
  };
  return {
    harnesses: new Map([["codex", harness]]),
    extensions: new Map(),
    defaultHarness: "codex",
    executor: {} as Registry["executor"],
  };
}

describe("harnessPlanner", () => {
  it("runs one structured read-only leaf through the registry and returns the program", async () => {
    const captured: LeafRequest[] = [];
    const registry = fakeRegistry([{ kind: "result", output: { program: PROGRAM } }], captured);
    const planner = harnessPlanner({
      cwd: "/tmp",
      harness: "codex",
      model: "openai.gpt-5.6-sol",
      reasoningEffort: "medium",
      resolveRegistry: async () => registry,
    });

    await expect(planner("plan this")).resolves.toBe(PROGRAM);

    expect(captured).toHaveLength(1);
    const request = captured[0];
    // The planner is a leaf like any lane: structured output, read-only, the
    // host-resolved model — the serving path is whatever the registry runs.
    expect(request.prompt).toBe("plan this");
    expect(request.schema).toBe(PROGRAM_SCHEMA);
    expect(request.readOnly).toBe(true);
    expect(request.model).toBe("openai.gpt-5.6-sol");
    expect(request.reasoningEffort).toBe("medium");
  });

  it("falls back to the registry default harness when none is configured", async () => {
    const captured: LeafRequest[] = [];
    const registry = fakeRegistry([{ kind: "result", output: { program: PROGRAM } }], captured);
    const planner = harnessPlanner({ cwd: "/tmp", resolveRegistry: async () => registry });
    await expect(planner("p")).resolves.toBe(PROGRAM);
  });

  it("names the missing harness and lists what is registered", async () => {
    const registry = fakeRegistry([], []);
    const planner = harnessPlanner({
      cwd: "/tmp",
      harness: "claude",
      resolveRegistry: async () => registry,
    });
    await expect(planner("p")).rejects.toThrow(/planner harness "claude" is not registered \(available: codex\)/);
  });

  it("surfaces a harness error event as the failure", async () => {
    const registry = fakeRegistry([{ kind: "error", message: "quota exhausted" }], []);
    const planner = harnessPlanner({ cwd: "/tmp", harness: "codex", resolveRegistry: async () => registry });
    await expect(planner("p")).rejects.toThrow(/planner model failed: quota exhausted/);
  });

  it("uses accumulated text when the harness emits no structured result", async () => {
    const registry = fakeRegistry(
      [
        { kind: "text", delta: "```ts\n", atMs: 0 },
        { kind: "text", delta: `${PROGRAM}\n`, atMs: 1 },
        { kind: "text", delta: "```", atMs: 2 },
      ],
      [],
    );
    const planner = harnessPlanner({ cwd: "/tmp", harness: "codex", resolveRegistry: async () => registry });
    const raw = await planner("p");
    expect(extractProgramBody(raw)).toBe(PROGRAM);
  });

  it("rejects an empty response", async () => {
    const registry = fakeRegistry([{ kind: "result", output: { program: "  " } }], []);
    const planner = harnessPlanner({ cwd: "/tmp", harness: "codex", resolveRegistry: async () => registry });
    await expect(planner("p")).rejects.toThrow(/returned no program/);
  });
});

describe("extractProgramBody", () => {
  it("unwraps the structured {program} payload", () => {
    expect(extractProgramBody(JSON.stringify({ program: PROGRAM }))).toBe(PROGRAM);
  });

  it("unwraps a fenced JSON wrapper", () => {
    expect(extractProgramBody("```json\n" + JSON.stringify({ program: PROGRAM }) + "\n```")).toBe(PROGRAM);
  });

  it("still accepts a fenced code block", () => {
    expect(extractProgramBody("prose\n```ts\n" + PROGRAM + "\n```")).toBe(PROGRAM);
  });

  it("passes raw text through", () => {
    expect(extractProgramBody(`  ${PROGRAM}  `)).toBe(PROGRAM);
  });
});
