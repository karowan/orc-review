/**
 * orc-review CLI — validate | plan | run | bots. Creation, running, and
 * monitoring of the review workflow; nothing past it.
 */
import { Command } from "commander";
import { execFile } from "node:child_process";
import { loadConfig, ConfigError } from "./config.js";
import { worktreeTree } from "./git.js";
import { prepare, review, type ReviewOptions } from "./runner.js";
import { defaultRegistryDir, listRegistry } from "./registry.js";

const program = new Command("orc-review")
  .description("model-planned code review workflows on the orc runtime")
  .option("--dir <path>", "repository directory (single-repo sugar)", ".")
  .option("--base <ref>", "trusted base ref (single-repo sugar)", "origin/main")
  .option("--repo <repo...>", "repo set entry: [id=][scheme:]spec[@base] (repeatable)");

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

interface CommonLocal {
  planner?: boolean;
  with?: string[];
  registry?: string;
  allowUncovered?: boolean;
  json?: boolean;
}

const reviewOptions = (cmd: Command, local: CommonLocal): ReviewOptions => {
  const g = cmd.optsWithGlobals();
  return {
    repos: g.repo,
    dir: g.dir,
    baseRef: g.base,
    allowUncovered: local.allowUncovered,
    planner: local.planner === false ? null : undefined,
    withBots: local.with,
    registryDir: local.registry,
    onProgress: (m) => console.error(m),
  };
};

program
  .command("validate")
  .description("validate the working tree's .orc-review configuration")
  .action((_: unknown, cmd: Command) => {
    const { dir } = cmd.optsWithGlobals();
    try {
      const config = loadConfig(worktreeTree(dir));
      const lanes = config.reviewers.reduce((n, r) => n + r.lanes.length, 0);
      console.log(
        `configuration is valid: ${config.reviewers.length} reviewers (${lanes} lanes), ${config.manifest.selection.rules.length} selection rules`,
      );
    } catch (err) {
      fail(err instanceof ConfigError ? err.message : String(err));
    }
  });

program
  .command("bots")
  .description("list local-registry bots (~/.orc-review/registry)")
  .option("--registry <dir>", "registry directory override")
  .action((local: { registry?: string }) => {
    const names = listRegistry(local.registry);
    if (names.length === 0) console.log(`(registry is empty — add ${defaultRegistryDir()}/<name>.md)`);
    for (const name of names) console.log(name);
  });

program
  .command("plan")
  .description("show the deterministic cohort — and with --program, the planned orc program")
  .option("--program", "run the planner and print the generated program", false)
  .option("--no-planner", "use the deterministic template instead of the plan model")
  .option("--with <bot...>", "call local-registry bots onto the run (always advisory)")
  .option("--registry <dir>", "registry directory override")
  .option("--allow-uncovered", "skip repos without .orc-review (noted as omissions)", false)
  .option("--json", "machine-readable output", false)
  .action(async (local: CommonLocal & { program?: boolean }, cmd: Command) => {
    try {
      const prepared = await prepare({ ...reviewOptions(cmd, local), planOnly: !local.program });
      if (local.json) {
        const { perRepo, pins, ...rest } = prepared;
        console.log(
          JSON.stringify(
            {
              ...rest,
              pins: pins.map(({ configTree, headTree, ...pin }) => pin),
              perRepo: perRepo.map((r) => ({
                repo: r.pin.id,
                selection: r.selection,
                classification: r.classification,
              })),
            },
            null,
            2,
          ),
        );
        return;
      }
      for (const r of prepared.perRepo) {
        const uncovered = prepared.uncovered.includes(r.pin.id);
        console.log(`${r.pin.id}  (${r.pin.baseLabel} → ${r.pin.headSha.slice(0, 12)}${r.pin.dirty ? "+dirty" : ""})${uncovered ? "  [UNCOVERED — not judged]" : ""}`);
        const byId = new Map(r.config?.reviewers.map((b) => [b.id, b]) ?? []);
        for (const s of r.selection?.reviewers ?? []) {
          const excluded = r.classification?.changed.includes(s.id);
          console.log(`  ${excluded ? "✗" : "✓"} ${s.id}  [${s.reasons.join(", ")}]${excluded ? "  (changed by this PR — excluded)" : ""}`);
          for (const lane of byId.get(s.id)?.lanes ?? []) {
            const model = [lane.harness, lane.model, lane.reasoningEffort].filter(Boolean).join(" · ");
            console.log(`      ${lane.promptKey}${model ? `  (${model})` : ""}`);
          }
        }
      }
      for (const id of prepared.localBots) console.log(`+ ${id}  [requested — local, advisory]`);
      if (prepared.reviewerChange) {
        console.log("reviewer change: verdict capped at ADVISORY — automation cannot approve");
      }
      for (const rejection of prepared.rejectedPlans) {
        console.error(`planner attempt rejected:\n  ${rejection.join("\n  ")}`);
      }
      if (local.program) {
        if (prepared.programSource) {
          console.error(`plan: ${prepared.plannerUsed} → ${prepared.programPath}`);
          console.log(prepared.programSource);
        } else {
          console.log("no eligible reviewers; the engine would abstain");
        }
      }
    } catch (err) {
      fail(err instanceof ConfigError ? err.message : String(err));
    }
  });

program
  .command("run")
  .description("run the review workflow and print the Consolidated Review")
  .option("--no-planner", "use the deterministic template instead of the plan model")
  .option("--budget <usd>", "reactive USD cap for the run")
  .option("--with <bot...>", "call local-registry bots onto the run (always advisory)")
  .option("--registry <dir>", "registry directory override")
  .option("--allow-uncovered", "skip repos without .orc-review (noted as omissions)", false)
  .option("--open", "open the live monitor in the browser", false)
  .option("--json", "machine-readable output", false)
  .action(async (local: CommonLocal & { budget?: string; open?: boolean }, cmd: Command) => {
    try {
      const opts: ReviewOptions = {
        ...reviewOptions(cmd, local),
        budgetUsd: local.budget ? Number(local.budget) : undefined,
        onProgress: (m) => {
          console.error(m);
          if (local.open && m.startsWith("monitor: ")) {
            execFile("open", [m.slice("monitor: ".length)], () => {});
          }
        },
      };
      const outcome = await review(opts);
      if (local.json) {
        const { prepared, ...rest } = outcome;
        console.log(
          JSON.stringify(
            {
              ...rest,
              repos: prepared.pins.map(({ configTree, headTree, ...pin }) => pin),
              cohort: prepared.eligible.map((r) => r.id),
              localBots: prepared.localBots,
              uncovered: prepared.uncovered,
              reviewerChange: prepared.reviewerChange,
              changeId: prepared.changeId,
              dirty: prepared.dirty,
              plannerUsed: prepared.plannerUsed,
              programPath: prepared.programPath,
              rejectedPlans: prepared.rejectedPlans,
            },
            null,
            2,
          ),
        );
      } else {
        console.log(outcome.rendered.body);
      }
      if (outcome.evaluation.action === "REQUEST_CHANGES" || outcome.runState === "failed") {
        process.exitCode = 2;
      }
    } catch (err) {
      fail(err instanceof ConfigError ? err.message : String(err));
    }
  });

program.parseAsync(process.argv);
