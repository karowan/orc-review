# orc-review — domain context

orc-review is the **review workflow engine**: given a repository with a
`.orc-review/` configuration and a base ref, it creates, runs, and monitors one
review workflow on the [orc](../orc) runtime, and returns a rendered
Consolidated Review. Nothing past that — no GitHub, no Slack, no human-approval
coordination, no checkout materialization, no publication. Those belong to a
future service layer that *calls* this engine.

The governance concepts (deterministic selection, reviewer-change caps,
fail-closed verdicts) predate this repo; the execution paradigm is orc's.

## The two layers

| Layer | Owns |
|---|---|
| **orc-review (this repo)** | Config compile, deterministic selection, eligibility, program planning (model-authored `orc.ts`), deterministic verification, launch/monitor via `@karowanorg/orc-sdk`, verdict + Consolidated Review rendering |
| **service layer (future)** | Webhooks, PR lineage/supersession, pinned checkouts, GitHub publication, Slack, human review SLAs, affinity |

## Core pipeline: law → craft → law

1. **Select (deterministic law).** The cohort — which reviewers run — comes from
   `selection.always ∪ additions from every matching rule`, an accumulative,
   order-independent union sorted by manifest declaration order, with per-reviewer
   reasons (`always`, `rule:<id>`). Only selection facts (changed paths) may be
   consulted.
2. **Classify (deterministic law).** Any changed path under `.orc-review/` makes
   the attempt a **Reviewer Change**: changed reviewers (content hash at base ≠
   head) are excluded from the cohort and the verdict is capped at ADVISORY.
   Reviewer definitions are **always compiled from the base tree** — a PR cannot
   alter its own reviewers.
3. **Plan (model craft).** A planner model receives the compiled reviewer specs,
   selection rules, and diff facts, and authors the literal `review.orc.ts` —
   one program, one run, one promise graph, **flat** (rev 2): the union of every
   eligible bot's lanes runs as one concurrent layer with no per-reviewer
   structure. The planner's craft is exactly one thing: **merging same-mandate
   lanes across bots** (and repos) into single executions — merged prompts
   concatenate each key's verbatim text, attribution is the union of bots, the
   strongest declared model wins, `verbatim: true` bots are exempt. There is no
   support tier: every agent call is a judgment lane or the aggregator; a bot
   that wants extra work (e.g. running tests) declares it as a lane.
4. **Verify (deterministic law).** The generated program is checked by AST:
   every lane key runs exactly once (a merged call may carry several keys, each
   interpolated verbatim — the planner never holds prompt bodies); judgment
   prompts are PROMPTS-headed; verbatim bots' keys sit in single-key calls;
   judgment carries `SCHEMAS.findings`; every call is a judgment lane or the
   aggregator (free-prompt calls are rejected); exactly one
   aggregator call (MERGE_PROMPT-headed, `SCHEMAS.consolidated`, zero PROMPTS
   refs); no `readOnly`/`cwd`/`host`/`ext` escapes. Then `orc validate`
   live-probes harnesses, models, and efforts. Bounded retry with feedback;
   final fallback is a deterministic template generator (which never merges).
5. **Run.** One orc run: pinned bundle (its sha256 is the review spec), journal
   as the evidence trail, orc's monitor as the review UI. All leaves read-only.
   The single **aggregator** (default `gpt-5.6-sol` on codex; `run.aggregator_*`
   to override) consumes every lane envelope directly and dedupes aggressively:
   same defect merges across bots (worst severity, union attribution), symptom
   chains collapse into causes, repeated patterns compress, adjacent nits
   coalesce. Depth is exactly 1 — no other stage merges judgment. Per-bot
   `aggregation_notes` (rev 1's internal `synthesis:` prompt, repurposed) carry
   each bot's adjudication voice into the aggregator.
6. **Render (deterministic law).** Fail-closed verdict algebra ported from
   the predecessor design, with rev 2 lane semantics: a failed lane degrades coverage
   (noted in the review); a required bot with **zero** surviving lanes — or a
   total wipeout — → `PARTIAL — NOT APPROVED`; surviving blocking finding →
   `CHANGES REQUESTED`; Reviewer Change → `ADVISORY — AUTOMATION CLEARED`;
   ready and clean → `APPROVED`; empty cohort → `ABSTAINED`. Blocking severity
   only survives if a `can_block` bot sourced it (deterministically capped
   otherwise; merged findings pass if any contributing bot can block).

## Invariants (ported ADRs)

- **A Reviewer Change is never approved by automation** — advisory at best.
- **Config is repository-owned** (`.orc-review/` in the reviewed repo), and
  trusted only from the base tree.
- **Selection is deterministic**; the planner chooses *how* to run reviewers,
  never *whether*.
- **Judgment is verbatim; merging is concatenation; nothing else runs.**
  Every call is a judgment lane or the aggregator; no lane's output reaches
  another lane; judgment prompt text is injected, never planner-rewritten — a
  merged lane concatenates verbatim texts, it does not unify them.
- **Fail-closed everywhere**: verification failure degrades to the template
  plan; lane failure of a required reviewer degrades the verdict, never hides.

## Reviewer authoring

```
.orc-review/
├── manifest.yaml            # closed schema: reviewers, selection, run knobs
└── reviewers/
    ├── security.md          # simple: YAML frontmatter (model/effort/can_block) + prompt
    └── abhinav/
        ├── reviewer.yaml    # composite: lanes (each prompt+model) + aggregation_notes
        └── prompts/*.md
```

A composite reviewer is a declarative spec — its lanes join the flat layer and
its `aggregation_notes` speak for it in the aggregator. From the outside
(selection, eligibility, verdict, `required`, attribution) a bot is atomic:
one reviewer id. (`synthesis:` is accepted as a rev 1 migration alias for
`aggregation_notes`.)

## Local registry & dirty reviews

Personal bots live in `~/.orc-review/registry/` and are called onto a run with
`--with <name>`. They are advisory by construction (authority only ever comes
from the reviewed repo's base-tree manifest), excluded from Reviewer-Change
classification, and labeled "(local)" in attribution and provenance.

Dirty worktrees are first-class: the change under review is base→worktree, the
attempt identity (`changeId`) is `headSha` extended with a worktree fingerprint
(HEAD + diff + untracked contents), briefs pin the merge-base SHA, and the
rendered header carries a `+dirty` marker.

## Vocabulary

- **Attempt** — one engine invocation for one (dir, baseRef, headSha).
- **Cohort** — the deterministically selected reviewer (bot) ids.
- **Eligible bot** — cohort member not altered by the change under review.
- **Judgment lane** — an agent call whose prompt is one or more bots' verbatim
  lane texts (several = a **merged lane**, union attribution).
- **Aggregator** — the single depth-1 consolidation stage; the only place
  findings merge.
- **Plan** — the generated `review.orc.ts` (pinned by orc at launch).
- **Consolidated Review** — the single rendered verdict + findings document.
