/**
 * Host model resolution — reconciles a manifest's canonical model names with
 * whatever this host's deployment calls the same models.
 *
 * Repo manifests pin portable canonical names (`claude-opus-5[1m]`,
 * `gpt-5.6-sol`): the same bytes on every host, validated by repo-owned
 * model policy. Gateway deployments expose those models under namespaced or
 * versioned ids — `global.anthropic.claude-opus-5[1m]`, `openai.gpt-5.6-sol`,
 * Bedrock's `us.anthropic.claude-opus-5-20260115-v1:0`, Vertex's
 * `claude-opus-5@20260115` — so the declared name matches nothing the host
 * reports and every call dies in preflight.
 *
 * Orc already discovers what a host actually has; passing it a model the host
 * did not report is a configuration error. This module maps declared →
 * discovered before anything is planned, so orc only ever receives ids from
 * its own catalog. Resolution is intentionally shape-based, never a model
 * list: new models need no orc-review release, only new manifest pins.
 *
 * The resolved plan is therefore bound to this host's catalog snapshot:
 * `plan` and `run` re-derive identically on one host, and a plan file is not
 * portable to a host whose catalog differs.
 */
import { Orc } from "@karowanorg/orc-sdk";
import { ConfigError } from "./config.js";
import {
  DEFAULT_CODEX_PLANNER_MODEL,
  DEFAULT_PLANNER_MODEL,
  type AggregatorOptions,
  type CompiledReviewer,
  type Manifest,
} from "./contracts.js";

export interface HostModelCatalog {
  defaultHarness?: string;
  /** Model ids each harness's catalog reports. */
  harnesses: Record<string, string[]>;
}

/** One resolution outcome, for attribution and rendering. */
export interface ModelResolutionNote {
  harness: string;
  declared: string;
  resolved: string;
  surfaces: string[];
  /** True when a policy-only entry was removed because this host cannot serve it. */
  dropped?: boolean;
}

export function parseHostCatalog(raw: unknown): HostModelCatalog {
  const root = (raw ?? {}) as { defaultHarness?: unknown; harnesses?: Record<string, unknown> };
  const harnesses: HostModelCatalog["harnesses"] = {};
  for (const [name, capsRaw] of Object.entries(root.harnesses ?? {})) {
    const caps = (capsRaw ?? {}) as { models?: unknown };
    harnesses[name] = Array.isArray(caps.models)
      ? caps.models
          .map((m) => (m && typeof m === "object" ? (m as { id?: unknown }).id : undefined))
          .filter((id): id is string => typeof id === "string")
      : [];
  }
  return {
    defaultHarness: typeof root.defaultHarness === "string" ? root.defaultHarness : undefined,
    harnesses,
  };
}

export async function fetchHostCatalog(cwd: string, defaultHarness?: string): Promise<HostModelCatalog> {
  return parseHostCatalog(await new Orc({ cwd, defaultHarness }).capabilities());
}

/** Inference-profile ARNs carry the model id as their last path segment. */
function bareId(id: string): string {
  return id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
}

/**
 * The model name left after stripping a leading provider namespace: the
 * maximal run of digit-free dot-segments (`openai.`, `global.anthropic.`,
 * `us.anthropic.`). Segments with digits belong to the model name itself
 * (`gpt-5.6-sol` keeps its internal dots), so a declared name must equal the
 * FULL remainder — a truncated name like `6-sol` never matches.
 */
function namespaceStripped(id: string): string | undefined {
  const segments = id.split(".");
  let start = 0;
  while (start < segments.length - 1 && /^[a-z][a-z_-]*$/.test(segments[start])) start++;
  return start > 0 ? segments.slice(start).join(".") : undefined;
}

// Versioned gateway schemes that embed a date/version the canonical name
// lacks, so namespace stripping alone cannot cover them.
const BEDROCK_ID = /^(?:[a-z]{2,6}\.)?anthropic\.([a-z0-9]+(?:-[a-z0-9]+)*?)-(\d{8})-v\d+(?::\d+)?(\[[^\]]+\])?$/;
const VERTEX_ID = /^([a-z0-9]+(?:[.-][a-z0-9]+)*?)@(\d{8})(\[[^\]]+\])?$/;

/** Canonical names a versioned gateway id can serve (empty for others). */
export function versionedCoverage(id: string): string[] {
  const bare = bareId(id);
  const m = BEDROCK_ID.exec(bare) ?? VERTEX_ID.exec(bare);
  if (!m) return [];
  const [, family, date, suffix = ""] = m;
  return [`${family}${suffix}`, `${family}-${date}${suffix}`];
}

/**
 * Resolve one declared model against a harness catalog. Ordered rules:
 * exact id (first-party hosts — untouched), unique namespace-stripped
 * equality (`openai.gpt-5.6-sol` covers exactly `gpt-5.6-sol`), unique
 * versioned-scheme coverage (Bedrock/Vertex). No match and ambiguity both
 * fail closed: the first is a name this host cannot serve, the second is a
 * host-configuration question orc-review must not answer with a coin flip.
 */
export function resolveModelName(declared: string, ids: string[], harness: string): string {
  if (ids.includes(declared)) return declared;
  const candidates = [
    ...new Set(
      ids.filter((id) => {
        const bare = bareId(id);
        return bare === declared || namespaceStripped(bare) === declared || versionedCoverage(id).includes(declared);
      }),
    ),
  ];
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    throw new ConfigError([
      `model "${declared}" (harness ${harness}) is ambiguous on this host: ${candidates.join(", ")} — fix the host so one deployment covers it`,
    ]);
  }
  throw new ConfigError([
    `model "${declared}" (harness ${harness}) is not available on this host`,
    `host catalog for ${harness}: ${ids.join(", ")}`,
  ]);
}

/**
 * Resolve every model surface of a prepared review IN PLACE against the host
 * catalog: reviewer lanes, model-policy tuples, the planner, the aggregator.
 * Policy validation upstream already ran on declared names; from here on the
 * program, its verification, and orc's preflight all speak host ids
 * consistently. Returns the resolutions performed.
 *
 * Resolution must not depend on run-time options (planner flags and the
 * like): the mutated manifest feeds the plan contract, so any input beyond
 * (repo content, host catalog) would make `plan` and `run` disagree about
 * their own artifact.
 *
 * A harness whose catalog is missing or empty is skipped — the same leniency
 * orc's own preflight applies — so a host that cannot enumerate models keeps
 * today's pass-through behavior.
 */
export function resolveReviewModels(input: {
  eligible: CompiledReviewer[];
  manifest?: Manifest;
  /** The derived aggregator for this run — resolved even when no manifest exists. */
  aggregator: AggregatorOptions;
  catalog: HostModelCatalog;
}): ModelResolutionNote[] {
  const { eligible, manifest, aggregator, catalog } = input;
  const notes = new Map<string, ModelResolutionNote>();
  const record = (harness: string, declared: string, resolved: string, surface: string, dropped?: boolean) => {
    const key = `${harness}\0${declared}`;
    const note = notes.get(key) ?? { harness, declared, resolved, surfaces: [], ...(dropped ? { dropped } : {}) };
    note.surfaces.push(surface);
    notes.set(key, note);
  };

  const resolve = (harness: string | undefined, declared: string | undefined, surface: string): string | undefined => {
    const name = harness ?? manifest?.run.defaultHarness ?? catalog.defaultHarness;
    if (!declared || !name) return declared;
    const ids = catalog.harnesses[name] ?? [];
    if (ids.length === 0) return declared;
    const resolved = resolveModelName(declared, ids, name);
    if (resolved !== declared) record(name, declared, resolved, surface);
    return resolved;
  };

  for (const reviewer of eligible) {
    for (const lane of reviewer.lanes) {
      lane.model = resolve(lane.harness, lane.model, `lane ${lane.promptKey}`);
    }
  }

  if (manifest?.modelPolicy) {
    // A policy entry is a permission AND a planner menu item. A resolvable
    // entry is rewritten so it matches resolved calls; one this host cannot
    // serve is dropped — leaving it declared would keep it selectable by the
    // planner and only fail later, at run time. An entry any resolvable lane
    // needs always resolves (same catalog), so dropping cannot strand a lane.
    const keep = <T extends { harness: string; model: string }>(entries: T[], surface: string): T[] =>
      entries.filter((entry) => {
        try {
          entry.model = resolve(entry.harness, entry.model, surface) ?? entry.model;
          return true;
        } catch {
          record(entry.harness, entry.model, entry.model, surface, true);
          return false;
        }
      });
    manifest.modelPolicy.allowed = keep(manifest.modelPolicy.allowed, "model_policy.allowed") as typeof manifest.modelPolicy.allowed;
    if (manifest.modelPolicy.preferences) {
      manifest.modelPolicy.preferences = keep(manifest.modelPolicy.preferences, "model_policy.preferences") as typeof manifest.modelPolicy.preferences;
    }
  }

  if (manifest && !manifest.planner.disabled) {
    const plannerHarness = manifest.planner.harness ?? "claude";
    const explicit = manifest.planner.model;
    const declared =
      explicit ??
      (plannerHarness === "codex"
        ? DEFAULT_CODEX_PLANNER_MODEL
        : plannerHarness === "claude"
          ? DEFAULT_PLANNER_MODEL
          : undefined);
    try {
      // A custom harness with no model is rejected by config validation; the
      // undefined guard here just keeps resolution total.
      const resolved = declared === undefined ? undefined : resolve(plannerHarness, declared, "planner");
      // Materialize only when resolution changed something: an untouched
      // default stays implicit, exactly as authored.
      if (resolved !== undefined && resolved !== declared) manifest.planner.model = resolved;
    } catch (err) {
      // A pinned planner model the host cannot serve is a configuration error.
      // An implicit default is not the manifest's promise: leave it alone and
      // let the planner attempt fail into the template fallback.
      if (explicit !== undefined) throw err;
    }
  }

  aggregator.model = resolve(aggregator.harness, aggregator.model, "aggregator") ?? aggregator.model;

  return [...notes.values()];
}
