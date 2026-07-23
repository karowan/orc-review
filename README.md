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

To preflight once and execute those exact verified program bytes later:

```bash
orc-review plan --program --json > review-plan.json
orc-review run --plan-file review-plan.json --json
```

`run --plan-file` re-resolves the change and reviewer definitions, rejects a
stale or modified artifact, and never calls the planner again.

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
- **Plan** — a planner model (default `claude-fable-5` via the `claude` CLI;
  `planner.harness: codex` uses subscription-authenticated Codex)
  authors the literal orc program as a **flat lane layer**: the union of every
  eligible bot's lanes, concurrent, depth 1. Its craft is **packing compatible
  lanes within or across bots** into fewer executions (verbatim texts
  concatenated, findings attributed to every included lane, strongest declared
  model wins). `planner.max_calls` plus `planner.required: true` makes that
  optimization a verified ceiling rather than a suggestion. There is no support
  tier — a test lane is just another lane. `--no-planner` (or
  `planner.disabled: true`) uses a deterministic template that never merges.
- **Verify** — an AST verifier enforces the contract: every lane key exactly
  once (merged calls may carry several), judgment prompts verbatim-headed from
  injected constants, verbatim bots never merged, exactly one aggregator call,
  writable reviewer leaves, no cwd/host/ext escapes, schemas attached, and—when
  configured—every physical call's exact harness/model/effort appears in
  `model_policy.allowed`. Then orc's `validate` live-probes models/harnesses.
  Rejected plans retry with feedback, then fall back to the template.
- **Run** — one orc run in a sandbox: reviewer leaves may write test/build
  artifacts but are instructed not to alter tracked source or perform external
  side effects; the aggregator remains read-only. The pinned program bundle is
  the review spec, the journal is the evidence trail. The
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
model_policy:
  allowed:
    - { harness: codex, model: gpt-5.6-sol, effort: medium }
    - { harness: codex, model: gpt-5.6-sol, effort: high }
    - { harness: claude, model: "claude-opus-4-8[1m]", effort: max }
  preferences:                 # optional planner guidance matrix
    - harness: codex
      model: gpt-5.6-sol
      effort: medium
      metadata:
        speed: very_fast
        cost: low
        intelligence: high
        guidance: default for broad merged review packets
    - harness: codex
      model: gpt-5.6-sol
      effort: high
      metadata:
        speed: fast
        cost: medium
        intelligence: very_high
        guidance: use when a declared lane requires deeper reasoning
run:
  budget: 5           # reactive USD cap for the run
planner:
  harness: codex
  effort: medium
  max_calls: 6
  required: true
  model: gpt-5.6-sol
```

`model_policy` is optional. When present, it is a fail-closed exact allowlist
for the configured planner, every reviewer lane declaration, the aggregator,
and the planner's final physical judgment calls. Harness, model, and effort
must match one entry; omitted fields do not inherit permission. This lets a
repository constrain provider/model selection while leaving lane-packing
judgment to the planner.

`model_policy.preferences` is an optional matrix over a subset of `allowed`.
Each row carries a non-empty, open-ended `metadata` map. `speed`, `cost`, and
`intelligence` are conventional examples, not built-in fields; repositories can
add any YAML metadata they want. `orc-review` serializes the matrix into the
planner prompt and assigns no meaning to its keys. Preferences grant no
execution permission and cannot replace a lane's unique harness/tool
requirement.

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
npm install       # installs the published orc runtime packages
npm test
npm run typecheck
```
