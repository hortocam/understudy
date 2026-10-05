# Hand-off — Slice 2: Data Layer I (configuration and generation)

**Audience**: a Claude Code cloud session (or any coding agent) picked up to build slice 2 by driving
this file plus the spec triplet directly — *not* by working from the Kanban board.

**Feature**: `specs/002-data-layer/` — `spec.md`, `plan.md`, `research.md`, `data-model.md`,
`quickstart.md`, `contracts/config.schema.yaml`.
**Governing document**: `.specify/memory/constitution.md` (v1.0.0). Where anything here disagrees
with it, the constitution wins.
**Repo rules for an agent**: `CLAUDE.md` (read it first — short and binding).

## This is a whole slice, not a phase

It is one delivery slice with a single early decision point. Expect a long run: **generate
`tasks.md` first, land it on its own PR for approval, then implement against it.**

---

## 0. Environment (do this before anything else)

```bash
node --version        # MUST be 22.x. engines.node is ">=22".
command -v jq || (apt-get update && apt-get install -y jq)
npm ci
```

- **Node 22 is the hard requirement.** `engines` is advisory — `npm` will not stop you on 20.x and
  you would find out at runtime.
- **`jq`** is the only non-`package.json` tool the Spec Kit scripts want (they probe
  `jq` → `python3` → `grep/sed`). **No Python packages are needed** — the stdlib `python3 -c` is only
  a fallback parser.
- **No environment variables are required.** `grep -rn "process\.env" src/` finds nothing in the
  library. (The CLI's `USTDY_*` vars already ship; slice 2 adds none.)
- **Do NOT run `specify init`** in any form. The repo is already Spec Kit-scaffolded with the
  `hermes` integration, and re-scaffolding risks dropping the `100755` exec bits on
  `.specify/scripts/bash/*.sh` and clobbering local `.specify` state.
- The **`/speckit.*` slash commands are NOT installed** here: this integration is `hermes`, so
  `.claude/commands/` was never written and `.specify/commands/` does not exist. Implement directly
  against the specs with TDD. The Spec Kit engine in the tree (`.specify/scripts/bash/`,
  `.specify/templates/`) is available if you want it, not a precondition.
- A fresh clone has no `.specify/feature.json` (gitignored per-checkout state). If a Spec Kit script
  needs it, prime it once and **do not commit it**:
  ```bash
  SPECIFY_FEATURE_DIRECTORY=specs/002-data-layer bash .specify/scripts/bash/check-prerequisites.sh --json --require-tasks --include-tasks
  ```
  (Until `tasks.md` exists the `--require-tasks` check will complain — that is expected for task 1;
  do not let it block you.)

---

## 1. Read these first (paths relative to the repo root)

1. `CLAUDE.md` — the repo's working rules. Binding.
2. `.specify/memory/constitution.md` (v1.0.0) — the governing document. Note especially
   **spec-first** (code matches the spec, never the reverse), **TDD** (failing test first, test and
   code in the same change), **determinism by default**, **explicit over magic** (inference reported
   and pinnable), **additive evolution** (seams before the features that use them).
3. `specs/002-data-layer/spec.md` — the requirements (FR-001…FR-021, SC-001…SC-008, user stories
   1–7), plus the Amendment section at the end.
4. `specs/002-data-layer/plan.md` — the technical plan, the module tree, the derivation rules. **Read
   the "Known integration point — the config contract's location" section carefully; it becomes a
   required task.**
5. `specs/002-data-layer/research.md` — the Phase-0 decisions *with the alternatives rejected and
   the reason*. Follow the decisions; do not relitigate them.
6. `specs/002-data-layer/data-model.md` — config entities, store tables, the derivation model.
7. `specs/002-data-layer/quickstart.md` — runnable scenarios with observable expected outcomes; your
   acceptance script.
8. `specs/002-data-layer/contracts/config.schema.yaml` — the extended config contract.
9. `specs/001-slice-1-core/{spec,plan,tasks}.md` — the merged slice you are extending. `tasks.md`
   there is also the **format** to follow for the new one.
10. `docs/05-target-apis.md` — the **measured** vendor facts (0/224 operations declare an
    `operationId`; cursor paging via `paginationToken`; identities mixed integer/uuid/prefixed;
    `externalId` collides 45×). Several FRs hang on these numbers.

---

## 2. Merged state (verified against the remote — do not redo any of this)

Slice 1 is complete and merged. `main` is at `5e6dc02`.

| Phase | Tasks | PR | Merge |
|---|---|---|---|
| 1+2 Setup & shared spine | T001–T017 | #3 | `6916510` |
| 3 CRUD engine, routes, validation (MVP) | T018–T027 | #7 | `fbb8466` |
| 4 Control plane | T028–T033 | #9 | `fa42e64` |
| 5 CLI as a client | T034–T037 | #11 | `f66cb9a` |
| 6 Startup report + refusal paths | T038–T040 | #15 | `5f09823` |
| 7 Polish + acceptance run | T041–T045 | #16 | `ee624ad` |
| Contract reconciliation (A3) | T048 | #12 | `30f50c4` |

Slice 1 has **no unchecked tasks**. Its amendments in force: **A1** (`NOT_IMPLEMENTED = 501` constant
+ `NotImplementedBody`), **A2** (the two selector forms are peers, no precedence), **A3** (contract
reconciliation).

---

## 3. Create the worktree

```bash
git fetch origin
git worktree add ../understudy-slice2 -b wt/slice-2-data-layer origin/main
cd ../understudy-slice2
npm ci
```

All work happens there. **Never commit or push to `main`**, never force-push.

---

## 4. The work

### 4a. FIRST: generate `specs/002-data-layer/tasks.md`

It does not exist — `plan.md` names it as the `/speckit-tasks` Phase-2 output. This is the first
deliverable and it gates everything else.

- **It is part of the spec triplet and is a human checkpoint: raise it before implementing.**
  Generate it, commit it, and open a PR for it **alone** (§6). Continue in the same worktree once it
  is approved.
- Organise it as **sequential, independently testable phases**, `T001`-numbered in order, in the
  slice-1 style (`specs/001-slice-1-core/tasks.md`). Every implementation task is preceded by the
  test task that defines it. Mark `[P]` where tasks are genuinely parallel, and tag each with the
  user story it serves.
- The `plan.md` module tree is the task skeleton. **Two tasks the plan explicitly requires** must
  appear:
  - **The contract repoint.** `scripts/generate-config-schema.mjs` currently hardcodes
    `specs/001-slice-1-core/contracts/config.schema.yaml` and compiles it into
    `src/config/schema.generated.ts`; `tests/unit/config.test.ts` is the drift check. A task must
    repoint **both** at `specs/002-data-layer/contracts/config.schema.yaml`. Slice 1's file stays as
    history — never deleted, never edited.
  - **The vendor-document derivation run**: an opt-in, **not CI-blocking** test that runs the
    derivation against the real StubHub document (`docs/05` carries the URL + sha256). The document
    is **not vendored** — licence unresolved — so fetch on demand.
- **Two carried follow-ups must be tasks in the list** (they are slice-1 deferrals that belong to
  this slice, so they would otherwise be invisible):
  - **F-E** — `src/spec/identity.ts` maps open quantifiers (`+`, `*`, `{n,}`) to exactly one unit, so
    `^W-[0-9]+$` allocates `W-0…W-9` and then 500s on a `UNIQUE` collision while reporting
    `ambiguities: []`. Slice 2's identity work (FR-017/018) is where it must be fixed properly:
    either generate a value satisfying the bound, or report `identity-pattern-unsupported` and fall
    back — never a conforming-then-colliding counter.
  - **T043's store-interior blind spot** — the counting-decorator suite passes a store that
    materialises the whole collection internally, because the counts are recorded at the seam. Slice
    2 owns the data-volume claims, so seal it (a driver-level probe asserting the SQL `LIMIT` is
    actually bound, or equivalent). See the slice-1 follow-up for the exact shape.

### 4b. Then implement, phase by phase

Follow `spec.md` + `plan.md` + `data-model.md` + `research.md` + `quickstart.md`. The plan is
explicit about the following, so you do not have to re-derive them:

- **Four config layers** as separate modules with four different lifetimes (`config/layers/`):
  fixtures (versioned, frozen), recipes (switchable), behaviour (parsed now, consumed in slices 4–5),
  imports (slice 3). A missing layer folder is **not** an error.
- **Derivation rules** (`plan.md` → "Derivation rules"): collections from the live operations; links
  by the FR-006 evidence order — explicit config → declared extension → naming convention → implied
  nesting. **A convention hit proposes a link and decides one only when unambiguous**; otherwise
  record it *undetermined* in the report and do not act on it. This is the common case on the target
  document, not an edge case.
- **Six-level value precedence** (FR-010), with the rule that produced each value recorded, so a
  golden file can assert provenance.
- **Generation ordered by the FK graph** (FR-009); cycles detected and **reported**, never deadlocked
  and never failed opaquely (FR-008).
- **Identity spaces** (FR-017/018): integer / uuid / prefixed-string, a reserved range per collection
  kept disjoint from fixture values; two ranges that overlap refuse to start naming the collection.
- **Determinism** (FR-016, SC-002, SC-007): same seed + config ⇒ byte-identical export; adding an
  unrelated collection must not perturb any existing collection's records.
- **New dependencies**: `@faker-js/faker` ^9 and `jsonata` ^2, per `plan.md` / `research.md`.
- **The clock seam**: `src/clock.ts` (real implementation now; slice 6 swaps the virtual one behind
  it). The `Store`, `origin` and reset-mode seams from slice 1 are consumed **unchanged**.

---

## 5. Non-negotiables (the constitution's, abbreviated)

1. **TDD.** A failing test exists *before* the code that passes it, and you **show it failing on a
   real assertion** — not on a missing module. `Cannot find module` proves nothing. Test and
   implementation land in the same change.
2. **Spec-first.** Code is written to match the spec. If you believe a requirement is genuinely
   wrong, **stop and report it** rather than diverging silently — and never edit the spec to match
   the code.
3. **Determinism is testable — so test it.** Generate twice from a wiped store, export both, compare
   bytes.
4. **Golden files** for the three things principle VII names: the precedence chain, entity/FK
   inference, and the generators.
5. **One data-driven code path.** No per-endpoint handlers (SC-001 and the constitution's
   "Prohibited" list).
6. **No secrets in the repo or in config files**; no outbound call except a spec the user supplied by
   URL.
7. **Every config key ships with documentation and a runnable example** in the same change
   (principle IX).

### Fences — what you must NOT touch

- **`specs/001-slice-1-core/**` is frozen merged work.** The one exception is the contract repoint in
  §4a, which changes the generator and the drift test — **not** slice 1's contract file.
- **`specs/002-data-layer/{spec,plan,research,data-model}.md` are approved artefacts.** The config
  contract is your extension of it: amend by **extending**, never forking, and never edit slice 1's
  copy.
- **The mocked surface's semantics stay slice 1's.** Slice 2 adds origins and population, not new
  CRUD behaviour.
- **Do not start slices 3–7.** Import/export is slice 3; events and webhooks slice 4; actions slice
  5; hardening slice 6; conformance and examples slice 7. The behaviour layer is *parsed and
  validated* now and *consumed* later.

---

## 6. Finish: one pull request for the whole slice

`tasks.md` is a human checkpoint and it is **already generated and open as PR #1** — do not create it
again. The owner reviews and **resolves the D1–D10 decisions table at that checkpoint**; implement
against `tasks.md` only once it is approved.

1. **PR 1 — the task list only.** `specs/002-data-layer/tasks.md`, nothing else. Title
   `docs(slice-2): tasks.md for the data-layer slice`. **Wait for approval.** You may keep working in
   the worktree meanwhile if it is useful, but do not implement against an unapproved task list.
2. **PR 2 — the whole implementation, one PR for the slice** (see `tasks.md` → "Delivery"). Title
   `feat(slice-2): data layer — config layers, derivation, generation, determinism`. Body: the gate
   output, red-before-green per test task, the recorded `quickstart.md` run, and the two carried
   follow-ups (F-E, T043 seam) named as done.

   **This deviates from `CLAUDE.md` → "One phase per change", deliberately and for this slice only.**
   The rule exists to keep a reviewer *and a coordinator* in the loop between phases; here the slice
   is driven end to end by a single cloud agent (you) against a granted credit allocation, with **no
   second orchestrator** to review between phases. Splitting into 11 PRs would make you idle at each
   one waiting for a review nobody is staffing during the run — sacrificing throughput, not rigour.
   What replaces the per-phase gate: **self-review at every phase Checkpoint** (`tasks.md`: the
   phase's tests green **and** its `NC:` negative control **and** the `quickstart`-relevant scenario),
   fixed in-run before the next phase starts. `main` stays fully protected and **the whole-slice PR
   is reviewed and merged through the normal Kanban process afterwards**; you still merge nothing.

```bash
git push -u origin wt/slice-2-data-layer
gh pr create --base main --head wt/slice-2-data-layer --title ... --body ...
```

---

## 7. Evidence floor (this PR + the slice PR)

Paste **real output**, not a claim:

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build && node dist/cli/index.js --help
```

Plus, for the implementation PR:

- **Determinism proven**: generate twice from a wiped store with the same seed, export both, show the
  byte comparison (SC-002) — and show SC-007 (adding an unrelated collection does not perturb
  existing collections).
- **Fixture immutability proven** by byte comparison before and after generation and API activity
  (SC-003).
- **The recorded `quickstart.md` run** against a built `dist/`, step by step; any step that does not
  behave as written is a defect in the quickstart **or** the code — decide which and fix the right
  one.
- **The derivation run against the real vendor document** (opt-in), recording how much pinning it
  actually needs.
- Red-before-green per test task; for any test whose guarantee is statistical or structural (counts,
  memory, ordering) show the **negative control** — the mutation that makes it fail.

**Then stop and report.** Do not merge anything; a human/coordinator merges.

---

## 8. Known traps (already hit on slice 1 — do not rediscover them)

- **`npm test` after a cold `npm ci`** has once flaked (~165 s, one store test timing out,
  unreproduced 4×). If CI goes red only on a store-test timeout, re-run the job before treating it as
  a defect.
- **`npm run build` rewrites the committed generated files** (`src/config/schema.generated.ts`,
  `src/control/openapi.generated.ts`) via the `prebuild` → `generate` step. That is expected; it
  should produce **no diff**. A diff means the contract and the copy have drifted — which is exactly
  what the drift test exists to catch.
- **The control contract moved** from `contracts/control-api.openapi.yaml` to `.json` in the A3
  reconciliation. It is real JSON now, served byte-for-byte under its declared `application/json`.
