/**
 * JSON Schemas for structured lane output. Injected into the generated program
 * as the SCHEMAS constant; also used to parse results defensively host-side.
 */
import type { Json } from "@karowanorg/orc-sdk/program";

export const OMISSION_KINDS = ["lane_failure", "test_not_run", "external_context", "evidence_gap"] as const;

const FINDING_PROPS: Record<string, Json> = {
  severity: { enum: ["blocking", "warning", "consider", "nit"] },
  title: { type: "string" },
  path: { type: "string", description: "file path as <repoId>/<path> (repos are mounted by id in the workspace); omit if not file-anchored" },
  line: { type: "integer", minimum: 1 },
  why: { type: "string", description: "why this matters" },
  fix: { type: "string", description: "suggested fix" },
};

/** Per-lane / per-reviewer findings document. */
export const FINDINGS_SCHEMA: Json = {
  type: "object",
  additionalProperties: false,
  required: ["findings", "coverage"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "title", "why"],
        properties: FINDING_PROPS,
      },
    },
    coverage: { type: "array", items: { type: "string" }, description: "aspects actually reviewed" },
    omissions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "subject", "reason"],
        properties: {
          kind: { type: "string" },
          subject: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
  },
};

/** The top-level synthesis output. */
export const CONSOLIDATED_SCHEMA: Json = {
  type: "object",
  additionalProperties: false,
  required: ["findings", "coverage", "omissions", "readiness", "summary"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "severity", "title", "why", "reviewers"],
        properties: {
          ...FINDING_PROPS,
          id: { type: "string", description: "stable slug, e.g. f-auth-timing" },
          reviewers: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            description: "reviewer ids whose judgment sourced this finding",
          },
        },
      },
    },
    coverage: { type: "array", items: { type: "string" } },
    omissions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "subject", "reason"],
        properties: {
          kind: { enum: [...OMISSION_KINDS] },
          subject: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
    readiness: { enum: ["ready", "not_ready", "unknown"] },
    summary: { type: "string" },
  },
};
