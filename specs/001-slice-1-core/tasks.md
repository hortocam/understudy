# Tasks: Slice 1 — Core CRUD Mock

**Input**: Design documents from `specs/001-slice-1-core/`

**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/`, `quickstart.md`

**Tests**: Included and mandatory. Constitution principle VII ("Test-First, Contract-Verified,
NON-NEGOTIABLE") requires a failing test before the code that passes it, so every implementation
task below is preceded by the test task that defines it.

**Organization**: by user story, so each is independently implementable and demonstrable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: which user story from `spec.md` this serves

## Phase 1: Setup

**Purpose**: the toolchain that everything else sits on. Already partly in place — the scaffold
commit landed strict TypeScript, eslint, vitest and CI before the spec was written, because a
project that cannot run its own tests cannot be developed test-first.

- [ ] T001 Add the runtime dependencies pinned in `plan.md` to `package.json` and install:
      `fastify`, `@scalar/openapi-parser`, `@scalar/openapi-upgrader`, `ajv`, `ajv-formats`,
      `better-sqlite3`, `yaml`, `commander` (+ `@types/better-sqlite3`), and verify `npm audit`
      reports no new advisories.
- [ ] T002 [P] Add the module boundary test in `tests/unit/architecture.test.ts`: assert that no
      file under `src/cli/` imports from `src/mock/`, `src/store/` or `src/spec/`. This is the
      machine-checkable half of FR-019 and it must fail before the boundary exists.
- [ ] T003 [P] Add the `bin` entry (`ustdy` → `dist/cli/index.js`) and scripts to `package.json`,
      and confirm `npm run build && node dist/cli/index.js --help` exits 0.

---

## Phase 2: Foundational (blocking prerequisites)

**Purpose**: the shared spine — document loading, the derived model, configuration, the store seam
and error/logging plumbing. Nothing user-visible works until these exist, which is why they are one
phase rather than distributed across the stories.

**⚠️ CRITICAL**: no user story work begins until this phase is complete.

- [ ] T004 [P] Define the error taxonomy in `src/errors.ts`: one class per refusal cause the spec
      names (document unreadable, document undereferenceable, empty selection, unknown operation
      in selection, config invalid, config contradicts document, store unwritable, port in use).
      Each carries the offending value so the message can name it (FR-004, FR-021).
- [ ] T005 [P] Test for T004 in `tests/unit/errors.test.ts`: each error's message contains the
      offending value. Fails first.
- [ ] T006 Define the config JSON Schema in `src/config/schema.ts` by importing
      `specs/001-slice-1-core/contracts/config.schema.yaml` as the single source (parse it at
      build time or inline it by generated copy — decide here and record why), then implement
      `loadConfig()` in `src/config/load.ts`: read YAML, validate against the schema, apply the
      documented defaults, refuse on unknown keys.
- [ ] T007 Test for T006 in `tests/unit/config.test.ts`: defaults applied; unknown key refused;
      a config whose `operations` is empty refused; a spec-relative path resolved relative to the
      config file, not the process cwd. Fails first.
- [ ] T008 Define the `Store` interface in `src/store/index.ts` — open/close, ensure table for a
      resource, insert/readOne/list/update/delete, wipe, removeByOrigin, request-log append and
      query, meta get/set, next identity — and nothing else. This is the principle-X seam; it must
      not leak SQL anywhere else.
- [ ] T009 Implement `src/store/schema.ts` (DDL per `data-model.md`) and `src/store/sqlite.ts`
      against T008.
- [ ] T010 [P] Test for T008/T009 in `tests/unit/store.test.ts` against a real temp SQLite file:
      round-trip a record, list it, wipe it, read the meta table; assert the DDL matches
      `data-model.md` (column names and the `origin` CHECK constraint).
- [ ] T011 Implement `src/spec/load.ts`: read the document from a path or URL, dereference
      (including external refs), upconvert 3.0 → 3.1, and extract the spec's own version + a
      content hash for `_understudy_meta`. No network access except a URL the user supplied
      (FR-001, FR-022).
- [ ] T012 Implement `src/spec/operations.ts`: resolve the configured `operations` entries against
      the document (by `operationId` or `METHOD /path`), producing the live set and the
      not-implemented set; refuse the whole selection if any entry does not exist (FR-002, FR-004).
- [ ] T013 [P] Test for T011/T012 in `tests/unit/spec-load.test.ts`: a fixture document with an
      external `$ref` resolves; a 3.0 document and its 3.1 twin produce the same operations; an
      unknown selection entry is refused by name; a URL spec is never fetched when the path form
      was given (assert no network call).
- [ ] T014 Implement `src/spec/resources.ts`: the resource-derivation and relationship-inference
      rules enumerated in `plan.md` → "Derivation rules", each relationship carrying its
      `evidence` (`configured` | `extension` | `convention` | `nesting`).
- [ ] T015 [P] Test for T014 in `tests/unit/resources.test.ts` with fixture documents that exercise
      each evidence rule *and* the ambiguity path (a path that matches no resource; an operation
      with no declared 2xx schema). Assert the reported entity name, id field and id type.
- [ ] T016 Implement `src/spec/report.ts`: build the `StartupReport` data structure from the derived
      model (live ops, not-selected ops, resources, relationships with evidence, ambiguities).
- [ ] T017 Implement `src/logging.ts`: structured (JSON-line) logs to stdout with a level, and a
      human-readable renderer for the startup report. Both from the same data (FR-024).

**Checkpoint**: the tool can load a document, validate a config, derive resources, and open a store
— with no HTTP server yet. `tests/unit` is green.

---

## Phase 3: User Story 1 — a spec-selected CRUD surface that behaves like the real service (P1) 🎯 MVP

**Goal**: the product itself. Selected operations answer contract-validly and persist; everything
else answers "not implemented in this mock", visibly distinct from "no such record".

**Independent Test**: with the fixture document from `quickstart.md` §1 and the config from §2,
create a record, restart the process, read it back; call a non-selected operation and get 501.

- [ ] T018 [P] [US1] Write the fixture document `tests/fixtures/inventory-api.yaml` (one collection,
      five selected operations, one deliberately unselected operation, a declared 2xx and the
      declared error statuses) and a second fixture exercising a paging style.
- [ ] T019 [P] [US1] Contract test in `tests/contract/crud.test.ts` that drives the mock over HTTP
      and asserts every response against `tests/fixtures/inventory-api.yaml` — the SC-003 suite.
      Fails first.
- [ ] T020 [P] [US1] Integration test in `tests/integration/persistence.test.ts`: create → restart
      the process → read back (SC-002). Fails first.
- [ ] T021 [P] [US1] Integration test in `tests/integration/not-implemented.test.ts`: a
      non-selected operation returns 501 with the operation named, and 501 ≠ the not-found status
      (SC-004). Fails first.
- [ ] T022 [US1] Implement `src/mock/validate.ts`: compile an Ajv validator per operation from the
      dereferenced document (draft 2020-12), and validate request bodies, parameters and headers.
- [ ] T023 [US1] Implement `src/mock/errors.ts`: render the document's *declared* error responses
      for that operation, with the declared status and body shape (FR-005, FR-008).
- [ ] T024 [US1] Implement `src/mock/crud.ts`: create / read / list / update / delete over the
      `Store` interface, using the derived resource model; PUT replaces, PATCH merges (FR-006);
      allocate identities per `data-model.md` §"Identity allocation" (FR-011); set `origin` and
      the timestamps; return the 2xx status the document declares (FR-005, FR-009).
- [ ] T025 [US1] Implement `src/mock/list.ts`: filtering, sorting and paging over the declared
      query parameters, in the declared paging style; where none is declared, return the full
      collection (FR-007). Prove paging does not load the collection into memory.
- [ ] T026 [US1] Implement `src/mock/route.ts` and `src/index.ts`: build the Fastify instance from
      the derived model, match a request against the live set, dispatch to T024/T025, answer 501
      for a known-but-unselected operation, and 404 for an unknown path.
- [ ] T027 [US1] Wire the startup report: refuse to start on any T004 error, otherwise log the
      report (FR-023). Re-run T019–T021; they must now pass.

**Checkpoint**: the mock serves CRUD, persists, validates, and answers 501 distinctly. MVP.

---

## Phase 4: User Story 2 — control the mock without touching its database (P1)

**Goal**: the control plane, and the seam every later slice plugs into.

**Independent Test**: drive health → create → list → reset → teardown entirely over HTTP.

- [ ] T028 [P] [US2] Integration test in `tests/integration/control.test.ts` for `quickstart.md`
      §7: health reports store reachability; reset wipes and leaves the mock answering; operations
      lists both sets; requests filters; teardown releases the port; a **second** teardown is not
      destructive; an unknown control path under the prefix returns the control 404 and never
      reaches the mocked surface (SC-002, FR-012–FR-017). Fails first.
- [ ] T029 [US2] Implement `src/control/routes.ts`: the five operations of
      `contracts/control-api.openapi.yaml`, each answering exactly the documented shape.
- [ ] T030 [US2] Implement `src/control/openapi.ts`: serve `contracts/control-api.openapi.yaml` at
      the prefix's `openapi.json` (FR-018), and add a test asserting the served document equals
      the checked-in file byte for byte — a *drift* check, not a conformance tautology.
- [ ] T031 [US2] Implement `src/control/server.ts`: mount the control plane on its own Fastify
      instance, on the same port under the reserved prefix or on `control.port` when configured;
      record every mocked-surface request into `_requests` with live/status/duration (FR-016).
- [ ] T032 [US2] Implement the `wipe` reset mode through `Store.removeByOrigin` + resetting the
      identity counters (FR-014), and refuse `mode` values not in the enum.
- [ ] T033 [US2] Implement teardown (`POST /teardown`): stop accepting, drain, release the port,
      and answer idempotently (FR-017). Prove the port is free by binding it again in the test.

**Checkpoint**: the whole lifecycle is drivable over HTTP.

---

## Phase 5: User Story 3 — the same control from the command line (P2)

**Goal**: `ustdy`, a client of the control plane with no logic of its own.

**Independent Test**: run `quickstart.md` §8 end to end, and with the control plane stopped,
confirm each command reports a connection failure instead of doing the work locally.

- [ ] T034 [P] [US3] Integration test in `tests/integration/cli.test.ts`: each command's output
      agrees with the corresponding control-API response; `ops list` mirrors `/operations`;
      `reset --to wipe` mirrors `POST /reset`; `down` mirrors `/teardown`; with the control plane
      down, each command exits non-zero with a connection error (SC-005, FR-019/FR-020). Fails first.
- [ ] T035 [US3] Implement `src/cli/client.ts`: a thin HTTP client for the five control operations,
      with the base URL from `--control-url`/env, and a clear connection-failure message.
- [ ] T036 [US3] Implement `src/cli/index.ts` with commander: `up`, `down`, `ops list`,
      `reset`, `logs requests`, each formatting a control response and nothing more.
- [ ] T037 [US3] Implement `up`'s one non-client act — construct the server from the config and
      poll `/health` until ready — keeping every other command purely a client (FR-019).

**Checkpoint**: the tool is pleasant in a terminal and in CI.

---

## Phase 6: User Story 4 — startup tells me what it understood (P3)

**Goal**: the report as a first-class deliverable rather than debug output.

**Independent Test**: start against a fixture document whose naming conventions imply some
relationships and hide others; confirm the report names the resources, states each relationship's
evidence source, and calls out what it could not determine.

- [ ] T038 [P] [US4] Unit test in `tests/unit/report.test.ts`: given a derived model, the report
      contains every resource, every relationship **with its evidence**, and every ambiguity; and
      a `convention`-sourced link is rendered differently from a `configured` one (SC-006, FR-023).
      Fails first.
- [ ] T039 [US4] Render the report: human-readable to stdout, and the same data as one structured
      log line (FR-024). Verify both from one source in T038.
- [ ] T040 [US4] Refusal paths: prove each T004 error produces a human-readable, cause-naming
      message and a non-zero exit — an unreadable document, an unresolvable `$ref`, an empty
      selection, an unknown operation, an invalid config, an unwritable store, a port in use.

**Checkpoint**: a user can decide what to pin in configuration without reading source.

---

## Phase 7: Polish & Cross-Cutting

- [ ] T041 [P] Cross-instance isolation test in `tests/integration/isolation.test.ts`: two
      instances with distinct ports and store files, no shared state, no cross-talk (SC-007).
- [ ] T042 [P] Prove no outbound traffic beyond a URL-supplied spec (SC-008, FR-022) — run the full
      lifecycle against a file spec and assert no outbound connection.
- [ ] T043 [P] Large-collection test: seed one collection past the page size, list it paged, and
      assert memory does not scale with the collection.
- [ ] T044 Documentation: `README.md` reflects the shipped CLI surface and the config keys; each
      config key has an example (constitution IX).
- [ ] T045 Run `quickstart.md` end to end against a built `dist/` and record the output as the
      feature's acceptance evidence. Any step that does not behave as written is a defect in the
      quickstart or the code — decide which, and fix the right one.

---

## Dependencies & Execution Order

- **Phase 1 → 2** strictly: the boundary test (T002) and the store seam (T008) gate everything.
- **Phase 3** needs Phase 2 complete. Within it, T018–T021 (fixtures and failing tests) precede
  T022–T026; T026 integrates the rest; T027 closes the phase.
- **Phase 4** needs Phase 3 (it logs and resets records that Phase 3 creates).
- **Phase 5** needs Phase 4 (the CLI is a client of it).
- **Phase 6** needs Phase 2 only for the derivation, and Phase 3 for a running mock to report
  against; it is the natural parallel workstream once Phase 3 lands.
- **Phase 7** last, but T041/T042 are cheap and can run any time after Phase 4.

### Parallel opportunities inside a phase

- T001–T003 are independent of each other.
- T004/T005, T010, T013, T015 touch different files and can run together.
- Within Phase 3, the four test tasks (T018–T021) are independent; `[P]` marks that.

---

## Implementation Strategy

**MVP** is Phase 1 + 2 + 3 — a spec-selected, persistent, contract-valid CRUD mock. That alone is a
usable product and satisfies SC-001 through SC-004 and SC-007.

Phases 4–6 add control, ergonomics and transparency; each is independently demonstrable and
should be validated at its checkpoint before the next begins. Phase 7 closes the acceptance
evidence.

**Stop-and-review gates**: the spec and plan are the human checkpoints (already passed). Phase 3's
checkpoint is the natural third — at that point the tool either works or does not, and no amount of
later polish fixes a mock that does not persist.
