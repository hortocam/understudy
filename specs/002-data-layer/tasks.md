# Tasks: Slice 2 — Data Layer I: Configuration and Generation

**Input**: Design documents from `specs/002-data-layer/`

**Prerequisites**: `plan.md`, `spec.md` (amended 2026-10-04, A1), `research.md`, `data-model.md`,
`contracts/config.schema.yaml`, `quickstart.md`; slice 1 merged (`specs/001-slice-1-core/`).

**Tests**: Included and mandatory (constitution VII). Every implementation task is preceded by the
test task that defines it. **Red means a failing real assertion** — `Cannot find module` and
`is not a function` prove nothing; where a module does not exist yet, the test task lands a
minimal typed stub that returns the wrong answer so the assertion, not the import, is what fails,
and that stub is replaced by the implementation task. Test and implementation land in the same
change. **Delivery for this slice is one PR (see "Delivery" below), not one per phase.**

**Organization**: sequential, independently testable **phases**; within a phase, tests first.
User-story tags (`[US1]`…`[US7]`) name the story from `spec.md` a task serves; `[FND]` marks
foundational work no single story owns.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: the `spec.md` user story it serves (or `[FND]`)
- **Golden** = a checked-in expected-output file under `tests/fixtures/golden/`, compared
  byte-for-byte; the three families constitution VII names are **precedence**, **inference**
  and **generators**.
- **Negative control** = the mutation that must make a statistical/structural test fail, run once
  and recorded in the PR (`NC:` lines below say which).

## Decisions this task list takes (resolved at the checkpoint)

These are gaps or tensions found while decomposing the approved artefacts. None edits the spec;
each states the reading the tasks follow. **All ten were reviewed by the owner at the checkpoint and
are now confirmed or resolved** — the readings below are the decisions of record. D2 is the one that
changes slice-1 behaviour in a *new* way: it is resolved in favour of API writes being mutations,
with the FR-002/SC-003 wording corrected in slice 2 (spec-first) rather than deferred.

| # | Finding | Decision of record |
|---|---|---|
| D1 | **A tag selector does not exist in slice 1.** FR-002 says fixtures select "against the same grammar the core slice delivers … `METHOD /path`, `operationId` and a tag", but `src/spec/operations.ts` implements two forms and slice 1's A2 amendment explicitly deferred tags. The config contract (002) already describes tag entries. | Slice 2 **implements** the tag selector (T016/T017) as a third peer form, with the space-normalisation rule in FR-002. Slice 1's *spec* stays untouched; only `src/spec/operations.ts` changes. |
| D2 | **FR-002 "MUST NEVER be modified by … activity over the mocked API" vs. "the mocked surface's semantics stay slice 1's".** A `PATCH`/`PUT`/`DELETE` addressed to a *static-origin* record would modify a fixture row, and refusing it is new CRUD behaviour the slice boundary forbids. US1.3, quickstart §2 and SC-003 only exercise *creates*. | **Resolved at the checkpoint: writes to a fixture are mutations, and slice 2 owns closing the gap — no deferral.** A `PATCH`/`PUT`/`DELETE` addressed to a static-origin row **does** mutate it (slice 1's semantics stand), which makes FR-002/SC-003's literal "MUST NEVER be modified by activity over the mocked API" false in that path. Rather than carry the discordance to a later slice, slice 2 **narrows SC-003 to what is provable without new CRUD semantics**: the fixture **files** are never rewritten, fixture rows are applied identically on every start, and `static` rows are byte-identical across generation, reads, lists and `wipe`. T043 proves exactly that and drops the `OPEN-D2` placeholder. **Two doc follow-ups land with T043 (spec-first: the spec is corrected to match the code, never the reverse):** (a) `spec.md` FR-002/SC-003 are amended to scope the immutability guarantee to the layers that own the rows, with the API-write path named explicitly; (b) an **A4 amendment** records this decision and its *Why* (constitution Governance) so the reasoning travels, and so a slice-1↔2 discordance is not left as a silent contradiction. |
| D3 | **Plan vs data-model disagree on where the identity range lives.** `plan.md`/`research.md` §4: "metadata key `id_seq:<resource>`"; `data-model.md` §3: "promoted to a table `_id_ranges`". | Both, with different jobs: `id_seq:<resource>` stays the **runtime** counter (slice 1, unchanged, rewound by wipe); `_id_ranges` records the **reserved span, its space and the allocation cursor** for generation. T022 adds the table; the meta key is not renamed again. |
| D4 | **The control API has a contract file (slice 1's, frozen) and FR-021 adds an operation.** The plan names `control/routes.ts` EXTENDED but no `contracts/control-api.*`. The served document is drift-tested byte-for-byte against the checked-in file. | Same treatment as the config contract (plan "Known integration point"): a slice-2 **extension** `specs/002-data-layer/contracts/control-api.openapi.json` (slice 1's file kept as history, never edited), and the generator and drift test repointed (T005/T006). Likewise `contracts/cli.md` is extended at `specs/002-data-layer/contracts/cli.md` for `init`, `generate`, `--recipe`, `--seed`. |
| D5 | **Store seam.** The brief says `Store` is consumed "unchanged"; slice 2 needs transactional bulk insert, FK/indexes at table creation and counts-by-origin. | **Additive only** (principle X): new optional-by-use methods and an options argument to `ensureResource`; no existing method changes signature or meaning (T021–T028). Slice 1's store tests stay green untouched. |
| D6 | **`quickstart.md` assumes commands that do not exist yet** (`ustdy reset --to baseline`, `ustdy export`). Slice 1 has one reset mode, `wipe`; export is slice 3. | Quickstart's own parenthetical already routes the export comparison to `tests/integration/determinism.test.ts`. The recorded run (T088) uses `reset --to wipe`, and any step that cannot behave as written is called out and fixed in the **quickstart or the code**, and the PR says which. |
| D7 | **Generation on a non-empty store.** Not specified. | **Confirmed at the checkpoint.** `up --recipe` generates when the store holds **no generated rows**; when a generation marker (`recipe`, `seed`, `config_hash` in `_understudy_meta`) **matches**, it does not regenerate and reports that; when it **differs**, it refuses naming the mismatch and the `reset` remedy. No silent regeneration (VI), no silent skip. The deliberate cost — editing a recipe and re-running `up` refuses until `reset --to wipe` — is accepted; no `--regenerate` flag is invented (small, documented config surface, IX). |
| D8 | **Time.** Real clock is the default (spec Assumptions), yet SC-002 demands byte-identical exports. | The clock is read **once per run**. Determinism tests pin `clock.start`. An unpinned real clock is **reported** (`clock-unpinned` ambiguity: time-derived values vary between runs) — never silent (FR-019). |
| D9 | **Seed absent** everywhere. | Global seed defaults to `0`, stated in the report. Determinism is the default; there is no hidden entropy. **The contract must state it in the same change (constitution IX): add `"default": 0` to the `seed` key in `specs/002-data-layer/contracts/config.schema.yaml`.** |
| D10 | **Lookup tables that are not collections.** `static/lookups/*.yaml` names an `entity`; it may or may not be a live collection. | A lookup whose `entity` is a derived collection is **stored** (`origin=static`, served like any record). Otherwise it is an **in-memory named table** (reported as `lookup-only`) addressable by `lookup:` rules. Either way a `lookup` draw yields a row that exists in the table. A **fixture** `entity` that is neither a collection nor a lookup refuses naming the key (FR-005). |

## Delivery: one PR for the whole slice (an explicit, recorded deviation)

The repo rule `CLAUDE.md` → "One phase per change" (and constitution "Development Workflow") exists
to keep a **reviewer and a coordinator in the loop between phases**. That machinery is deliberately
absent here: this whole slice is driven by a single **cloud agent (Claude Code)** burning a granted
credit allocation, with **no second orchestrator** and no coordinator watching between phases. The
distinction is not between *reviewing* and *merging*:

- **`main` stays fully protected.** One PR for the slice, and the **only** path to `main` remains a
  merged PR with a 1-approving-review and a green `test` check. The slice PR is reviewed and merged
  through the normal **Kanban** process after the run, exactly as a per-phase PR would be.
- **Reviewer/CI latency vs. cloud-agent throughput.** If we split this into 11 phase PRs, the repo
  rule would require CC to **stop and wait** at each one for a review that nobody is staffing during
  the run. That idles the exact resource the run exists to consume — it is *throughput*, not rigour,
  that is sacrificed. (A per-phase PR whose `test` check is the only gate, self-merged, would not be
  review either; it would just be 11 rubber stamps with extra CI cycles.)
- **What replaces the per-phase gate inside the run: self-review at every phase checkpoint.** Each
  phase's **Checkpoint** line is a hard stop for CC: the phase's tests green **and** its `NC:`
  negative control run **and** the `quickstart`-relevant scenario exercised, before the next phase
  starts. A red phase is fixed in-run. `tasks.md` stays ordered so this is mechanical.
- **The human checkpoint stays the one gate the run cannot pass on its own:** this task list is
  approved before implementation starts, and the run does not merge anything.

Recorded as a deviation (§"Development Workflow") for the same reason it is recorded here: the
reasoning should travel with the decision, and the Kanban pass afterwards is where it is validated
against the remote.

## Phase 1: Setup

**Purpose**: dependencies, the architecture guard for the new module boundary, and the two
repoints the plan names as required.

- [X] T001 Add `@faker-js/faker` `^9` and `jsonata` `^2` to `package.json`, `npm ci`, and verify
      `npm audit` reports no new advisories and that both import under Node 22 ESM with
      `NodeNext` resolution (a one-line smoke assertion in `tests/toolchain.test.ts`).
- [X] T002 [P] [FND] Extend `tests/unit/architecture.test.ts` with the new boundaries: `src/spec/`
      MUST NOT import `src/data/` (plan Structure Decision — derivation stays testable without a
      store); `src/cli/` MUST NOT import `src/data/`, `src/spec/`, `src/store/`, `src/mock/`;
      `src/data/` MUST NOT import `src/cli/`, `src/mock/`, `src/control/`; **no source file reads
      `process.env`** (secrets come from the environment, never the library — assert the grep
      finds nothing). **Negative control**: the checker is exercised against a synthetic
      violating source string and must flag it, so a green run cannot mean "the scanner is
      blind".
- [X] T003 [P] [FND] Test for the **clock seam** in `tests/unit/clock.test.ts`: the real clock
      reports `mode: "real"`; with `clock.start` it returns that exact instant and **never
      advances during a run**; without it, `now()` is read once per `startRun()` and every later
      read in that run returns the same instant; `mode: "virtual"` is refused naming the mode.
      Fails first (stub returns `Date.now()` per call).
- [X] T004 [FND] Implement `src/clock.ts`: `interface Clock { readonly mode: "real" | "virtual";
      now(): Date }`, `createClock(config)`, a run-scoped `freeze()`; the real implementation
      only. Wire `config.clock` through `src/config/load.ts` — `clock.mode: real` and
      `clock.start` become *accepted keys* (slice 1 refuses `clock` on presence; `virtual` and
      `signing`/`postgres` still refuse, naming the key). Update `tests/unit/config.test.ts`
      expectations that asserted the old blanket `clock` refusal **in the same change**.
- [X] T005 [FND] **Contract repoint — config.** Test first: change the drift test in
      `tests/unit/config.test.ts` to read
      `specs/002-data-layer/contracts/config.schema.yaml` and assert
      `src/config/schema.generated.ts` equals it — **red** because the generated copy still
      derives from slice 1's file (descriptions and the whole `entities` block differ). Then
      repoint `scripts/generate-config-schema.mjs` (path **and** header comment), regenerate, and
      assert in the same test that slice 1's contract file is **unchanged** (`git diff --quiet
      origin/main -- specs/001-slice-1-core`). Slice 1's file is history: not deleted, not
      edited.
- [X] T006 [FND] **Contract repoint — control API (D4).** Create
      `specs/002-data-layer/contracts/control-api.openapi.json` as a byte-for-byte copy of slice
      1's plus the FR-021 `POST /generate` operation and its schemas
      (`GenerateRequest {recipe?, seed?}`, `GenerateResult {recipe, seed, clockMode, created:
      {collection: {origin: count}}, provenance, refusals}`, a declared 4xx `ControlError`).
      Test first: the drift test in `tests/integration/control.test.ts` points at the new file
      and asserts the served document equals it byte-for-byte (red: the generator still emits
      slice 1's); then repoint `scripts/generate-control-openapi.mjs`. Slice 1's file is
      untouched. The route handler itself is T080.

**Checkpoint**: toolchain green with both new dependencies; the build derives from slice 2's
contracts; the boundary guard exists and is proven able to fail.

---

## Phase 2: Foundational — the configuration surface (the four layers)

**Purpose**: everything is configuration first (FR-001, FR-005). Nothing generates yet.

**⚠️ CRITICAL**: no later phase begins until this phase is complete.

- [ ] T007 [P] [FND] Extend the error taxonomy tests in `tests/unit/errors.test.ts` (each message
      contains the offending value, and **names the file and key**): `ConfigLayerInvalidError`
      (layer, file, key), `ConfigReferenceError` (unknown collection/field), `ConfigContradictsSpecError`,
      `IdentityRangeOverlapError` (collection), `InvariantViolatedError` (collection, rule,
      budget), `UnknownGeneratorError`, `RecipeNotFoundError`, `GenerationMarkerMismatchError` (D7),
      `FixtureConformanceError`. A relationship cycle is deliberately **not** an error class
      (FR-008: reported, never refused). Fails first.
- [ ] T008 [FND] Implement the T007 errors in `src/errors.ts` and extend `renderRefusal` so each
      renders `file: key — cause` (the same message shape for every layer, FR-005, Scenario 7).
- [ ] T009 [P] [FND] **Extend the contract** `specs/002-data-layer/contracts/config.schema.yaml`
      with `$defs` for the four layer files, each with a documented example (constitution IX),
      *extending* the file, never forking it: `LookupFile` and `EntitiesFile` (docs/03 formats),
      `Recipe` (`seed`, `count`, `perParent {entity, range[2], distribution: uniform|zipf}`,
      `fields` → `FieldRule`, `constraints[]`, `redraws` (default 50, the FR-013 budget),
      `source: import` reserved), `FieldRule` as a `oneOf` of `generator | faker (+args) | lookup
      (+weights, by, value) | ref (<Collection>.<field>) | seq | choice | expr`, `generators`
      (custom, FR-012: `choice` or `plugin` file reference), `ImportMapping` (shape only), and
      the behaviour documents (`targets`, `subscriptions`, `actions`, `reactions`,
      `simulations`) per docs/03. State in the schema descriptions: how `ids.reserved` is spelled
      (`"<from>..<to>"`, inclusive, interpreted in the collection's identity space — integer
      span, the numeric run of a formatted pattern, or a leading hex span for uuid), the
      weights-key default for `lookup` (the row's `code`, else its identity), and that **secrets
      never appear** (`${VAR:-default}` strings are validated as text, not expanded).
      Test first (T010).
- [ ] T010 [P] [FND] Contract tests in `tests/unit/config-layers.test.ts`: **every docs/03
      worked example validates** (venues, inventory-statuses, ci-small recipe, webhooks,
      actions, simulations, events mapping), and each of: an unknown key, a wrong type, a
      `FieldRule` with two rule kinds, a non-enum `distribution`, a `range` of the wrong arity is
      **refused naming the key**. Fails first against the un-extended contract. Written
      *before* T009 lands (red), checked after.
- [ ] T011 [FND] Regenerate `src/config/schema.generated.ts` from T009 and add compiled
      per-`$def` Ajv validators in `src/config/schema.ts` (one compile each, cached) so every
      layer module validates against the **same** contract.
- [ ] T012 [P] [US1] Test for the **fixtures layer** in `tests/unit/layers-fixtures.test.ts`:
      lookups and entity files parse; a missing `static/` folder (and missing `lookups/` or
      `entities/` alone) is **not an error**; a malformed row refuses naming file and key; two
      files declaring the same `(entity, id)` refuse naming both; a row without the entity's
      identity field refuses; YAML and JSON are both accepted. Fails first.
- [ ] T013 [US1] Implement `src/config/layers/fixtures.ts`: load, validate, normalise to
      `FixtureSet { lookups, entities }` in a **stable order** (files by name, rows by file
      order). Pure — no store, no document.
- [ ] T014 [P] [US2] Test for the **recipes layer** in `tests/unit/layers-recipes.test.ts`:
      `dynamic/<name>.yaml` ↔ recipe `<name>`; selecting by `recipe:` and by `--recipe`
      (CLI wins); an unknown recipe refuses naming it and listing the available names; two files
      with the same stem and different extensions refuse; a recipe's `seed` overrides the global
      seed; **JSONata expressions parse at load** (a syntax error refuses naming the
      field); `expr` dependency edges are extracted and a cycle among `expr` fields refuses
      naming both fields. Fails first.
- [ ] T015 [US2] Implement `src/config/layers/recipes.ts` (load, select, validate, expression
      parse + dependency extraction via the JSONata AST). Pure.
- [ ] T016 [P] [US1] Test for the **tag selector** (D1, FR-002) in
      `tests/unit/operations-tags.test.ts` against a new fixture
      `tests/fixtures/tags-api.yaml` (**no `operationId` anywhere**, a tag `Market Orders`, a
      tag `Invoices`): a tag selects every operation carrying it; `Market_Orders` and the raw
      `Market Orders` both select the same set; an ambiguous collapse (`Market Orders` and
      `Market_Orders` both declared tags) is refused **naming both**; a tag that is also a valid
      `operationId` spelling is not a precedence question — the three forms are **peers** and an
      entry matching more than one form refuses as ambiguous naming the forms; an unknown entry
      is still refused by name; the report's `selection.resolved[].form` gains `tag`. Fails
      first. (Anchored to the measured fact: 0/224 operationIds on the target.)
- [ ] T017 [US1] Implement the tag form in `src/spec/operations.ts` / `src/spec/types.ts`
      (`SelectorForm` += `"tag"`), and update the startup-report rendering for the third form.
      Slice 1's tests stay green untouched.
- [ ] T018 [P] [FND] Test for the **behaviour layer** in `tests/unit/layers-behavior.test.ts`
      (spec boundary: parsed and validated, **not acted on**): docs/03's four behaviour files
      validate; an unknown key in `behavior/webhooks.yaml` refuses with the **same message shape**
      as a bad `understudy.yaml` key (Scenario 7); a `when`/`template`/`where` JSONata string
      that does not parse refuses; **`${USTDY_WEBHOOK_POS_URL:-…}` is left as text** — assert no
      environment read and no socket opened (reuse `tests/helpers/outbound.ts`). Fails first.
- [ ] T019 [FND] Implement `src/config/layers/behavior.ts` (load + validate + JSONata syntax
      check; returns an inert `BehaviorSet` that nothing in slice 2 consumes) and the
      **imports** shape validator `src/config/layers/imports.ts` (`imports/*.mapping.yaml`
      shape only; nothing reads the data files).
- [ ] T020 [P] [FND] Test for **reconciliation against the document** (FR-005, constitution I)
      in `tests/unit/reconcile.test.ts`: `entities.<X>` naming no derived collection, a
      `relations` field that is not a property of the collection, a `relations.to` naming a
      missing collection/field, an `idField` that is not a property, a `ref:`/`lookup:` naming a
      nonexistent table, a field rule on a property the schema does not declare, a recipe
      `perParent.entity` that is not a collection, a fixture row whose body **does not conform to
      the document's schema** (type, enum, format, range — FR-014), a fixture `entity` that is
      neither collection nor lookup (D10), and `ids.generatedStart` at or below an existing fixture
      identity — each refuses **naming file and key**. Fails first.
- [ ] T021 [FND] Implement `src/config/reconcile.ts`: validate the loaded layers against the
      derived model and document, collecting **every** refusal before failing (one run, all
      causes, FR-005), and wire it plus the layer loaders into `createMock` before the store is
      opened (`src/index.ts`) and `--recipe`/`--seed` into `src/cli/program.ts` as options of
      `up` only (a client of nothing — `up`'s existing construct-the-server act).

**Checkpoint**: a project directory with any subset of the four layers loads, validates and
refuses with one message shape; no data has been written. `tests/unit` green.

---

## Phase 3: Foundational — store seams (additive, D5)

**Purpose**: the slice-1 deferrals data-model.md §3 names, added without changing a single
existing `Store` method.

- [ ] T022 [P] [FND] Tests for the stored model in `tests/unit/store-slice2.test.ts` against a
      real temp SQLite file: `_id_ranges` exists with the data-model columns; it is in
      `META_TABLES` **by exact name** (the underscore-prefix lesson from slice 1's HANDOFF §5
      item 4 — a derived resource named `_id_ranges`-adjacent must not be swallowed by wipe);
      `_understudy_meta` accepts `recipe`, `seed`, `config_hash`, `clock_mode`; unwritten
      resources keep slice 1's DDL byte-for-byte (slice 1's `store.test.ts` DDL assertions stay
      green untouched). Fails first.
- [ ] T023 [FND] Implement `_id_ranges` DDL in `src/store/schema.ts`, `Store.reserveRange /
      readRange / advanceRange` (additive), and the meta keys. `wipe` and `removeByOrigin` keep
      their semantics (`removeByOrigin("generated")` must also reset that collection's
      `_id_ranges.next` to its reserved start in the same transaction so wipe + regenerate is
      reproducible — test it).
- [ ] T024 [P] [FND] Tests for **foreign keys** in `tests/unit/store-fk.test.ts`: a `decided`
      relationship produces a real `REFERENCES` constraint (assert via `PRAGMA
      foreign_key_list`); `onDelete: restrict` refuses deleting a referenced parent;
      `cascade` removes children; `setNull` nulls the child field; an **`undetermined` link
      produces no constraint** (assert absence — the data-model §3 "last row"); `foreign_keys`
      pragma is on for every connection; an orphan insert is refused. Includes the integer-FK
      vs TEXT-id cast the single-`doc` table forces. Fails first.
- [ ] T025 [FND] Implement FK constraints in `src/store/sqlite.ts`:
      `ensureResource(resource, { foreignKeys, indexes })`. **Spike inside this task**: SQLite's
      rules for foreign keys on generated columns; if a generated column cannot be a child key
      with the required actions, maintain a real `fk_<field>` column set by the store from `doc`
      on insert/update inside the same statement. Record the outcome in the task's commit message
      and PR body. Existing one-argument `ensureResource(resource)` is unchanged.
- [ ] T026 [P] [FND] Tests for **indexes** in `tests/unit/store-index.test.ts`: each declared
      filterable/sortable field gets `"<resource>_<field>_idx"`; `EXPLAIN QUERY PLAN` of a
      filtered `listPaged` uses it (**not** a full scan); the *reason* (the declared list
      parameter that caused it) is available to the report. Fails first.
- [ ] T027 [FND] Implement the indexes in `src/store/sqlite.ts` (the `json_extract` form in
      data-model §3) and thread the reason into `Resource`/`StartupReport` (T043).
- [ ] T028 [P] [FND] Tests for `Store.insertMany` (one transaction: all rows or none — a
      mid-batch failure leaves **zero** rows and an unadvanced range, principle V's narrow
      form), `Store.countByOrigin()` (per resource and total), and `Store.listIdentities(resource)`
      (ordered, ids only, for reference draws). Fails first. Then implement them.

**Checkpoint**: the store carries ranges, FKs, indexes and atomic batch writes; slice 1's suite
is untouched and green.

---

## Phase 4: User Story 4 — startup tells me what it inferred, and how to pin it (P1) 🎯

**Goal**: derivation of the *population* facts, reported. This precedes generation because every
later phase consumes the model. **Golden family: inference.**

**Independent Test**: start against fixture documents whose naming conventions imply some links
and hide others; the report names collections, evidence, undetermined links with candidates,
cycles, spaces and paging; pinning one in configuration changes the outcome.

- [ ] T029 [P] [US4] Fixture documents (no vendor text; **shape-faithful to the measured
      facts**, `docs/05` §1): `tests/fixtures/collisions-api.yaml` (`externalId` on ≥4
      collections each meaning a different system; `eventId` + `viagogoEventId` +
      `primaryEventId` co-located on one resource; one unambiguous `venueId` → `Venue`),
      `tests/fixtures/cycle-api.yaml` (A→B→C→A plus an acyclic chain), `tests/fixtures/spaces-api.yaml`
      (int64, int32, uuid, a `pattern`-prefixed string, an **opaque** string id),
      `tests/fixtures/cursor-schema-api.yaml` (`paginationToken` in the response schema +
      `maxPageSize` query, plus an offset/limit and a page/size collection so all three styles
      are covered, and one collection declaring none).
- [ ] T030 [P] [US4] **Inference golden test** in `tests/unit/inference.golden.test.ts`, written
      before any derivation change: derive each fixture and compare the whole `{resources,
      relationships, ambiguities, plan}` serialisation to
      `tests/fixtures/golden/inference-<fixture>.json`. Goldens are authored by hand from the
      spec's rules (not captured from the code) and reviewed in the diff. Fails first on
      `status`/`candidates`/`idSpace`/`pagingStyle`.
- [ ] T031 [US4] Extend the derived model types in `src/spec/types.ts` (data-model §1):
      `Resource.idSpace` (`integer|uuid|formatted|opaque`), `Resource.pagingStyle`
      (`cursor-in-schema|offset-limit|page-size|none-declared`), `Resource.filterFields /
      sortFields`, `Relationship.status` (`decided|undetermined`) and `candidates`, new
      `AmbiguityKind`s (`undetermined-link`, `identity-space-unreservable`,
      `paging-not-exercised`, `unpaged-large-collection`, `clock-unpinned`,
      `lookup-only`). Additive: slice 1 consumers still compile.
- [ ] T032 [US4] Implement identity-space classification in `src/spec/resources.ts` (declared
      type+format+pattern → space; opaque string ⇒ `identity-space-unreservable` reported,
      **never guessed**) and paging-style classification (query parameters **and** the 2xx
      response schema's cursor property).
- [ ] T033 [US4] Implement **convention proposes / decides only when unambiguous** (FR-006
      amendment B): a convention hit is *proposed*; it is `decided` iff exactly one candidate
      survives; `externalId`-class names (a name occurring on several collections with no
      distinguishing prefix, configurable list) and two sibling properties that could both be
      the link yield `undetermined` with `candidates`, no foreign key, no ordering edge, one
      `undetermined-link` ambiguity each. A **configured** relation (`entities.<X>.relations`)
      wins over every inferred one and is reported `configured`; an `extension`
      (`x-understudy-ref`, documented in the contract) outranks convention; nesting last.
      Evidence order is asserted by a table test, one row per rung.
- [ ] T034 [P] [US4] Test for the **generation plan** in `tests/unit/plan.test.ts`: `order` is a
      topological order over **decided** links only; ties break by collection **name** (never
      recipe order or object-key order — SC-007); a cycle yields `cycles: [[A,B,C]]`, the
      acyclic part still orders, cycle members are ordered deterministically and their cyclic
      link fields are listed as unresolved-and-reported (FR-008); `refusals` is non-empty for
      overlapping ranges / unknown collections. **Run on a 10 000-edge synthetic graph with a
      long chain — no recursion, no stack overflow (research §6).** Fails first.
- [ ] T035 [US4] Implement `src/data/plan.ts` (`GenerationPlan` per data-model §1: `order`,
      `cycles` (Tarjan SCC, iterative), `perCollection[] {name, seed, count, idRange,
      fieldRules[]}`, `refusals`) — pure, no store.
- [ ] T036 [P] [US4] Test the **report** in `tests/unit/report.test.ts` (extend; slice 1's
      assertions untouched): collections with `idSpace`, `pagingStyle` and range; every link
      with evidence; `undetermined` links listed **separately with candidates**; cycles; the
      generation order; configured counts; counts by origin; the clock mode and `clock-unpinned`
      warning; a `configured` link renders differently from a `convention` one; the **same data**
      feeds the human rendering and the structured log line. Fails first.
- [ ] T037 [US4] Extend `src/spec/report.ts` and `src/logging.ts` for the above. `spec/` still
      imports nothing from `data/`: the plan is attached to the report by `src/index.ts`.
- [ ] T038 [P] [US4] Integration test `tests/integration/inference-startup.test.ts` — Scenario
      5 and US4.1–5: start the real mock on `collisions-api.yaml`; the report lists the
      undetermined links with candidates; a `configured` pin in `understudy.yaml` flips one to
      `decided`/`configured`; a cycle document starts and **does not deadlock** (assert it
      reaches `listening` inside a timeout). Fails first.
- [ ] T039 [US4] Wire the plan into `createMock` (`src/index.ts`): build `GenerationPlan`
      after reconcile, **refuse on any `refusals`**, attach to `StartupReport`, log both
      renderings. T038 goes green.

**Checkpoint**: an integrator can decide what to pin from the report alone (SC-005); no data
exists yet. Inference goldens green.

---

## Phase 5: User Story 1 — versioned fixtures, identical every run (P1) 🎯

**Goal**: the fixed parents generation will attach to; the static/dynamic separation (IV).

**Independent Test**: fixtures file → start twice from a wiped store → byte-identical records;
edit the file → restart → the change is the only difference.

- [ ] T040 [P] [US1] Fixture documents/files for the phase: `tests/fixtures/fixtures-project/`
      (`understudy.yaml`, `static/lookups/*.yaml`, `static/entities/*.yaml`) built on
      `inventory-api.yaml` + a second collection with a decided link to it.
- [ ] T041 [P] [US1] Integration test `tests/integration/fixtures.test.ts` (US1.1–1.4):
      declared identities and values exist exactly; **start twice from a wiped store → the
      serialised static rows are byte-identical**; edit one fixture value, restart → only that
      row differs; remove a fixture row from the file, restart → the stale `static` row is gone;
      a fixture record read over the API is **shape-indistinguishable** from a runtime-created
      one (US1.4 — assert the response bodies carry no origin field); the origin column is
      `static` for every fixture row and **`runtime` for everything the API wrote**; the fixture
      files on disk are byte-identical before/after (hash). Fails first.
- [ ] T042 [US1] Implement `src/data/fixtures.ts`: reconcile the store's `static` rows to the
      `FixtureSet` in **one transaction** (insert/replace changed, delete stale static rows),
      the **only** code path that writes `origin='static'`; validate each body against the
      document's schema first (FR-014); order by FK DAG so parents precede children. Wire into
      `createMock` after table creation.
- [ ] T043 [P] [US1] Test in `tests/integration/fixture-origin.test.ts`: no code path other than
      `fixtures.ts` can write a `static` row — assert by running generation, API CRUD and `wipe`
      and diffing `static` rows byte-for-byte (SC-003, narrowed per D2: fixture **files** never rewritten, fixture rows
      applied identically on every start, and `static` rows byte-identical across generation,
      reads, lists and `wipe`), and **`wipe` leaves static rows and rewinds `id_seq`** (slice 1
      semantics, consumed unchanged). A `PATCH`/`PUT`/`DELETE` of a static-origin row **mutates it** (D2: API writes ARE mutations; slice 1's CRUD semantics stand) — assert the mutation is allowed and that no *other* slice-2 path writes `static`; the `OPEN-D2` placeholder is dropped (D2 resolved). **Also in this change (spec-first, D2):** amend `spec.md` FR-002/SC-003 to scope the immutability guarantee to the layers that own the rows (naming the API-write path explicitly), and add an **A4 amendment** recording the decision and its *Why* (constitution Governance). **NC**:
      temporarily route a generation insert with `origin='static'`; the test must fail.
- [ ] T044 [P] [US1] Test that **selecting by tag works end to end for fixtures** (D1, FR-002):
      a project on `tags-api.yaml` selecting `Market_Orders` loads fixtures for the collections
      those operations derive, with no `operationId` available. Fails first, passes with T017.
- [ ] T045 [US1] Make T041, T043, T044 pass; record the byte-comparison output for the PR.

**Checkpoint**: fixtures are applied identically forever and never touched (US1, SC-003 for the
fixture layer).

---

## Phase 6: User Stories 2, 3, 7 — the value engine (P1/P2)

**Goal**: one data-driven path from `(document, config, seed)` to a value **and the rule that
produced it**. No store here — pure functions, so determinism is cheap to prove.
**Golden families: precedence, generators.**

- [ ] T046 [P] [US3] Test for **seed derivation** in `tests/unit/seed.test.ts`: same
      `(seed, name)` ⇒ same stream across 10 constructions; different names ⇒ different first
      draws; the derivation is **not** index-ordered (insert a name, others unchanged — the
      SC-007 mechanism, asserted on the derivation alone); a vector of fixed `(seed,name) →
      first 5 draws` is checked in as a golden so a library upgrade that changes Mersenne output
      is caught. Fails first.
- [ ] T047 [US3] Implement `src/data/seed.ts`: `hash(globalSeed, name)` (sha256 → uint32) →
      `Rng` (`next()`, `int(lo,hi)`, `pick`, `weighted`) and a Faker instance bound to that
      stream with `setDefaultRefDate(clock.now())` (research §1 trap). One stream per collection.
- [ ] T048 [P] [US7] **Generators golden test** in `tests/unit/generators.golden.test.ts`, one
      table per built-in with a fixed seed and the expected 20 values checked into
      `tests/fixtures/golden/generators-*.json`: `choice` (+ asserts every value ∈ set), `seq`
      (monotonic, named, independent per collection), `lookup` (uniform and weighted; **weighted
      asserts the 0.8/0.1/0.1 shape within a stated tolerance over 5 000 draws** and yields a
      *row identity that exists* in the table), `ref` (existing identity of another collection),
      `faker` (path + args, e.g. `string.alpha` length 1 upper; unknown path refuses naming it),
      `expr` (below). **NC**: swap the weighted draw for a uniform one; the weights test must
      fail. Fails first.
- [ ] T049 [P] [US7] Test the **registry** in `tests/unit/registry.test.ts`: built-ins and
      custom generators share **one namespace** (FR-012); a custom `choice` generator from
      `generators:` in a recipe is used exactly like a built-in; a **plugin file** generator
      (path in config, ESM default export `(ctx) => value`) is loaded with a **config-relative**
      path and is given only the collection's seeded `Rng` (so it cannot break determinism by
      construction); a name collision between custom and built-in refuses naming both; an
      unknown generator refuses naming it. Fails first.
- [ ] T050 [US7] Implement `src/data/generators/{registry,faker,lookup,reference,sequence,choice}.ts`
      to make T048/T049 pass.
- [ ] T051 [P] [US2] Test for **`expr`** in `tests/unit/expr.test.ts`: `price: cost * $uniform(1.1,
      2.5)` is evaluated **after** `cost`; the result equals `cost × the seeded draw` (recompute
      from the stream); `$uniform`/`$choice` draw from the **collection's** stream (re-running
      gives identical output; a sibling collection's draws do not shift it); a field depending
      on a field with a later declaration still orders correctly; a cycle is refused at load
      (T015); a runtime type error (JSONata signature mismatch) fails **loudly naming the
      field**. Fails first.
- [ ] T052 [US2] Implement `src/data/generators/expr.ts`: JSONata with seeding-aware helpers
      registered via `registerFunction` **with signatures**; evaluation order from T015's
      dependency edges.
- [ ] T053 [P] [US7] **Precedence golden test** in `tests/unit/precedence.golden.test.ts` — the
      FR-010 chain, one field walked down all six levels by removing a source at a time
      (US7 independent test): (1) explicit rule → (2) supplied value → (3) lookup reference → (4)
      the document's enum/format/range/example/default → (5) faker heuristic by name+format →
      (6) type default. Each step asserts **value and provenance** `{level, rule}` against
      `tests/fixtures/golden/precedence-*.json`, including: a supplied value beats a *generator*
      and a *spec default* but **loses to an explicit rule**; a field with a spec `enum` **never**
      falls through to the heuristic (FR-014); a field with nothing falls to level 6 and the
      provenance says `type-default`; **a heuristic-chosen value is flagged** so the report can
      say "chosen by a fallback" (US7.4). Fails first.
- [ ] T054 [US7] Implement `src/data/precedence.ts`: `chooseValue(field, ctx) → {value,
      provenance}`; the **static** counterpart `planField(field)` that reports which level *will*
      supply each unruled field (feeds `GenerationPlan.fieldRules` and the report, T037) so the
      two can never disagree — they are one function with a dry-run flag, not two
      implementations (research §5 alternative rejected).
- [ ] T055 [P] [US2] Test **schema conformance** in `tests/unit/conformance.test.ts` (FR-014,
      SC-004): property-style over a fixture schema exercising `enum`, `format`
      (`date-time`,`date`,`uuid`,`email`,`uri`), `minimum/maximum/exclusive*`,
      `minLength/maxLength`, `pattern` (the supported subset), `minItems/maxItems`, nested
      objects, arrays, `nullable`/`oneOf`-of-primitives — **every value from 2 000 seeded draws
      validates** against the Ajv validator compiled from the document. A schema construct the
      generator cannot satisfy refuses naming collection and field (never stores a
      non-conforming record, never silently loosens). Fails first.
- [ ] T056 [US2] Implement the schema-driven level-4/5/6 generator in `src/data/precedence.ts`
      + `src/data/generators/faker.ts` (name+format heuristics, e.g. `email`, `*Name`, `*At`,
      `price`/`amount`, `quantity`), reusing `src/spec/identity.ts` for `pattern` strings.
- [ ] T057 [P] [US2] Test **invariants** in `tests/unit/invariants.test.ts` (FR-013, US2.5):
      `constraints: ["price >= cost"]` holds on 1 000 records; a satisfiable-but-rare invariant
      is met by **redraw** (assert `redraws > 0` was used and the final record satisfies it);
      an **impossible** one fails after exactly `redraws` attempts with
      `InvariantViolatedError` naming the **collection and the rule text**, and **nothing is
      stored**; `redraws` is configurable and counted per record; a constraint that fails to
      parse refuses at load. **NC**: set the budget to 0 on the satisfiable case; the test must
      then fail loudly (not pass vacuously). Fails first.
- [ ] T058 [US2] Implement `src/data/invariants.ts` (redraw the record's *drawn* fields — never
      supplied, linked or identity fields — under the **same** stream, so the redraw is
      deterministic).
- [ ] T059 [US7] Make T046–T057 green; show red→green per task in the PR.

**Checkpoint**: given a document, a recipe and a seed, a record's values and their provenance are
a pure, reproducible function — before any row is written.

---

## Phase 7: User Story 6 — identities that cannot collide (P2) + carried item F-E

**Goal**: reserved ranges across integer / uuid / formatted / opaque spaces (FR-017/018).

- [ ] T060 [P] [US6] **F-E regression, first** (slice 1 deferred; this slice owns it). Test in
      `tests/unit/identity.test.ts` (extend; slice 1's cases untouched) and
      `tests/integration/string-identity.test.ts`: for `^W-[0-9]+$`, `^W-[0-9]{3,}$`,
      `^[A-Z]+-[0-9]*$` allocate **1 000 consecutive identities**: all **unique**, all match the
      declared pattern, none 500s, `ambiguities: []` (the pattern *is* supported now). Also the
      carried assertion that an *unsupported* construct (`^(a|b)\d$`, lookahead, backreference)
      is reported as `identity-pattern-unsupported` and falls back, never non-conforming.
      **Red on a real assertion today**: `W-0…W-9` then `UNIQUE` collision at #11. Fixture
      `tests/fixtures/open-quantifier-api.yaml`.
- [ ] T061 [US6] Fix `src/spec/identity.ts`: an **open quantifier** (`+`, `*`, `{n,}`) on a digit
      run renders the counter **unpadded and growing** (`{n,}` zero-pads to `n` then grows); on a
      letter run it renders a bijective base-N numeral that grows; fixed quantifiers keep the
      current bounded behaviour **with the wrap replaced by a refusal** (`IdentitySpaceExhausted`,
      named, reported) instead of silently wrapping into a collision. Output is verified against
      the declared pattern before use (existing rule). Remove the "maps open quantifiers to one
      unit" comment.
- [ ] T062 [P] [US6] Tests in `tests/unit/identity-ranges.test.ts` (FR-017/018, SC-006), one
      block per space: **integer** (disjoint from fixtures: a fixture id ≥ the collection's
      range start refuses naming the collection; `generatedStart` per entity and global);
      **uuid** (generated v4-shaped from the collection stream; a draw equal to a fixture or
      earlier id is redrawn; stable for the seed); **formatted** (the pattern's numeric run
      spans the range; `ids.reserved: "EVT-100000..EVT-199999"` is honoured; two overlapping
      spans refuse naming the collection); **opaque** (reported as unreservable, never guessed;
      collisions with fixtures avoided by a membership check, not a range). **Runtime
      allocation (FR-018)**: API-created records continue from the **same** `_id_ranges` cursor
      so they can collide with neither fixture nor generated ids — create 200 via the API after
      generating 500; assert the union is duplicate-free in every space. Fails first.
- [ ] T063 [US6] Implement `src/data/identity.ts` and wire the slice-1 allocator
      (`nextIdentity`/`src/mock/crud.ts` allocation) to consult it **without changing CRUD
      semantics** — a delegation behind the existing `ids` option, covered by slice 1's
      untouched suites staying green.
- [ ] T064 [P] [US6] Integration test `tests/integration/identity-collision.test.ts` (US6.1–6.4,
      Scenario 4): fixtures + generation in one collection ⇒ `uniq -d` over every identity is
      empty; overlapping configured ranges **refuse to start naming the collection** (assert the
      message, not a stack trace); same seed twice ⇒ same identities for the same records; a
      string-identity collection produces identities in the declared form. Fails first.
- [ ] T065 [US6] Make T062/T064 green.

**Checkpoint**: no identity collides in any space, in 100% of the tested configurations (SC-006);
F-E is closed.

---

## Phase 8: User Stories 2, 3, 5 — the generation run (P1/P2)

**Goal**: one data-driven pass over the plan: counts, per-parent counts, FK attachment, paging
agreement, atomic writes. **Golden family: generators (whole-run).**

- [ ] T066 [P] [US2] Fixture project `tests/fixtures/gen-project/` (`ci-small` and `load-test`
      recipes over the multi-collection fixture document; a recipe naming an unrelated extra
      collection for SC-007; one with a deliberately impossible invariant).
- [ ] T067 [P] [US2] Integration test `tests/integration/generate-counts.test.ts` (US2.1–2.6):
      exactly N records; **every record validates against the document schema** (re-validated
      from the store, not from the generator's own check); a `choice` field only emits set
      members; a `lookup` field references a real row (US2.3); an `expr` field is consistent with
      its siblings (US2.4); an impossible invariant fails the run **loudly, naming the rule,
      storing nothing for that collection**; a collection with **no rules at all** is populated
      from the schema alone and the report says which level supplied each field (US2.6/US7.4).
      Fails first.
- [ ] T068 [P] [US5] Integration test `tests/integration/generate-links.test.ts` (US5.1–5.4,
      SC-004): every child references an existing parent (**query the DB** for orphans — zero);
      a `perParent` range holds for every parent and is reproducible from the seed; with
      `distribution: zipf` the **count histogram is skewed** (assert a stated statistic, e.g.
      share of parents at the range minimum, exceeds uniform's by a margin) — **NC**: switch the
      recipe to `uniform`; the test must fail; children attach to **fixture** parents and fixture
      rows are byte-unchanged; a `decided` link with an empty parent collection and a required
      field refuses naming both; an **undetermined** link is **not acted on** (no FK, field
      generated by its own precedence, listed in the report). Fails first.
- [ ] T069 [P] [US2] Integration test `tests/integration/generate-paging.test.ts` (FR-015,
      Amendment C): on `cursor-schema-api.yaml` with `count > maxPageSize`, listing returns a
      **page with a continuation token**, following tokens enumerates **exactly `count`**
      distinct records, and the report carries `paging-not-exercised` when `count ≤ page` and
      `unpaged-large-collection` for a collection declaring no paging; offset/limit and
      page/size collections page by their own style. **NC**: set `count` below one page; the
      page-token assertion must fail. Fails first.
- [ ] T070 [US2] Implement `src/data/generate.ts`: run the plan in `order`; per collection derive
      the stream, allocate identities (T063), choose values (T054), enforce invariants (T058),
      validate against the document (FR-014), and `insertMany` in **one transaction per
      collection** together with the `_id_ranges` advance (principle V narrow form); read the
      clock **once** (D8); write the generation marker (D7); return `GenerationResult {
      created: {collection: {origin: n}}, provenance, refusals, redraws }`. One code path — **no
      per-collection or per-field branch** (SC-001 / "Prohibited"; asserted in T086).
- [ ] T071 [US5] Implement per-parent counts and distributions in
      `src/data/generate.ts` / `src/data/generators/reference.ts` (`uniform`, `zipf`; the
      per-parent count is drawn from the **child's** stream; parents enumerated in identity
      order). Implement implicit reference draws for `decided` link fields with no rule
      (provenance: level 3, `rule: relationship`).
- [ ] T072 [US2] Wire generation into `createMock` after fixtures: recipe selected from config
      or `--recipe`; D7 semantics (generate / skip-on-matching-marker / refuse-on-mismatch) with
      tests in `tests/integration/generate-restart.test.ts` (start, stop, start again with the
      same recipe+seed ⇒ **no regeneration, rows byte-identical**; changed seed ⇒ refusal naming
      the mismatch and the `reset` remedy). Make T067–T069 green.

**Checkpoint**: `ustdy up --recipe ci-small --seed 42` produces a populated, contract-valid,
correctly linked mock (SC-001, SC-004).

---

## Phase 9: Commands — the control operation and the CLI (FR-020, FR-021)

**Goal**: the generation operation lives in the control API; the CLI is a client of it.
(`init` is the documented non-client act, with **no generation logic**, plan Constitution Check II.)

- [ ] T073 [P] [US2] Control-API test in `tests/integration/control-generate.test.ts` (extends
      slice 1's, untouched): `POST /generate {recipe, seed?}` returns the declared
      `GenerateResult` with **counts by collection and origin** (FR-021, FR-004); the response
      validates against `contracts/control-api.openapi.json` (T006); an unknown recipe returns
      the declared 4xx `ControlError` naming it; a malformed body returns the declared 400; the
      request is **not** routed into the mocked surface; a second identical call follows D7
      (no-op, said so). Fails first.
- [ ] T074 [US2] Implement the route in `src/control/routes.ts` over `src/data/generate.ts`
      (the control plane gains a `generate` dependency through `ControlContext`, nothing
      else). T073 green.
- [ ] T075 [P] [US2] CLI tests in `tests/integration/cli.test.ts` (extend): `ustdy generate
      --recipe <n> [--seed <n>]` output agrees with the control response; with the control plane
      down it exits non-zero with a connection error and **does no local work** (FR-019/020 of
      slice 1, still binding); `up --recipe/--seed` start-time generation; the architecture
      test (T002) still passes (the CLI imports nothing from `data/`). Fails first.
- [ ] T076 [US2] Implement `generate` in `src/cli/client.ts` + `src/cli/program.ts` and the
      extended `specs/002-data-layer/contracts/cli.md` (every new flag documented with a runnable
      example — constitution IX).
- [ ] T077 [P] [US4] Test for **`ustdy init`** (FR-020, Scenario 1) in
      `tests/integration/init.test.ts`: against `inventory-api.yaml` the four layer folders
      (`static/{lookups,entities}`, `imports`, `dynamic`, `behavior`) and an `understudy.yaml`
      exist; **stdout is the inferred collection report** (collections, links with evidence,
      undetermined links listed separately); a second run **refuses to overwrite** existing files
      (naming them) unless `--force`; the scaffolded project **starts** (`ustdy up` on it
      succeeds); the CLI module imports only `src/index.ts`/`src/init.ts`; no network beyond a
      URL the user supplied. Fails first.
- [ ] T078 [US4] Implement `src/init.ts` (library) and the `init` command: derive via the
      existing pipeline, write commented scaffolds whose example content is the **documented
      examples** from the contract, print the report. Contains no generation logic.

**Checkpoint**: both new commands exist; `--help` shows them; the CLI still adds no logic the
API lacks (constitution II).

---

## Phase 10: Proofs — determinism, immutability, scale, and the sealed store boundary

**Goal**: the guarantees the slice sells, each shown to **fail when broken**.

- [ ] T079 [P] [US3] **Determinism** — `tests/integration/determinism.test.ts` (SC-002, US3.1–3.3):
      from a wiped store, same seed + config + fixtures + pinned `clock.start`: generate twice,
      serialise both stores with the canonical serialiser `tests/helpers/serialize.ts` (rows
      sorted by `(collection, identity)`, keys sorted, `created_at`/`updated_at` included) and
      assert **byte-equality (sha256 printed)**; a different seed ⇒ the bytes **differ**; `wipe`
      + regenerate reproduces **every record's identity and values**, not a count. **NC** (each
      run once, each must fail the test): replace the per-collection RNG with one shared stream;
      read `Date.now()` per record instead of once; iterate parents in `Map` insertion order of a
      shuffled input.
- [ ] T080 [P] [US3] **Independence** — `tests/integration/independence.test.ts` (SC-007, US3.4,
      Scenario 3): add an unrelated collection to the recipe, same seed ⇒ every pre-existing
      collection's serialised rows are **byte-identical**; the same holds when the new
      collection is named to sort *before* every existing one and when it is inserted first in the
      recipe file. **NC**: the shared-stream mutation from T079 must make this fail while
      T079's double-run still passes — the "green determinism, red independence" trap research §1
      names.
- [ ] T081 [P] [US1] **Fixture immutability** — `tests/integration/immutability.test.ts` (SC-003):
      byte-compare the serialised `static` rows (and the fixture files) before and after
      generation **and** a scripted API session (create ×N, read, list, filter, page, PATCH/DELETE
      of non-static rows, `reset wipe`); identical in 100% of 20 seeded runs. **NC**: the T043
      mutation.
- [ ] T082 [P] [US2] **Scale** — `tests/integration/scale.test.ts` (SC-008): a recipe of ≥5 000
      records over ≥5 collections is generated and `GET /health` answers within a stated budget
      (assert **< 30 s** hard, print the measured time; the spec's "well under a minute" is the
      claim, 30 s the bar); memory stays flat while generating (heap high-water mark does not
      scale with count between 1 000 and 10 000 — compare, with a stated ratio bound). **NC**:
      `insertMany` replaced by per-row autocommit; the time bound must fail on the same input
      (proves the bound can fail).
- [ ] T083 [P] [FND] **Seal slice 1's T043 blind spot** — `tests/integration/store-boundary.test.ts`
      with `tests/helpers/sql-probe.ts`: a **driver-level probe** wraps
      `better-sqlite3`'s `Database#prepare` and records, per statement, its SQL text, bound
      parameters, and **rows returned by `all()`/`iterate()`**. Over a collection of 20 000
      generated rows, a paged list (offset/limit, page/size **and** cursor) must show: the list
      statement's SQL contains a bound `LIMIT ?` whose value equals the page size (+1 sentinel at
      most), rows crossing the driver boundary ≤ page + 1, and no `SELECT … FROM "<resource>"`
      without a `LIMIT`/window. The existing counting-decorator suite is kept (it proves the
      engine layer). **NC (the point)**: a `MaterialisingStore` test double that implements
      `listPaged` as `SELECT * … ; slice()` passes the **old** decorator suite and **fails** this
      probe — the test file asserts both. Fails first against the double, passes against
      `SqliteStore`.
- [ ] T084 [US3] Make T079–T083 green; run each `NC` once, paste the failing assertion into the
      PR, and revert the mutation. No mutation is committed.

**Checkpoint**: determinism, independence, immutability, scale and the store boundary are each
proven **and** proven falsifiable.

---

## Phase 11: Polish & Cross-Cutting

- [ ] T085 [P] No-secrets and no-outbound sweep: `tests/integration/outbound.test.ts` (extend) runs
      the full slice-2 lifecycle — fixtures, generation, `init`, `generate` — against a **file**
      spec and asserts **zero outbound connections** and **zero `process.env` reads in `src/`**
      (T002 grep). `${VAR}` strings in behaviour files stay inert text.
- [ ] T086 [P] No-per-endpoint-handler guard (SC-001, constitution "Prohibited"): test that
      `src/data/` and `src/mock/` contain **no branch on a collection or field name** — a
      structural test that runs generation over two *different* fixture documents with identical
      engine code and asserts the engine has no document-specific identifiers (scan `src/data/`
      for quoted names drawn from the fixture documents). **NC**: add a `if (name === "Event")`
      to a copy; the scan must flag it.
- [ ] T087 **Opt-in live derivation** — `tests/live/live-derivation.test.ts`, skipped unless
      `USTDY_LIVE_SPEC` is set (Scenario 9; **never CI-blocking, never vendored** — licence
      unresolved). Fetch on demand from
      `https://pointofsaleapi.stubhub.net/swagger/v1/swagger.json`, **verify the sha256 equals
      the value recorded in `docs/05-target-apis.md` §1** (and say so plainly if the document has
      moved), select by **tag** (D1), derive, and print: collections, links by evidence,
      **undetermined links with candidates**, identity spaces by count (compare to the measured
      78/36/30/29), paging styles by count (compare to 21/18), and **how many pins the document
      needs** to make every link decided. Add `test:live` to `package.json`; the default
      `vitest run` excludes `tests/live/`. The outcome is recorded in the PR body and a
      **new** `specs/002-data-layer/live-derivation.md` (the approved `research.md` is not
      edited).
- [ ] T088 **Run `quickstart.md` end to end** against a built `dist/` and record the output as
      `specs/002-data-layer/quickstart-run.txt` (slice 1's precedent), scenarios 1–9, **with any
      step that did not behave as written called out and fixed — in the quickstart (and say
      so) or in the code (and say so)**. D6's divergences are named there, not hidden.
- [ ] T089 [P] Documentation (constitution IX): `README.md` reflects the shipped CLI surface
      (`init`, `generate`, `up --recipe/--seed`) and **every new config key** — `recipe`, `seed`,
      `paths.*`, `entities.<X>.{idField,writes,ids.*,relations.*.onDelete}`, `clock.*`, recipe
      keys (`count`, `perParent`, `fields`, `constraints`, `redraws`, `generators`), the
      behaviour layer — each with a **runnable example**; add a test that fails when a key in
      the contract has no mention in `README.md` or the contract's own `examples`.
- [ ] T090 Gate and evidence: `npm ci && npm run lint && npm run typecheck && npm test && npm run
      build && node dist/cli/index.js --help`, with real output pasted; confirm `git diff
      origin/main -- specs/001-slice-1-core` is **empty** and `specs/002-data-layer/{spec,plan,
      research,data-model}.md` are unchanged; tick every task `[X]` in a final commit.

---

## Dependencies & Execution Order

- **Phase 1 → 2** strictly: the boundary guard (T002) and the contract repoints (T005/T006)
  gate everything; the clock seam (T004) gates generation.
- **Phase 2** gates all later phases (config surface). Inside it: T009 contract → T011 compiled
  validators → T013/T015/T019 loaders; T016/T017 (tags) are independent of the loaders and can run
  in parallel with them; T020/T021 (reconcile) need the loaders.
- **Phase 3** (store) needs only Phase 1; it can run **in parallel with Phase 2** once T005 lands.
- **Phase 4** (inference/report) needs Phase 2 (configured links, reconcile) — and Phase 3 only
  for the index-reason plumbing (T027).
- **Phase 5** (fixtures) needs Phases 2–4. **Phase 6** (value engine) is **pure** and needs only
  Phase 2 + T004: it can start as soon as the layers load, in parallel with Phases 3–5.
- **Phase 7** (identity) needs Phases 3 and 6 (the allocator uses the seeded stream and
  `_id_ranges`); T060 (F-E) has no dependency and can be done first.
- **Phase 8** (run) needs 3–7. **Phase 9** needs 8. **Phase 10** needs 8–9. **Phase 11** last,
  though T085/T086 are cheap after Phase 8.

### Parallel opportunities

- Setup: T002, T003 independent; T005 and T006 touch different generators.
- Phase 2 tests T007, T010, T012, T014, T016, T018, T020 are different files and run together.
- Phase 3 tests T022, T024, T026, T028 are different files and run together.
- Phase 6: seed (T046), generators (T048/T049), expr (T051), precedence (T053), conformance
  (T055), invariants (T057) are independent test files.
- Phase 10: T079–T083 are independent and `[P]`.

---

## Implementation Strategy

**MVP** is Phases 1–5 + the *counts-only* slice of Phases 6/8: fixtures plus a recipe that asks for
N records of a collection, deterministic and contract-valid (US1, US2, US3 partially). That is
already the product's headline promise and satisfies SC-002/SC-003/SC-004 for one collection.

Phases 4, 7 and the per-parent half of 8 add the *trust* properties — what the tool inferred,
identities that cannot collide, parents that exist — each independently demonstrable and each
validated at its checkpoint before the next begins. Phase 10 turns the guarantees into
falsifiable tests; Phase 11 closes the acceptance evidence.

**Stop-and-review gates**: this document is the first (the human checkpoint raised before any
implementation). The second is the end of **Phase 8**: at that point the tool either generates
correct linked data or it does not, and Phases 9–11 do not repair that. During the run, every phase
**Checkpoint** is a **self-review** gate (tests + `NC` + the `quickstart` scenario); the **run exits
with the whole-slice PR**, and that PR is the human/Kanban review gate before anything reaches
`main` (see "Delivery" above).

**Carried-in items** (named so they cannot be lost): **F-E** → T060/T061; **T043 store-interior
blind spot** → T083; **contract repoint** → T005 (+T006 for the control contract, D4);
**vendor-document derivation run** → T087.

**Out of scope, not started**: import/export (slice 3), events/webhooks (slice 4), actions and
simulations (slice 5), hardening, virtual clock, Postgres (slice 6), conformance/examples
(slice 7). The behaviour and imports layers are **parsed and validated** here and consumed
nowhere.

---

## Implementation notes (appended during the run; no task above is modified except its checkbox)

- **T001 — dependency pin.** `@faker-js/faker` is pinned `^10.6.0`, not the `^9` named in
  `plan.md`: every 9.x and 10.x ≤ 10.4 carries a *high* advisory (GHSA-qxc2-j82w-r537,
  `helpers.fake` arbitrary-code execution) and T001 requires no new advisories. 10.6 keeps the seeded
  `Faker({ locale, randomizer })`, `setDefaultRefDate` and `generateMersenne53Randomizer` API the
  research §1 design uses (verified by the T001 smoke test). Recorded in the PR.
- **T002 — `process.env`.** The one `process.env` read is `src/cli/index.ts`, the CLI's process
  boundary, which hands the environment to the (env-free) program; the guard asserts the *library*
  never reads it.
