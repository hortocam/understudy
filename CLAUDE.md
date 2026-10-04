# CLAUDE.md — working in the understudy repository

Guidance for any coding agent (Claude Code, or otherwise) working in this repo. Humans: the same
rules apply; see `README.md` for the product and `docs/` for the handoff package.

## What this is

**understudy** — declarative, stateful mocking of third-party APIs and webhook events from an
OpenAPI 3.x document. A mock **derived from the spec** serves persistent, contract-valid CRUD for the
operations you select, so an integration team can build against a faithful stand-in while the real
service is unavailable. TypeScript on Node 22, ES modules, Fastify, Ajv, SQLite (`better-sqlite3`),
vitest, eslint, MIT.

## Read these before your first change

1. **`.specify/memory/constitution.md`** — the governing document. Its ten principles are the
   acceptance bar, not decoration. Where anything conflicts with it, the constitution wins.
2. The feature you are building: **`specs/<NNN>-<feature>/{spec,plan,tasks}.md`**. The feature is
   driven spec-first; the spec is the source of truth, and **code is written to match the spec — the
   spec is never edited to match the code.**
3. **`docs/`** — the handoff package the specs were derived from, including `docs/05-target-apis.md`
   (the *measured* facts about the two real vendor APIs, which several requirements hang on).

## The non-negotiables

- **Spec-first.** No implementation code for a feature until its `spec.md`, `plan.md` and `tasks.md`
  exist. The spec and the plan are **human checkpoints** — do not edit an approved spec unilaterally.
- **TDD (constitution VII).** A failing test exists before the code that passes it. Red → green →
  refactor. Test and implementation land in the **same** change. The engine's inference, precedence
  and generators carry **golden-file** tests.
- **One phase per change.** `tasks.md` is organised into sequential phases; work one phase, with the
  exact task IDs in scope, and nothing from a later phase.
- **Branch per task.** `wt/<description>` (agent work) or `NNN-feature-name` (Spec Kit feature
  numbering), always off up-to-date `main`. **Never commit or push to `main`** and never force-push.
- **Independent review.** The reviewer is a **different model lineage** than the author, and opens
  the pull request only when a Spec Kit converge comes back clean. Authors and reviewers never merge.
- **The coordinator is the only merge authority.** Every change reaches `main` as a merged PR.
- **Evidence over summary.** "Done" means verified against the remote: the branch pushed, a real PR
  open, CI green. A local pass is not evidence; the check on the PR is.
- **No secrets in the repository or in config files.** Secrets come from the environment. No outbound
  network calls except a spec the user supplied by URL and explicitly configured webhook targets /
  import sources.

## Commands

```bash
npm ci                # install (Node 22+)
npm run lint          # eslint
npm run typecheck     # tsc --noEmit
npm run test          # vitest run
npm run build         # tsc -p tsconfig.build.json (runs `generate` first)
node dist/cli/index.js --help    # the `ustdy` CLI after a build
```

## Layout

```
.specify/      Spec Kit engine, templates, and memory/constitution.md (authoritative)
specs/         one directory per feature: spec.md, plan.md, tasks.md, contracts/, quickstart.md
docs/          the handoff package (product spec, architecture, config reference, phasing, target APIs)
src/           implementation — spec/ config/ mock/ control/ store/ cli/
tests/         unit/ integration/ contract/ fixtures/
```

## Style

Match the surrounding code. Small, documented config surface — **every config key ships with
documentation and a runnable example in the same change** (constitution IX). Inference is always
reported and pinnable; silent guessing is a defect. Determinism is the default: the same spec,
config, seed and fixtures must reproduce the same state byte-for-byte.
