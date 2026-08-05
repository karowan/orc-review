/** orc-review library surface — the engine a future service layer embeds. */
export * from "./contracts.js";
export { loadConfig, ConfigError, confinedPath, splitFrontmatter } from "./config.js";
export { select, matchChangedPath, matchSegment } from "./selection.js";
export { classify } from "./eligibility.js";
export { assemble, promptTable, MERGE_PROMPT } from "./assemble.js";
export { templateProgram } from "./template.js";
export { plannerPrompt, claudeCliPlanner, extractProgramBody, DEFAULT_PLANNER_MODEL, type PlanModel } from "./planner.js";
export { verifyProgram } from "./verify.js";
export {
  fetchHostCatalog,
  parseHostCatalog,
  resolveModelName,
  resolveReviewModels,
  versionedCoverage,
  type HostModelCatalog,
  type ModelResolutionNote,
} from "./models.js";
export { evaluate, parseProgramResult, type Evaluation, type VerdictInput } from "./verdict.js";
export { render, type RenderedReview, type RenderInput, type InlineComment } from "./render.js";
export { prepare, execute, review, aggregatorOptions, qualifyReviewer, type ReviewOptions, type PreparedReview, type ReviewOutcome, type RepoReview } from "./runner.js";
export { parseRepoArg, resolvePins, gitSource, defineRepoSource, sourceRegistry, loadToolConfig, type RepoArg } from "./sources.js";
export { composeWorkspace } from "./workspace.js";
export { FINDINGS_SCHEMA, CONSOLIDATED_SCHEMA } from "./schemas.js";
export { refTree, worktreeTree, changedPaths, headSha, baseSha, repoToplevel, worktreeState, type WorktreeState } from "./git.js";
export { loadLocalReviewers, listRegistry, defaultRegistryDir } from "./registry.js";
