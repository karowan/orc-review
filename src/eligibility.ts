/**
 * Changed-Reviewer classification. Reviewer definitions always compile from the
 * trusted base tree, so a PR cannot alter its own reviewers; a reviewer whose
 * content differs at head is excluded from execution, and any change under
 * `.orc-review/` caps the verdict at ADVISORY (never approved by automation).
 */
import { CONFIG_ROOT, type Classification, type ReviewConfig, type SelectionResult, type Tree } from "./contracts.js";
import { loadConfig } from "./config.js";

export function classify(args: {
  baseConfig: ReviewConfig;
  headTree: Tree;
  changedPaths: string[];
  selection: SelectionResult;
}): Classification {
  const { baseConfig, headTree, changedPaths, selection } = args;
  const reviewerChange = changedPaths.some(
    (p) => p === `${CONFIG_ROOT}` || p.startsWith(`${CONFIG_ROOT}/`),
  );

  const changed: string[] = [];
  const eligible: string[] = [];

  // Head-side compile decides what "unchanged" can even mean. If the head
  // config no longer compiles, nothing is provably unchanged — every selected
  // reviewer is treated as changed (fail closed, like config_invalid upstream).
  let headHashes = new Map<string, string>();
  let headInvalid = false;
  if (reviewerChange) {
    try {
      const headConfig = loadConfig(headTree);
      headHashes = new Map(headConfig.reviewers.map((r) => [r.id, r.contentHash]));
    } catch {
      headInvalid = true;
    }
  }

  const byId = new Map(baseConfig.reviewers.map((r) => [r.id, r]));
  for (const { id } of selection.reviewers) {
    const base = byId.get(id);
    if (!base) continue; // selection guarantees registration; defensive
    if (reviewerChange) {
      const touched = changedPaths.some((p) => base.paths.includes(p));
      const headHash = headHashes.get(id);
      if (headInvalid || touched || headHash === undefined || headHash !== base.contentHash) {
        changed.push(id);
        continue;
      }
    }
    eligible.push(id);
  }

  return { reviewerChange, changed, eligible };
}
