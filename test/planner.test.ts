import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile }));

import { codexCliPlanner } from "../src/planner.js";

describe("codexCliPlanner", () => {
  it("preserves Codex provider config while pinning planner safety settings", async () => {
    const stdin = new PassThrough();
    execFile.mockImplementation((...call: unknown[]) => {
      const callback = call[3] as (err: Error | null, stdout: string, stderr: string) => void;
      queueMicrotask(() => callback(null, "program", ""));
      return { stdin };
    });

    await expect(codexCliPlanner("gpt-5.6-sol", "high")("plan this")).resolves.toBe("program");

    expect(execFile).toHaveBeenCalledOnce();
    expect(execFile.mock.calls[0][1]).toEqual([
      "exec",
      "--model",
      "gpt-5.6-sol",
      "--sandbox",
      "read-only",
      "--ephemeral",
      "--ignore-rules",
      "--skip-git-repo-check",
      "-c",
      'approval_policy="never"',
      "-c",
      'model_reasoning_effort="high"',
      "-",
    ]);
  });
});
