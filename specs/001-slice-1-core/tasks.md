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

- [X] T001 Add the runtime dependencies pinned in `plan.md` to `package.json` and install:
      `fastify`, `@scalar/openapi-parser`, `@scalar/openapi-upgrader`, `ajv`, `ajv-formats`,
      `better-sqlite3`, `yaml`, `commander` (+ `@types/better-sqlite3`), and verify `npm audit`
      reports no new advisories.
- [X] T002 [P] Add the module boundary test in `tests/unit/architecture.test.ts`: assert that no
      file under `src/cli/` imports from `src/mock/`, `src/store/` or `src/spec/`. This is the
      machine-checkable half of FR-019 and it must fail before the boundary exists.
- [X] T003 [P] Add the `bin` entry (`ustdy` → `dist/cli/index.js`) and scripts to `package.json`,
      and confirm `npm run build && node dist/cli/index.js --help` exits 0.

---

## Phase 2: Foundational (blocking prerequisites)

**Purpose**: the shared spine — document loading, the derived model, configuration, the store seam
and error/logging plumbing. Nothing user-visible works until these exist, which is why they are one
phase rather than distributed across the stories.

**⚠️ CRITICAL**: no user story work begins until this phase is complete.

- [X] T004 [P] Define the error taxonomy in `src/errors.ts`: one class per refusal cause the spec
      names (document unreadable, document undereferenceable, empty selection, unknown operation
      in selection, config invalid, config contradicts document, store unwritable, port in use).
      Each carries the offending value so the message can name it (FR-004, FR-021).
- [X] T005 [P] Test for T004 in `tests/unit/errors.test.ts`: each error's message contains the
      offending value. Fails first.
- [X] T006 Define the config JSON Schema in `src/config/schema.ts` by importing
      `specs/001-slice-1-core/contracts/config.schema.yaml` as the single source (parse it at
      build time or inline it by generated copy — decide here and record why), then implement
      `loadConfig()` in `src/config/load.ts`: read YAML, validate against the schema, apply the
      documented defaults, refuse on unknown keys.
- [X] T007 Test for T006 in `tests/unit/config.test.ts`: defaults applied; unknown key refused;
      a config whose `operations` is empty refused; a spec-relative path resolved relative to the
      config file, not the process cwd. Fails first.
- [X] T008 Define the `Store` interface in `src/store/index.ts` — open/close, ensure table for a
      resource, insert/readOne/list/update/delete, wipe, removeByOrigin, request-log append and
      query, meta get/set, next identity — and nothing else. This is the principle-X seam; it must
      not leak SQL anywhere else.
- [X] T009 Implement `src/store/schema.ts` (DDL per `data-model.md`) and `src/store/sqlite.ts`
      against T008.
- [X] T010 [P] Test for T008/T009 in `tests/unit/store.test.ts` against a real temp SQLite file:
      round-trip a record, list it, wipe it, read the meta table; assert the DDL matches
      `data-model.md` (column names and the `origin` CHECK constraint).
- [X] T011 Implement `src/spec/load.ts`: read the document from a path or URL, dereference
      (including external refs), upconvert 3.0 → 3.1, and extract the spec's own version + a
      content hash for `_understudy_meta`. No network access except a URL the user supplied
      (FR-001, FR-022).
- [X] T012 Implement `src/spec/operations.ts`: resolve the configured `operations` entries against
      the document — each entry by `METHOD /path` **or** by `operationId`, the two forms being peers
      with no precedence (A2) — producing the live set and the not-implemented set, and recording
      which form resolved each entry for the startup report; refuse the whole selection if any entry
      does not exist (FR-002, FR-004, FR-023).
- [X] T013 [P] Test for T011/T012 in `tests/unit/spec-load.test.ts`: a fixture document with an
      external `$ref` resolves; a 3.0 document and its 3.1 twin produce the same operations; an
      unknown selection entry is refused by name; a URL spec is never fetched when the path form
      was given (assert no network call).
- [X] T014 Implement `src/spec/resources.ts`: the resource-derivation and relationship-inference
      rules enumerated in `plan.md` → "Derivation rules", each relationship carrying its
      `evidence` (`configured` | `extension` | `convention` | `nesting`).
- [X] T015 [P] Test for T014 in `tests/unit/resources.test.ts` with fixture documents that exercise
      each evidence rule *and* the ambiguity path (a path that matches no resource; an operation
      with no declared 2xx schema). Assert the reported entity name, id field and id type.
- [X] T016 Implement `src/spec/report.ts`: build the `StartupReport` data structure from the derived
      model (live ops, not-selected ops, resources, relationships with evidence, ambiguities).
- [X] T017 Implement `src/logging.ts`: structured (JSON-line) logs to stdout with a level, and a
      human-readable renderer for the startup report. Both from the same data (FR-024).

**Checkpoint**: the tool can load a document, validate a config, derive resources, and open a store
— with no HTTP server yet. `tests/unit` is green.

---

## Phase 3: User Story 1 — a spec-selected CRUD surface that behaves like the real service (P1) 🎯 MVP

**Goal**: the product itself. Selected operations answer contract-validly and persist; everything
else answers "not implemented in this mock", visibly distinct from "no such record".

**Independent Test**: with the fixture document from `quickstart.md` §1 and the config from §2,
create a record, restart the process, read it back; call a non-selected operation and get 501.

- [X] T018 [P] [US1] Write the fixture document `tests/fixtures/inventory-api.yaml` (one collection,
      five selected operations, one deliberately unselected operation, a declared 2xx and the
      declared error statuses) and a second fixture exercising a paging style.
- [X] T019 [P] [US1] Contract test in `tests/contract/crud.test.ts` that drives the mock over HTTP
      and asserts every response against `tests/fixtures/inventory-api.yaml` — the SC-003 suite.
      Fails first.
- [X] T020 [P] [US1] Integration test in `tests/integration/persistence.test.ts`: create → restart
      the process → read back (SC-002). Fails first. Also assert the machine-checked form of
      constitution IV: after a full CRUD workout, **every** row in the SQLite file has
      `origin='runtime'` — the CHECK constraint alone permits all four values, so the invariant
      needs a test, not a comment.
- [X] T021 [P] [US1] Integration test in `tests/integration/not-implemented.test.ts`: a
      non-selected operation answers with `NOT_IMPLEMENTED` — the single exported constant, value
      **501** (RFC 9110 §15.6.2) — and the status is never the document's declared not-found status
      (SC-004, FR-003). The body matches the tool's own `NotImplementedBody` schema and names the
      unimplemented operation. Fails first. Assert against the constant, never a bare `501` literal.
- [X] T022 [US1] Implement `src/mock/validate.ts`: compile an Ajv validator per operation from the
      dereferenced document (draft 2020-12), and validate request bodies, parameters and headers.
- [X] T023 [US1] Implement `src/mock/errors.ts`: render the document's *declared* error responses
      for that operation, with the declared status and body shape (FR-005, FR-008).
- [X] T024 [US1] Implement `src/mock/crud.ts`: create / read / list / update / delete over the
      `Store` interface, using the derived resource model; PUT replaces, PATCH merges (FR-006);
      allocate identities per `data-model.md` §"Identity allocation" (FR-011); set `origin` and
      the timestamps; return the 2xx status the document declares (FR-005, FR-009).
- [X] T025 [US1] Implement `src/mock/list.ts`: filtering, sorting and paging over the declared
      query parameters, in the declared paging style; where none is declared, return the full
      collection (FR-007). Prove paging does not load the collection into memory.
- [X] T026 [US1] Implement `src/mock/route.ts` and `src/index.ts`: build the Fastify instance from
      the derived model, match a request against the live set, dispatch to T024/T025, answer the
      exported `NOT_IMPLEMENTED` constant (501) for a known-but-unselected operation with the
      `NotImplementedBody` shape, and the normal HTTP not-found response for a path the document does
      not declare at all (no such operation exists to declare one). Never hard-code the 501 literal
      in this file; reference the exported constant so there is one home for the value.
      Added by the 2026-10-04 amendment (A1): the response code and body for the not-implemented
      answer are pinned to one exported constant and one schema instead of living only in prose.
- [X] T027 [US1] Wire the startup report: refuse to start on any T004 error, otherwise log the
      report (FR-023). Re-run T019–T021; they must now pass.

**Checkpoint**: the mock serves CRUD, persists, validates, and answers 501 distinctly. MVP.

---

## Phase 4: User Story 2 — control the mock without touching its database (P1)

**Goal**: the control plane, and the seam every later slice plugs into.

**Independent Test**: drive health → create → list → reset → teardown entirely over HTTP.

- [X] T028 [P] [US2] Integration test in `tests/integration/control.test.ts` for `quickstart.md`
      §7: health reports store reachability; reset wipes and leaves the mock answering; operations
      lists both sets; requests filters; teardown releases the port; a **second** teardown is not
      destructive; an unknown control path under the prefix returns the control 404 **with the
      declared `ControlError` body** and never reaches the mocked surface; a malformed reset body
      returns the declared 400 `ControlError` (SC-002, FR-012–FR-017). Fails first.
- [X] T029 [US2] Implement `src/control/routes.ts`: the five operations of
      `contracts/control-api.openapi.yaml`, each answering exactly the documented shape.
- [X] T030 [US2] Implement `src/control/openapi.ts`: serve `contracts/control-api.openapi.yaml` at
      the prefix's `openapi.json` (FR-018), and add a test asserting the served document equals
      the checked-in file byte for byte — a *drift* check, not a conformance tautology.
- [X] T031 [US2] Implement `src/control/server.ts`: mount the control plane on its own Fastify
      instance, on the same port under the reserved prefix or on `control.port` when configured;
      record every mocked-surface request into `_requests` with live/status/duration (FR-016).
- [X] T032 [US2] Implement the `wipe` reset mode through `Store.removeByOrigin` + resetting the
      identity counters (FR-014), and refuse `mode` values not in the enum.
- [X] T033 [US2] Implement teardown (`POST /teardown`): stop accepting, drain, release the port,
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

---

## Phase 8: Convergence

Appended by the convergence pass over Phase 1 + 2 (reviewer round 1, findings F1–F3). Append-only:
no existing task above is modified.

- [X] T046 Report a `no-list-parameters` ambiguity when a live list operation declares no query
      parameters, and render each resource's declared list parameters, so FR-007's "say so in the
      startup report" is implemented rather than silent (`partial`). Source: FR-007,
      plan.md → "Derivation rules" → List semantics, data-model.md §1 (ambiguity list),
      quickstart.md §3 (a document with no declared list parameters). Test added to
      `tests/unit/resources.test.ts` before the code (red → green).
- [X] T047 Rename the identity counter meta key from `identity:<resource>` to the documented
      `id_seq:<resource>`, so the stored format matches data-model.md §2/§3 that Phase 4 (T032,
      wipe-reset) and slices 2–3 will read (`contradicts`). The doc is the frozen stored format; the
      code is renamed to it. Source: data-model.md §2/§3. Test added to `tests/unit/store.test.ts`
      before the code (red → green).
- [ ] T048 Contract correction (needs coordinator approval — do NOT edit
      `contracts/config.schema.yaml` unilaterally): widen the `operations` item pattern so an
      `operationId` containing a hyphen or a dot (e.g. `get-widgets`, `api.getWidgets`) is accepted,
      and align the `signing`/`clock` descriptions (currently "Setting it has no effect yet") with
      the implemented refuse-loudly-on-presence behaviour (`contradicts`, spec-side). Source: FR-002
      vs `contracts/config.schema.yaml` `operations` item pattern; constitution IX. Routes through
      the coordinator/PR-#2 gate because it amends a reviewed contract.
- [X] T049 Read list parameters declared at the **Path Item Object** level, not only on the
      operation (`contradicts`). OpenAPI "Fixed Fields" makes a path item's `parameters` inherited
      by every operation on the path, so T046's rule false-fired on a document that declares shared
      paging/sort at path level: it published a FALSE `no-list-parameters` ambiguity ("every list
      request returns the full collection unpaged and unsorted") and left `Resource.listParams`
      empty — the field Phase 3's list handling reads. Fixed by merging path-level and
      operation-level query parameters in `listParamsOf`/`deriveResource` (operation level wins on
      a shared name), and the report no longer claims a missing paging style when one is declared at
      either level. Source: FR-007, plan.md → "Derivation rules" → List semantics, OpenAPI
      Specification → Path Item Object. Fixture `tests/fixtures/path-params-api.yaml` (path-level and
      mixed-level declarations) added to `tests/unit/resources.test.ts` before the code
      (red → green).

---

## Amendment 2026-10-04 — A1: pin the not-implemented response

**Approved by:** the project owner (human). **Recorded by:** the coordinator, before Phase 3 was dispatched.

**Why.** The not-implemented answer was written in prose in about eight artefacts (`docs/01` A3 and
`docs/01` FR-002, `docs/02`, `docs/03`, `spec.md` FR-002/FR-003, `quickstart.md` §5, `data-model.md`
`_requests.live`, `contracts/config.schema.yaml`), but the value `501` had no single machine-checked
home: the only test that would catch a drift (T021) did not exist yet, and nothing specified the
**body**. Nothing in the tool therefore *enforced* what eight documents *asserted*. This amendment
is narrow — it changes no requirement — but it removes that duplication-of-authority.

**What this amends** (the only two pre-existing tasks touched; the rest of Phase 3 is unchanged):

| Task | Was | Now |
|---|---|---|
| T021 | "returns 501 with the operation named" | asserts the exported `NOT_IMPLEMENTED` constant (501) **and** the `NotImplementedBody` shape; never a bare `501` literal |
| T026 | "answer 501 … and 404 for an unknown path" | answer `NOT_IMPLEMENTED` for a known-but-unselected operation; the normal not-found response for a path the document does not declare at all |

**The pinned decisions** (the whole point of the amendment — an implementer must not have to
re-derive these):

1. **Status:** `501 Not Implemented` (RFC 9110 §15.6.2), exported as the constant `NOT_IMPLEMENTED`.
   Note the honest caveat: RFC 9110 scopes 501 to an *unrecognised request method*, whereas here both
   method and path are recognised and it is the *operation selection* that excludes it. 501 is the
   conventional choice for this case (it is what test doubles use for disabled routes) and is kept
   deliberately; alternatives were rejected — 404 collides with record-not-found and fails SC-004,
   405 needs an `Allow` header and misstates the cause, 503 implies temporary unavailability.
2. **Body:** a new `NotImplementedBody` schema, shaped `{ error, method, path, operationId?,
   detail }`, where `detail` names the unimplemented operation. This lives in the tool's OWN contract
   (`contracts/mock-errors.schema.yaml`), not in the mocked surface: the mocked surface is derived
   from the user's OpenAPI document and must not gain tool-specific schemas.
3. **Distinguishability (the actual MUST):** FR-003 and SC-004 require only that the not-implemented
   answer differ from the document's *declared* not-found answer. That is asserted against the
   fixture's declared status, **not** against a hard-coded 404 — a document may declare something
   other than 404, and T018's fixture must declare one explicitly so the assertion is meaningful.
4. **Single home:** the constant and the schema are the one source of the value. Prose in the other
   artefacts stays as documentation; it must not be the enforcement point.

**Constitutional basis.** This is a PATCH-class change: no principle is removed or redefined, and no
new section of guidance is added — it hardens an existing MUST (FR-003/SC-004) and the Small,
Documented Config Surface principle's spirit (a value the product depends on should have one
home, documented). Per the constitution's Governance section, amendments extend and never rewrite;
nothing above this line was replaced, and the two edited tasks keep their identifying numbers and
their surrounding text.

**Scope fence for the implementer.** This amendment authorises T021/T026 to introduce
`NOT_IMPLEMENTED` and `NotImplementedBody` **and nothing else**. It does not authorise: adding any
tool-owned schema to the mocked surface; changing any other FR or SC; or editing
`contracts/config.schema.yaml` (that remains open task T048, coordinator-routed).

---

## Phase 8: Convergence (Phase 3)

Appended by the convergence pass over Phase 3 (reviewer round 1, findings F-A/F-B/F-C).
Append-only: no existing task above is modified.

- [X] T050 Honour **both** declared update styles (FR-006, `contradicts`). `deriveResource` kept a
      single `update` slot (`findMethod(instanceOps, "PATCH") ?? findMethod(instanceOps, "PUT")`),
      so when a document lived PATCH *and* PUT on one instance path, PUT was live but unbound and
      `route.ts`'s no-CRUD fallback answered a silent `200 {}` that changed nothing (FR-005/FR-006
      edge case "PUT against a record that does not exist"). Fixed by binding PATCH → `update`
      (merge) and PUT → `replace` (replace) as separate `ResourceOperations` slots, deciding the
      style from the **bound operation** in `crud.updateRecord(mode)`, and leaving `Resource.updateMode`
      unset when both are declared (data-model.md §1 has no single value for that case). The same
      change makes a live operation the model cannot bind (a route with no resource) refuse loudly
      with the `NOT_IMPLEMENTED` constant and an operation-naming body (constitution VI) instead of
      the silent empty 2xx. Source: FR-005, FR-006, spec.md edge cases, constitution VI. Fixture
      `tests/fixtures/update-styles-api.yaml` and `tests/integration/update-styles.test.ts` added
      before the code (red → green).
- [X] T051 Allocate a `string` identity that **satisfies the declared `pattern`** (FR-011,
      `contradicts`). The identity counter was stringified verbatim, so `idType: string` with
      `pattern: ^W-[0-9]{6}$` allocated `"100000"`, which does not match the document — a mock
      differing from the real service in *shape*. Fixed by `src/spec/identity.ts`, a bounded
      pattern-to-value generator (literal prefix/suffix around digit/letter runs with fixed
      quantifiers; the measured identity shapes in docs/05-target-apis.md §1) whose output is
      verified against the declared pattern before use; an unsupported pattern is reported as the
      `identity-pattern-unsupported` ambiguity and falls back to an opaque short id, never a
      non-conforming counter. Source: FR-011, data-model.md §"Identity allocation", constitution VI.
      Fixture `tests/fixtures/string-id-api.yaml`, `tests/integration/string-identity.test.ts` and
      `tests/unit/identity.test.ts` added before the code (red → green).
- [X] T052 Honour a **cursor token** as an opaque start-after marker, with or without a companion
      limit (FR-007, `contradicts`). `pagingStyle` only engaged the cursor branch when a limit was
      also present, and the target API's measured cursor spelling (`paginationToken`, docs/05 §1)
      was classified as a *filter*, so a conforming client's page request answered `[]` — data loss,
      not cosmetics; with a limit the token did not move the window. Fixed by classifying the
      token spellings as `paging`, treating a token as a paging instruction on its own, resolving it
      to a start-after window in SQLite (`Store.listPaged` `after`, a `ROW_NUMBER()` window so the
      page is still assembled by the database), and answering the operation's declared client error
      for a token that names no record rather than a silent empty page. Source: FR-007,
      docs/05-target-apis.md §1 (Q4 pagination). Fixture `tests/fixtures/cursor-api.yaml` and
      `tests/integration/cursor.test.ts` added before the code (red → green).
- [X] T053 Bind the cursor-window SQL placeholders in **text order** (FR-007, `contradicts`).
      `SqliteStore.listPaged`'s cursor branch built `[...filterBindings, ...orderBindings,
      query.after, ...orderBindings]`, but the SQL text orders placeholders `OVER (ORDER BY
      <sorts>)`, then `WHERE <filters>`, then the cursor `id = ?`: the filter and sort groups were
      swapped and every sort value was duplicated, so any cursor request that ALSO carried the
      document's declared `sort` answered an undeclared `500 "Too many parameter values were
      provided"` — the F-C fix's own failure mode (data loss dressed up as an error), one request
      shape away from the shipped fixture. Fixed by binding in text order (`[...orderBindings,
      ...filterBindings, query.after]`, mirroring the correctly-ordered non-cursor branch).
      Fixture `tests/fixtures/cursor-api.yaml` gained declared `sort` and `group` parameters;
      `tests/integration/cursor.test.ts` gained two tests asserting window CONTENT under the sort
      and under filter+sort+cursor (not just status), added before the code (red → green). The
      pre-existing cursor tests declared no sort, which is why the corruption went unseen. Source:
      FR-007, plan.md → "Derivation rules" → List semantics. Deferred: **F-E**, `src/spec/identity.ts`
      maps open quantifiers (`+`/`*`/`{n,}`) to exactly one unit — `^W-[0-9]+$` silently allocates
      `W-0..W-9` then 500 `UNIQUE` at create #11 with `ambiguities: []` (expected
      `identity-pattern-unsupported` per VI); owner: engineer, next converge.
