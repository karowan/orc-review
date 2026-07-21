/**
 * Deterministic Reviewer Selection.
 * Accumulative, order-independent union with no remove/first-match/last-writer
 * semantics; sorted by manifest declaration order; per-reviewer reasons.
 */
import type { Facts, Manifest, SelectionResult } from "./contracts.js";

/**
 * Matches one repo-relative slash path against a glob where `**` spans any
 * number of path segments and other segments follow Go path.Match semantics
 * (`*`, `?`, `[...]` within a segment). Purely lexical and deterministic.
 */
export function matchChangedPath(pattern: string, changed: string): boolean {
  return matchSegments(pattern.split("/"), changed.split("/"));
}

function matchSegments(pattern: string[], target: string[]): boolean {
  if (pattern.length === 0) return target.length === 0;
  if (pattern[0] === "**") {
    if (matchSegments(pattern.slice(1), target)) return true;
    if (target.length === 0) return false;
    return matchSegments(pattern, target.slice(1));
  }
  if (target.length === 0) return false;
  if (!matchSegment(pattern[0], target[0])) return false;
  return matchSegments(pattern.slice(1), target.slice(1));
}

/** One-segment glob (Go path.Match on a segment with no `/`). */
export function matchSegment(pattern: string, name: string): boolean {
  const re = segmentRegex(pattern);
  return re !== null && re.test(name);
}

function segmentRegex(pattern: string): RegExp | null {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      out += ".*";
      i++;
    } else if (ch === "?") {
      out += ".";
      i++;
    } else if (ch === "\\") {
      if (i + 1 >= pattern.length) return null; // trailing escape is malformed
      out += escapeRegex(pattern[i + 1]);
      i += 2;
    } else if (ch === "[") {
      let j = i + 1;
      let cls = "";
      let negated = false;
      if (pattern[j] === "^" || pattern[j] === "!") {
        negated = true;
        j++;
      }
      let closed = false;
      while (j < pattern.length) {
        const c = pattern[j];
        if (c === "]" && cls !== "") {
          closed = true;
          j++;
          break;
        }
        if (c === "\\") {
          if (j + 1 >= pattern.length) return null;
          cls += escapeCharClass(pattern[j + 1]);
          j += 2;
          continue;
        }
        cls += c === "-" ? "-" : escapeCharClass(c);
        j++;
      }
      if (!closed) return null; // malformed class never matches (Go returns error)
      out += `[${negated ? "^" : ""}${cls}]`;
      i = j;
    } else {
      out += escapeRegex(ch);
      i++;
    }
  }
  try {
    return new RegExp(`^${out}$`);
  } catch {
    return null;
  }
}

function escapeRegex(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

function escapeCharClass(ch: string): string {
  return /[\\\]^]/.test(ch) ? `\\${ch}` : ch;
}

function conditionMatches(anyChangedPath: string[], changedPaths: string[]): boolean {
  for (const pattern of anyChangedPath) {
    for (const changed of changedPaths) {
      if (matchChangedPath(pattern, changed)) return true;
    }
  }
  return false;
}

/**
 * Computes the deterministic cohort:
 *
 *   selection.always ∪ additions from every matching rule ∪ eligible affinity
 *
 * Unknown affinity ids are ignored (affinity is a preference, never authority).
 */
export function select(manifest: Manifest, facts: Facts, affinity: string[] = []): SelectionResult {
  const reasons = new Map<string, string[]>();
  const add = (id: string, reason: string) => {
    reasons.set(id, [...(reasons.get(id) ?? []), reason]);
  };

  for (const id of manifest.selection.always) add(id, "always");

  const matched: string[] = [];
  for (const rule of manifest.selection.rules) {
    if (!conditionMatches(rule.anyChangedPath, facts.changedPaths)) continue;
    matched.push(rule.id);
    for (const id of rule.add) add(id, `rule:${rule.id}`);
  }

  const known = new Set(manifest.reviewers.map((r) => r.id));
  for (const id of affinity) {
    if (known.has(id)) add(id, "affinity");
  }

  const order = new Map(manifest.reviewers.map((r, i) => [r.id, i]));
  const ids = [...reasons.keys()].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));

  for (const id of ids) {
    if (!known.has(id)) throw new Error(`selected reviewer "${id}" is not registered`);
  }

  return {
    reviewers: ids.map((id) => ({ id, reasons: [...(reasons.get(id) ?? [])].sort() })),
    matchedRules: matched,
  };
}
