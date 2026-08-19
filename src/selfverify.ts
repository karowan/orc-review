/**
 * Self-verification: the planner's tool access to the same deterministic
 * judges that will grade its program — assemble + AST verify — so it can
 * iterate to a green program INSIDE its session instead of gambling one
 * shot against an unseen verifier. The engine re-verifies authoritatively;
 * this is the planner's workbench, not the gate.
 */
import { assemble, type AssemblyInput } from "./assemble.js";
import type { ModelPolicy } from "./contracts.js";
import { extractProgramBody } from "./planner.js";
import { verifyProgram } from "./verify.js";

export interface PlanVerifyInput {
  assembly: AssemblyInput;
  maxJudgmentCalls?: number;
  modelPolicy?: ModelPolicy;
}

/** Verifies a candidate program body; returns the verifier's problems ([] = valid). */
export function verifyProgramBody(input: PlanVerifyInput, body: string): string[] {
  const source = assemble(input.assembly, extractProgramBody(body));
  return verifyProgram(source, input.assembly.reviewers, {
    maxJudgmentCalls: input.maxJudgmentCalls,
    modelPolicy: input.modelPolicy,
    aggregator: input.assembly.aggregator,
  });
}

/** File names the planner leaf finds in its scratch working directory. */
export const PLAN_INPUT_FILE = "plan-input.json";
export const PLAN_SKELETON_FILE = "skeleton.ts";
export const PLAN_PROGRAM_FILE = "program.ts";
