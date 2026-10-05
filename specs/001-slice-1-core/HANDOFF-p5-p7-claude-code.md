# Hand-off — Slice 1 Phases 5, 6 and 7 (the CLI, the report, and polish)

**Audience**: a Claude Code cloud session (or any coding agent) picked up to finish slice 1 of
**understudy** by driving this file plus the spec triplet directly — *not* by working from the Kanban
board.

**Feature**: `specs/001-slice-1-core/` — `spec.md`, `plan.md`, `tasks.md`, `data-model.md`,
`quickstart.md`, `contracts/`.
**Governing document**: `.specify/memory/constitution.md` (v1.0.0). Where anything here disagrees with
it, the constitution wins.
**Repo rules for an agent**: `CLAUDE.md` (read it first — it is short and it is binding).

---

## 0. What is already merged (verified against the remote, not claimed)

Do **not** redo any of this. Everything below is on `main` (head `fa42e64` at the time of writing),
verified by an independent run of the full gate on a fresh extraction of each merge commit.

| Phase | Tasks | PR | Merge commit | State |
|---|---|---|---|---|
| 1 + 2 Setup & shared spine | T001–T017 | #3 | `6916510` | merged, 47/47 green |
| 3 CRUD engine, routes, validation (MVP) | T018–T027 | #7 | `fbb8466` | merged |
| 4 Control plane | T028–T033 | #9 | `fa42e64` | merged, 99/99 green |

Amendments in force (both merged, both binding — see the tail of `tasks.md`):

- **A1** — the not-implemented answer is the exported constant `NOT_IMPLEMENTED = 501`
  (`src/mock/errors.ts`) with a `NotImplementedBody` schema
  (`contracts/mock-errors.schema.yaml`). Assert against the constant, never a bare `501`.
- **A2** — FR-002's two selector forms (`METHOD /path` and `operationId`) are **peers, no precedence**;
  FR-023 requires the startup report to name which form resolved each live operation on a mixed
  selection. **This is delivered** (`src/spec/operations.ts` records a `form` per entry,
  `src/spec/report.ts` + `src/logging.ts` render it) — no work needed here.

**Tasks.md checkbox note.** T001–T033 are ticked as `[X]` in `tasks.md` to match the merged reality.
Phase 5 (T034–T037) and most of Phase 7 (T041–T045) are genuinely unstarted and stay unchecked.

**Where the current build stands.** `main` serves: spec load + dereference, operation selection
(both forms), resource/FK derivation, the startup report, validation, generic CRUD with both update
styles, declared-error rendering, cursor + offset paging, the `NOT_IMPLEMENTED` path, and a full
control plane (health, reset, operations, requests, openapi.json, teardown) with a byte-pinned
contract. **The one conspicuous hole is the CLI**: `src/cli/index.ts` is still the Phase-1+2
placeholder — `ustdy` presents itself and does nothing else.

---

## 1. How to work here (the non-negotiables, abbreviated)

These are the constitution's, restated because violating them is the failure mode this repo is built
to prevent:

1. **Spec-first.** Code is written to match `spec.md`; the spec is never edited to match code. If a
   requirement is genuinely wrong, stop and surface it — do not silently diverge.
2. **TDD (principle VII).** A failing test exists *before* the code that passes it. Show it red, then
   green. Test and implementation land in the **same** change.
3. **One phase per change.** Work one phase from `tasks.md`, with its exact task IDs, and nothing from
   a later phase. Do not opportunistically refactor across the boundary.
4. **Branch per task.** `wt/<description>` off up-to-date `main`. **Never commit or push to `main`**,
   never force-push. Open a pull request.
5. **Evidence over summary.** "Done" means the commands were actually run and their real output shown,
   not that they would pass. A local pass is not evidence if CI could disagree — run the gate.
6. **Report inference; never guess silently (principle VI).** Anything inferred or defaulted must be
   visible in the startup report and pinnable in config.
7. **Determinism (principle III).** Same spec + config ⇒ same behaviour. Anything nondeterministic
   (identity allocation, timestamps) is confined to a named seam.

Gate commands (all four must be green before every hand-back):

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build && node dist/cli/index.js --help
```

---

## 2. Phase 5 — the same control from the command line (T034–T037)

**Goal.** `ustdy`, a client of the control plane with **no logic of its own**. Everything it offers is
already available over HTTP from Phase 4; the CLI adds ergonomics, not capability.

**The contract is written already** — `contracts/cli.md`. Implement exactly that table:

| Command | Control call | Renders |
|---|---|---|
| `ustdy up [--config <path>] [--port <n>] [--control-port <n>] [--control-url <url>]` | `GET /health`, polled until ready | the startup report, then a ready line |
| `ustdy down [--control-url <url>]` | `POST /teardown` | success once the port is released |
| `ustdy ops list` | `GET /operations` | live and not-implemented operations |
| `ustdy reset [--to <mode>] [--entity <name>]…` | `POST /reset` | rows removed per entity |
| `ustdy logs requests [--method] [--status] [--live] [--limit <n>]` | `GET /requests` | the request log, newest first |

- **T034** — `tests/integration/cli.test.ts`. Each command's output agrees with the corresponding
  control-API response; `ops list` mirrors `/operations`; `reset --to wipe` mirrors `POST /reset`;
  `down` mirrors `/teardown`; **and with the control plane stopped, every command exits non-zero with
  a clear connection error** (SC-005, FR-019/FR-020). Fails first.
- **T035** — `src/cli/client.ts`, a thin HTTP client for the five control operations. Base URL from
  `--control-url` / env, defaulting to the composed `http://<control.host>:<control.port|server.port><control.prefix>`.
  A clear connection-failure message; **no fallback that reads the store or does the work locally** —
  that fallback is precisely what would make the CLI a second implementation (constitution II).
- **T036** — `src/cli/index.ts` with commander: `up`, `down`, `ops list`, `reset`, `logs requests`,
  each formatting a control response and nothing more.
- **T037** — `up`'s **one** non-client act: construct the server from the config and poll `/health`
  until ready. Every other command stays purely a client (FR-019).

**The trap to avoid.** The single biggest way to fail this phase is to let the CLI reach into
`src/mock/`, `src/store/` or `src/spec/`. `tests/unit/architecture.test.ts` (FR-019's machine-checked
half) will fail if you do — but it does not yet catch backtick/computed dynamic imports (see
"Carry-forward", item 6). Keep `up`'s engine use in the **library entry** (`createMock` in
`src/index.ts`), not in `src/cli/`.

**Evidence floor.** Red-before-green per test task; the live full command output for each of the five
commands (paste it); the control-plane-down case for each command; and `npm run build && node
dist/cli/index.js --help`.

**Library surface already available to `up`:** `createMock(config, options)` from `src/index.ts`
returns `{ baseUrl, port, report, store, controlUrl, controlPrefix, closed, close() }` — `up` needs
`createMock`, then poll `controlUrl + "/health"`.

---

## 3. Phase 6 — startup tells me what it understood (T038–T040)

**Goal.** The report as a first-class deliverable rather than debug output.

**Much of this is already built** and must not be rebuilt — `src/logging.ts` has
`renderStartupReport` (human-readable) and `createLogger` (JSON-line), and `src/index.ts` already
emits both from the same `StartupReport` object, and already refuses to start with `renderRefusal` on
any taxonomy error. What is missing is the **dedicated tests** that lock that behaviour in:

- **T038** — `tests/unit/report.test.ts`. Given a derived model, the report contains every resource,
  every relationship **with its `evidence`**, and every ambiguity; and a `convention`-sourced link is
  rendered **differently** from a `configured` one (SC-006, FR-023). Fails first. (This test does not
  exist today — the report is only exercised indirectly through integration tests.)
- **T039** — verify both renderings come from one source (the human text and the single structured log
  line), asserted in T038. Extend rather than duplicate.
- **T040** — refusal paths: prove **each** T004 error produces a human-readable, cause-naming message
  and a non-zero exit. The taxonomy is in `src/errors.ts`; drive each one — an unreadable document, an
  unresolvable `$ref`, an empty selection, an unknown operation, an invalid config, an unwritable
  store, a port in use — and paste the message each produces.

**Evidence floor.** Red-before-green for T038; the rendered report for a fixture whose conventions
imply some relationships and hide others; and the seven refusal messages.

---

## 4. Phase 7 — Polish & cross-cutting (T041–T045)

- **T041** — `tests/integration/isolation.test.ts`: two instances, distinct ports and store files,
  **no shared state and no cross-talk** (SC-007).
- **T042** — prove **no outbound traffic** beyond a URL-supplied spec (SC-008, FR-022): run the full
  lifecycle against a *file* spec and assert no outbound connection is made.
- **T043** — large-collection test: seed one collection past the page size, list it paged, and assert
  memory does not scale with the collection (the paged read must not load the collection into memory).
- **T044** — documentation: `README.md` must reflect the **shipped** CLI surface and config keys; each
  config key has an example (constitution IX). ⚠ The README's *Status* section still says
  "**Planning.**" and describes a repo with no implementation — that is now false and must be
  corrected as part of this task.
- **T045** — run `quickstart.md` **end to end against a built `dist/`** and record the output as the
  feature's acceptance evidence. Any step that does not behave as written is a defect in the
  quickstart **or** the code — decide which, and fix the right one. Two known quickstart defects to
  fix while you are in there (see Carry-forward items 3 and 5): the reset example's missing
  `content-type` header, and the isolation example's missing header.

---

## 5. Carry-forward follow-ups

Raised during the pre-merge triage of Phases 3 and 4. Each is real; none blocks Phase 5, but items 3
and 5 land in files Phase 7 touches anyway, so fold them in.

1. **`control.port` / `control.host` separate-listener path is untested.** `src/index.ts` mounts the
   control plane on its own listener when `control.port` is set (T031), but
   `tests/integration/control.test.ts` only exercises the same-port hijack. Add a test that starts the
   mock with a distinct `control.port`, asserts the control plane answers there, that the mocked
   surface does **not** expose the prefix on `server.port`, and that teardown frees both ports.
2. **`GET /health`'s `store.reachable: false` branch is untested.** Only the `true` branch is asserted.
   Add a test driving the unreachable shape (not a 500).
3. **`quickstart.md` §7's reset example sends an unparseable body.** `curl -s -X POST …/reset -d
   '{"mode":"wipe"}'` sends `application/x-www-form-urlencoded`; the control contract declares
   `application/json`, so this does **not** reset — it hits a `415`→`malformed_request` `ControlError`.
   Fix by adding `-H 'content-type: application/json'` and sweep the file for the same pattern.
4. **Unscoped `wipe` skips underscore-named resource tables.** `Store.#resourceTables()` excludes the
   tool's own metadata tables by a `'\_%'` LIKE, so a resource derived from a path segment beginning
   with `_` (e.g. `/__admin`) is silently skipped by the **unscoped** wipe, and its `removed` report
   does not even name the entity — silent non-removal, exactly what SC-002 forbids. Prefer tracking the
   tool's own table names explicitly over the prefix filter. Red-before-green test with a
   `_`-prefixed collection.
5. **`quickstart.md` §9's isolation example is missing the same header** (`-d '{"sku":"A",…}'` on a POST
   to `/inventory`). Same fix.
6. **The FR-019 boundary gate misses backtick/computed dynamic imports.** `tests/unit/architecture.test.ts`
   catches static/named/side-effect/`export … from`/`import type`/double-quoted `import("…")` but
   **not** `` import(`../store/index.js`) `` nor `import(p)`. Widen the extractor to backtick literals
   and add an eslint `no-restricted-syntax` rule forbidding `ImportExpression` with a non-literal
   argument under `src/cli/`. This matters more once Phase 5 puts real code in `src/cli/`.
7. **F-E — `src/spec/identity.ts` mishandles open quantifiers.** It maps `+`, `*`, `{n,}` to exactly
   one unit, so `^W-[0-9]+$` allocates `W-0…W-9` and then 500s on `UNIQUE` at create #11 with
   `ambiguities: []`. Either generate a value satisfying the bound, or report the
   `identity-pattern-unsupported` ambiguity and fall back — never a conforming-then-colliding counter.
   (Deferred from Phase 3; `tests/unit/identity.test.ts` exists to extend.)
8. **`_requests.live` is under-specified** for a *selected but unbound* operation (a T050 case): it is
   selected (→1) *and* answered 501 (→0). The code records `0` (behavioural reading). Not a code bug —
   the `data-model.md` §2 comment needs to say which clause wins. Documentation change.

---

## 6. Fences — what you must NOT touch

- **`specs/001-slice-1-core/contracts/config.schema.yaml`** — an artefact the human approved. It has a
  known defect (the `operations` item pattern rejects a hyphen/dotted `operationId`, and the
  `signing`/`clock` descriptions contradict the implemented refuse-on-presence behaviour), recorded as
  open task **T048**. It is routed to the coordinator for a human checkpoint. **Do not edit it, and do
  not work around it.** Same for `contracts/control-api.openapi.yaml` if you find the
  `/openapi.json` content-type issue (it declares `application/json` while serving YAML bytes — a
  recorded contract amendment, not yours to fix).
- **The approved spec triplet** (`spec.md`, `plan.md`). `tasks.md` is append-only for records.
- **No per-endpoint handlers.** The whole slice is one code path driven by the derived model; SC-001
  and the constitution's "Prohibited" list forbid hand-written per-endpoint handlers for standard CRUD.
- **No secrets in the repo or in config files.** Secrets come from the environment.

---

## 7. Working notes for a Claude Code session

- **The repo is Spec Kit-scaffolded**, but with the **`hermes`** integration (see
  `.specify/init-options.json`) — the `/speckit.*` slash commands are *not* installed as
  `.claude/commands/` here, and `.specify/commands/` does not exist. Do not run `specify init` — it
  would re-scaffold and risk dropping exec bits and `.specify/` state. **For these phases the specs
  already exist**: implement T034–T045 directly against `tasks.md` + `plan.md` + the constitution,
  following TDD. The Spec Kit engine in the tree (`.specify/scripts/bash/`, `.specify/templates/`) is
  there if you need it, not as a precondition.
- `.specify/feature.json` is **gitignored per-checkout state** and will be absent in a fresh cloud
  clone. If a Spec Kit script needs it, prime it once from the repo root:
  ```bash
  SPECIFY_FEATURE_DIRECTORY=specs/001-slice-1-core bash .specify/scripts/bash/check-prerequisites.sh --json --require-tasks --include-tasks
  ```
  Do **not** commit it.
- Node 22. `npm ci` first — a green suite in a checkout whose `node_modules` predates a dependency
  change proves nothing.
- A transient **cold-CI flake** was seen once (first `npm test` after a cold `npm ci`, ~165 s, one
  store test timing out, unreproduced 4×). If CI goes red only on a store test timeout, re-run the job
  before treating it as a defect.

---

## 8. Definition of done, and how to hand back

One **pull request per phase** (Phase 5, then 6, then 7) against `main`, each containing:

- the failing test(s) shown red, then the passing run shown green;
- the full gate green (`npm ci`, `lint`, `typecheck`, `test`, `build` + `--help`);
- the phase's exact task IDs named, and **nothing from a later phase**;
- the carry-forward items you folded in, named explicitly.

Slice 1 is complete when `quickstart.md` runs end to end against a built `dist/` (T045) with its
recorded output as the acceptance evidence, and SC-001 through SC-008 all hold.
