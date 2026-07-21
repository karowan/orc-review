# orc-review

Model-planned code review workflows on the [orc](../orc) runtime. orc-review is
**only** the review workflow engine — creation, running, and monitoring of one
review workflow, plus a rendered verdict. No GitHub, no Slack, no webhooks, no
checkout management; a future service layer composes those around this engine.

```
orc-review validate                 # check .orc-review config in the working tree
orc-review plan --base origin/main  # deterministic cohort + reasons, instant
orc-review plan --program           # ...plus the planner-authored orc program
orc-review run  --base origin/main  # run the review; prints the Consolidated Review
orc-review run  --with karowan      # add a personal bot from the local registry
orc-review bots                     # list local-registry bots

orc-review run --repo app=~/code/app@origin/main \
               --repo lib=~/code/lib@origin/main   # review a repo SET together
```

A review always runs over a **set of repo pins (N ≥ 1)** — one repo is a set of
size one; there is no single-vs-multi mode. Each repo brings its own
`.orc-review` config; bots and paths are namespaced by repo id
(`app/security`, `lib/src/q.ts`); lanes run in a composed symlink workspace.
Custom repo sources (e.g. a GitHub PR fetcher) register in
`orc-review.config.mjs` and are addressed by scheme (`github:acme/lib#412`).
A repo without config fails the run unless `--allow-uncovered` (rendered as an
omission and never approved). The full design lives in
[docs/design.html](docs/design.html).

Dirty worktrees review first-class: uncommitted and untracked changes are part
of the change under review, the attempt identity gains a worktree fingerprint
(`abc1234+dirty` in the header), and lanes are briefed to diff against the
pinned merge-base SHA so a moving base branch can't skew them.

**Local bot registry.** Repo config defines a repo's reviewers; your personal
bots live once in `~/.orc-review/registry/` (same formats: `<name>.md` or
`<name>/reviewer.yaml`) and join any run via `--with <name>`. Registry bots are
never required and receive no repo-granted publication authority, but their
finding severities remain intact for full-fidelity dry-run reviews. They render
as "Name (local)".

Every run gets orc's live monitor (URL printed at launch) and a self-contained
`report.html`.

## How a review runs

```
select (deterministic) → classify (deterministic) → plan (model) →
verify (deterministic) → one orc run → verdict + render (deterministic)
```

- **Select** — `.orc-review/manifest.yaml` rules pick the cohort from changed
  paths alone. Accumulative union, declaration order, per-reviewer reasons.
- **Classify** — reviewers compile from the **base** tree; a PR touching
  `.orc-review/` is a Reviewer Change: altered reviewers are excluded and the
  verdict is capped at ADVISORY. Automation never approves changes to review
  authority.
- **Plan** — a planner model (default `claude-fable-5` via the `claude` CLI)
  authors the literal orc program as a **flat lane layer**: the union of every
  eligible bot's lanes, concurrent, depth 1. Its craft is **merging
  same-mandate lanes across bots** (two security reviews → one execution,
  verbatim texts concatenated, findings attributed to both bots, strongest
  declared model wins). There is no support tier — a test lane is just another
  lane, and merging is what deduplicates shared work. `--no-planner` (or
  `planner.disabled: true`) uses a deterministic template that never merges.
- **Verify** — an AST verifier enforces the contract: every lane key exactly
  once (merged calls may carry several), judgment prompts verbatim-headed from
  injected constants, verbatim bots never merged, exactly one aggregator call,
  no write/cwd/host/ext escapes, schemas attached. Then orc's `validate`
  live-probes models/harnesses. Rejected plans retry with feedback, then fall
  back to the template.
- **Run** — one orc run, all leaves read-only in your worktree; the pinned
  program bundle is the review spec, the journal is the evidence trail. The
  single **aggregator** (default `gpt-5.6-sol` on codex; `run.aggregator_model`
  / `run.aggregator_harness` / `run.aggregator_effort` to override) consumes
  every lane envelope and dedupes aggressively — cross-bot merges, symptom
  chains, repeated patterns, adjacent nits.
- **Verdict** — fail-closed: a failed lane only degrades coverage, but a
  required bot with zero surviving lanes (or a total wipeout) never approves;
  finding severity is preserved independently of publication authority;
  `APPROVED`,
  `CHANGES REQUESTED`, `PARTIAL — NOT APPROVED`, `ADVISORY — AUTOMATION
  CLEARED`, `ABSTAINED`.

## Configuring reviewers

```
.orc-review/
├── manifest.yaml
└── reviewers/
    ├── security.md          # simple reviewer
    └── abhinav/             # composite reviewer
        ├── reviewer.yaml
        └── prompts/*.md
```

`manifest.yaml`:

```yaml
version: 1
reviewers:
  - id: security
    source: reviewers/security.md
  - id: abhinav
    source: reviewers/abhinav
selection:
  always: [security]
  rules:
    - id: backend
      when: { any_changed_path: ["**/*.go", "src/**"] }
      add: [abhinav]
run:
  budget: 5           # reactive USD cap for the run
planner:
  model: claude-fable-5
```

Simple reviewer (`reviewers/security.md`) — frontmatter + prompt:

```markdown
---
model: claude-sonnet-5
can_block: true
---
You are the security reviewer. Hunt for injection, authz, and secret handling defects.
```

Composite reviewer (`reviewers/abhinav/reviewer.yaml`) — several lanes, each
its own model/harness, plus the bot's adjudication voice for the aggregator:

```yaml
display_name: Abhinav
can_block: true
lanes:
  - { prompt: prompts/correctness.md, model: claude-opus-4-8 }
  - { prompt: prompts/tests.md,       model: claude-sonnet-5 }
aggregation_notes: prompts/adjudicate.md   # rev 1's `synthesis:` still accepted
```

From the outside a bot is atomic: one reviewer id, selected, excluded,
required, and attributed as a unit. Its lanes run in the flat layer alongside
everyone else's; there is no per-bot synthesis stage — the aggregator honors
each bot's `aggregation_notes` instead.

## Embedding (the layer-2 seam)

```ts
import { prepare, execute, review } from "orc-review";

const outcome = await review({ dir, baseRef: "origin/main" });
outcome.evaluation.verdict;        // "APPROVED" | ...
outcome.evaluation.action;         // advisory GitHub action hint
outcome.rendered.body;             // Consolidated Review markdown
outcome.rendered.inlineComments;   // findings anchored to changed files
outcome.monitorUrl;                // orc live monitor
```

`prepare()` alone gives the deterministic half (cohort, classification,
generated program) without launching anything.

## Development

```
npm install       # links the sibling ../orc checkout
npm test
npm run typecheck
```
