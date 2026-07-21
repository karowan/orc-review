/**
 * Repository-owned review configuration: closed schema, confined paths,
 * compiled from a Tree (worktree for `validate`, base ref for runs).
 */
import { createHash } from "node:crypto";
import { parseAllDocuments } from "yaml";
import { z } from "zod";
import {
  CONFIG_ROOT,
  MANIFEST_MAX_BYTES,
  MANIFEST_PATH,
  type CompiledLane,
  type CompiledReviewer,
  type Manifest,
  type ReviewConfig,
  type Tree,
} from "./contracts.js";

const ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`configuration violations:\n  ${problems.join("\n  ")}`);
  }
}

/** Rejects absolute, backslashed, empty-segment, and `..` paths. */
export function confinedPath(p: string): boolean {
  if (!p || p.startsWith("/") || p.includes("\\")) return false;
  const segments = p.split("/");
  return segments.every((s) => s !== "" && s !== "." && s !== "..");
}

const RuleSchema = z
  .object({
    id: z.string().regex(ID_RE, "rule id must match [a-z0-9][a-z0-9_-]*"),
    when: z.object({ any_changed_path: z.array(z.string()).nonempty() }).strict(),
    add: z.array(z.string()).nonempty(),
  })
  .strict();

const ManifestSchema = z
  .object({
    version: z.number().int().positive(),
    reviewers: z
      .array(
        z
          .object({
            id: z.string().regex(ID_RE, "reviewer id must match [a-z0-9][a-z0-9_-]*"),
            source: z.string(),
            required: z.boolean().default(true),
          })
          .strict(),
      )
      .nonempty(),
    selection: z
      .object({
        always: z.array(z.string()).default([]),
        rules: z.array(RuleSchema).default([]),
      })
      .strict()
      .default({ always: [], rules: [] }),
    run: z
      .object({
        budget: z.number().positive().optional(),
        max_parallel: z.number().int().min(1).max(64).optional(),
        sandbox: z.boolean().optional(),
        default_harness: z.string().optional(),
        aggregator_model: z.string().optional(),
        aggregator_harness: z.string().optional(),
        aggregator_effort: z.string().optional(),
      })
      .strict()
      .default({}),
    planner: z
      .object({
        model: z.string().optional(),
        disabled: z.boolean().optional(),
      })
      .strict()
      .default({}),
  })
  .strict();

const LaneFileSchema = z
  .object({
    prompt: z.string(),
    model: z.string().optional(),
    harness: z.string().optional(),
    effort: z.string().optional(),
  })
  .strict();

const CompositeSchema = z
  .object({
    display_name: z.string().optional(),
    can_block: z.boolean().default(true),
    verbatim: z.boolean().default(false),
    planner_hints: z.string().optional(),
    lanes: z.array(LaneFileSchema).nonempty(),
    /** Path to the bot's adjudication guidance, injected into the aggregator. */
    aggregation_notes: z.string().optional(),
    /** rev 1 migration alias: `synthesis.prompt` becomes aggregation_notes. */
    synthesis: LaneFileSchema.optional(),
  })
  .strict();

const FrontmatterSchema = z
  .object({
    display_name: z.string().optional(),
    can_block: z.boolean().default(true),
    verbatim: z.boolean().default(false),
    planner_hints: z.string().optional(),
    aggregation_notes: z.string().optional(), // inline text for simple reviewers
    model: z.string().optional(),
    harness: z.string().optional(),
    effort: z.string().optional(),
  })
  .strict();

function parseSingleDocYaml(text: string, where: string, problems: string[]): unknown {
  const docs = parseAllDocuments(text);
  if (docs.length !== 1) {
    problems.push(`${where}: exactly one YAML document is required`);
    return undefined;
  }
  if (docs[0].errors.length > 0) {
    problems.push(`${where}: ${docs[0].errors[0].message}`);
    return undefined;
  }
  return docs[0].toJS();
}

function zodProblems(where: string, err: z.ZodError, problems: string[]): void {
  for (const issue of err.issues) {
    const at = issue.path.length ? ` at ${issue.path.join(".")}` : "";
    problems.push(`${where}${at}: ${issue.message}`);
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Frontmatter split for simple `.md` reviewers: `---\nyaml\n---\nprompt`. */
export function splitFrontmatter(text: string): { meta: string; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: "", body: text };
  return { meta: m[1], body: m[2] };
}

function titleCase(id: string): string {
  return id
    .split(/[-_]/)
    .map((s) => (s ? s[0].toUpperCase() + s.slice(1) : s))
    .join(" ");
}

export function compileReviewer(
  tree: Tree,
  id: string,
  sourcePath: string,
  required: boolean,
  problems: string[],
): CompiledReviewer | undefined {
  if (sourcePath.endsWith(".md")) {
    const text = tree.read(sourcePath);
    if (text === null) {
      problems.push(`reviewer ${id}: source ${sourcePath} not found`);
      return undefined;
    }
    const { meta, body } = splitFrontmatter(text);
    let fm: z.infer<typeof FrontmatterSchema>;
    try {
      const raw = meta ? parseSingleDocYaml(meta, sourcePath, problems) : {};
      if (raw === undefined && meta) return undefined;
      const parsed = FrontmatterSchema.safeParse(raw ?? {});
      if (!parsed.success) {
        zodProblems(sourcePath, parsed.error, problems);
        return undefined;
      }
      fm = parsed.data;
    } catch (err) {
      problems.push(`${sourcePath}: ${String(err instanceof Error ? err.message : err)}`);
      return undefined;
    }
    if (!body.trim()) {
      problems.push(`reviewer ${id}: prompt body is empty`);
      return undefined;
    }
    const lane: CompiledLane = {
      promptKey: `${id}/prompt`,
      promptText: body.trim(),
      promptPath: sourcePath,
      harness: fm.harness,
      model: fm.model,
      reasoningEffort: fm.effort,
    };
    return {
      id,
      displayName: fm.display_name ?? titleCase(id),
      canBlock: fm.can_block,
      required,
      verbatim: fm.verbatim,
      lanes: [lane],
      aggregationNotes: fm.aggregation_notes,
      plannerHints: fm.planner_hints,
      contentHash: sha256(`${sourcePath}\0${text}`),
      paths: [sourcePath],
    };
  }

  // Composite: a directory with reviewer.yaml + prompt files.
  const specPath = `${sourcePath}/reviewer.yaml`;
  const specText = tree.read(specPath);
  if (specText === null) {
    problems.push(`reviewer ${id}: ${specPath} not found`);
    return undefined;
  }
  const raw = parseSingleDocYaml(specText, specPath, problems);
  if (raw === undefined) return undefined;
  const parsed = CompositeSchema.safeParse(raw);
  if (!parsed.success) {
    zodProblems(specPath, parsed.error, problems);
    return undefined;
  }
  const spec = parsed.data;

  const loadLane = (lane: z.infer<typeof LaneFileSchema>, key: string): CompiledLane | undefined => {
    if (!confinedPath(lane.prompt)) {
      problems.push(`reviewer ${id}: prompt path ${lane.prompt} escapes the reviewer directory`);
      return undefined;
    }
    const promptPath = `${sourcePath}/${lane.prompt}`;
    const text = tree.read(promptPath);
    if (text === null) {
      problems.push(`reviewer ${id}: prompt ${promptPath} not found`);
      return undefined;
    }
    if (!text.trim()) {
      problems.push(`reviewer ${id}: prompt ${promptPath} is empty`);
      return undefined;
    }
    return {
      promptKey: key,
      promptText: text.trim(),
      promptPath,
      harness: lane.harness,
      model: lane.model,
      reasoningEffort: lane.effort,
    };
  };

  const lanes: CompiledLane[] = [];
  for (const [i, lane] of spec.lanes.entries()) {
    const compiled = loadLane(lane, `${id}/lanes/${i}`);
    if (!compiled) return undefined;
    lanes.push(compiled);
  }

  // Aggregation notes: rev 2 field, with rev 1's `synthesis.prompt` as alias.
  const notesRel = spec.aggregation_notes ?? spec.synthesis?.prompt;
  let aggregationNotes: string | undefined;
  if (notesRel !== undefined) {
    if (!confinedPath(notesRel)) {
      problems.push(`reviewer ${id}: aggregation notes path ${notesRel} escapes the reviewer directory`);
      return undefined;
    }
    const notesPath = `${sourcePath}/${notesRel}`;
    const text = tree.read(notesPath);
    if (text === null || !text.trim()) {
      problems.push(`reviewer ${id}: aggregation notes ${notesPath} not found or empty`);
      return undefined;
    }
    aggregationNotes = text.trim();
  }

  const files = tree.list(sourcePath);
  const contentHash = sha256(files.map((p) => `${p}\0${tree.read(p) ?? ""}`).join("\n"));
  return {
    id,
    displayName: spec.display_name ?? titleCase(id),
    canBlock: spec.can_block,
    required,
    verbatim: spec.verbatim,
    lanes,
    aggregationNotes,
    plannerHints: spec.planner_hints,
    contentHash,
    paths: files,
  };
}

/** Loads and validates the full review configuration from a tree. */
export function loadConfig(tree: Tree): ReviewConfig {
  const problems: string[] = [];
  const text = tree.read(MANIFEST_PATH);
  if (text === null) throw new ConfigError([`${MANIFEST_PATH} not found`]);
  if (Buffer.byteLength(text) > MANIFEST_MAX_BYTES) {
    throw new ConfigError([`${MANIFEST_PATH} exceeds ${MANIFEST_MAX_BYTES} bytes`]);
  }

  const raw = parseSingleDocYaml(text, MANIFEST_PATH, problems);
  if (raw === undefined) throw new ConfigError(problems);
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) {
    zodProblems(MANIFEST_PATH, parsed.error, problems);
    throw new ConfigError(problems);
  }
  const m = parsed.data;

  const manifest: Manifest = {
    version: m.version,
    reviewers: m.reviewers.map((r) => ({ id: r.id, source: r.source, required: r.required })),
    selection: {
      always: m.selection.always,
      rules: m.selection.rules.map((r) => ({
        id: r.id,
        anyChangedPath: r.when.any_changed_path,
        add: r.add,
      })),
    },
    run: {
      budgetUsd: m.run.budget,
      maxParallel: m.run.max_parallel,
      sandbox: m.run.sandbox,
      defaultHarness: m.run.default_harness,
      aggregatorModel: m.run.aggregator_model,
      aggregatorHarness: m.run.aggregator_harness,
      aggregatorEffort: m.run.aggregator_effort,
    },
    planner: { model: m.planner.model, disabled: m.planner.disabled },
  };

  // Structural rules.
  const ids = new Set<string>();
  for (const r of manifest.reviewers) {
    if (ids.has(r.id)) problems.push(`duplicate reviewer id ${r.id}`);
    ids.add(r.id);
    if (!confinedPath(r.source)) problems.push(`reviewer ${r.id}: source path ${r.source} is not confined`);
  }
  for (const id of manifest.selection.always) {
    if (!ids.has(id)) problems.push(`selection.always references unknown reviewer ${id}`);
  }
  const ruleIds = new Set<string>();
  for (const rule of manifest.selection.rules) {
    if (ruleIds.has(rule.id)) problems.push(`duplicate selection rule id ${rule.id}`);
    ruleIds.add(rule.id);
    for (const pattern of rule.anyChangedPath) {
      if (!confinedPath(pattern.replaceAll("*", "x").replaceAll("?", "x"))) {
        problems.push(`rule ${rule.id}: pattern ${pattern} is not confined`);
      }
    }
    for (const id of rule.add) {
      if (!ids.has(id)) problems.push(`rule ${rule.id} adds unknown reviewer ${id}`);
    }
  }
  if (problems.length > 0) throw new ConfigError(problems);

  const reviewers: CompiledReviewer[] = [];
  for (const entry of manifest.reviewers) {
    const compiled = compileReviewer(tree, entry.id, `${CONFIG_ROOT}/${entry.source}`, entry.required, problems);
    if (compiled) reviewers.push(compiled);
  }
  if (problems.length > 0) throw new ConfigError(problems);

  return { manifest, reviewers };
}
