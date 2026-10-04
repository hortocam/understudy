# Feature Specification: Slice 1 — Core CRUD Mock

**Feature Branch**: `001-slice-1-core`

**Created**: 2026-10-03

**Status**: Draft

**Input**: Handoff package `docs/` (the write-up and beginning specs). Slice 1 of seven; source
material is `docs/01-product-spec.md` §4 Epics A & B and §5 FR-001–FR-006, FR-021 (wipe), plus
`docs/04-phasing-and-open-questions.md` slice table row 1 and `docs/03-config-reference.md` for
the configuration shape.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A spec-selected CRUD surface that behaves like the real service (Priority: P1)

An integration developer points the tool at the OpenAPI document for a third-party service, lists
the operations they want live, and starts the mock. Requests to those operations create, read,
list, update and delete records that **persist** — a create survives a restart and shows up in
later lists and reads. Everything they did not ask for answers clearly that this operation is not
implemented in the mock, in a way they can distinguish from "the record is not there".

**Why this priority**: it is the product. Every later slice (data layer, import/export, events,
actions) decorates this core; without it there is nothing to decorate. It is also independently
demonstrable: the developer can build and test against it without any other slice existing.

**Independent Test**: Start the mock against a small fixture OpenAPI document with POST / GET /
GET-by-id / PATCH / DELETE enabled on one collection. Create a record, restart the process, read
it back. Read an operation that was not selected and get a "not implemented in mock" answer
distinct from a missing-record answer.

**Acceptance Scenarios**:

1. **Given** an OpenAPI document with a collection and its instance paths, **When** I start the
   mock with only POST, GET, GET-by-id, PATCH and DELETE selected, **Then** each of those answers
   with a body and status that conform to the document.
2. **Given** a running mock with a record I created, **When** I stop and restart the process,
   **Then** reading that record returns the same representation, and listing the collection
   includes it.
3. **Given** a collection I created three records in, **When** I read the collection, **Then**
   all three appear; **When** I filter or page it using the parameters the document declares,
   **Then** the result reflects the filter and the declared paging style.
4. **Given** an operation I did **not** select, **When** I call it, **Then** the answer identifies
   the unimplemented operation and is distinguishable from a missing-record answer.
5. **Given** a request body that violates the document's schema, **When** I send it, **Then** the
   answer is the error the document declares for that case (not a generic crash or a 200).

---

### User Story 2 - Control the mock without touching its database (Priority: P1)

A test author or QA operator needs to put the mock back to a known state and inspect it: reset it,
watch it come alive, list which operations are live, see the requests that arrived, and shut it
down cleanly — all from a script, without opening the database file or restarting the process.

**Why this priority**: a mock that cannot be reset between tests cannot back a CI suite, which is
one of the three named user types. It is also the seam every later slice's control features
(import, export, snapshots, actions, webhooks) plug into, so it must exist from slice 1.

**Independent Test**: Reset a mock that has runtime data; confirm the reset is reported, the state
is gone, the mock still answers, and the lifecycle (health → work → reset → work → teardown) is
drivable entirely over HTTP.

**Acceptance Scenarios**:

1. **Given** a running mock, **When** I ask the control surface for its health, **Then** the
   answer states the mock is alive and whether the underlying store is reachable.
2. **Given** a mock holding records created over its API, **When** I reset it to a wiped state,
   **Then** those records are gone, and the reset is reported as having succeeded.
3. **Given** a running mock, **When** I ask which operations are live, **Then** I get the list
   that matches what I selected at startup.
4. **Given** a mock that has served requests, **When** I ask for the request log, **Then** it
   reports the requests that arrived and I can filter it.
5. **Given** I am finished, **When** I ask the mock to tear down, **Then** it stops serving and
   releases the port — and tearing down again does not fail destructively.

---

### User Story 3 - The same control from the command line (Priority: P2)

The same developer and test author would rather not hand-write HTTP calls in a script. A command
line client gives them the same abilities — start, stop, reset, list operations — as ordinary
commands.

**Why this priority**: it is the ergonomic half of the control surface (Epic B2) and what makes
the tool pleasant in a terminal and in CI. It is deliberately P2: everything it offers is already
available over HTTP in Story 2, so the tool is fully usable before the CLI exists.

**Independent Test**: Perform the whole lifecycle from Stories 1–2 using only command-line
invocations, including selecting operations at start and resetting, and confirm each outcome
matches what the control surface returns.

**Acceptance Scenarios**:

1. **Given** a configured mock project, **When** I start it from the command line with a selection
   of operations, **Then** it serves those operations and I can stop it from the command line.
2. **Given** a running mock, **When** I run a reset from the command line, **Then** the effect and
   the reported result are exactly what the control surface returns for the same request.
3. **Given** a running mock, **When** I ask the command line which operations are enabled, **Then**
   it reports the same list the control surface reports.

---

### User Story 4 - Startup tells me what it understood (Priority: P3)

A developer who has just pointed the tool at a real vendor's specification wants to know what the
tool made of it before they trust a single response: which operations it made live, and — from
this slice — which entities it derived and which relationships it could not resolve confidently.

**Why this priority**: it is the first line of defence against the product's core risk (the mock
quietly differing from the real service) and how the developer knows what to pin in configuration.
It is P3 because the tool works without it; it is what makes the tool honest.

**Independent Test**: Start against a fixture document and confirm the startup output lists the
live operations, the entities derived, and any relationship it could not determine, in a form a
human can act on.

**Acceptance Scenarios**:

1. **Given** a document and a selection of operations, **When** the mock starts, **Then** it
   reports the operations that are live and the ones that were not selected.
2. **Given** a document whose schemas imply relationships, **When** the mock starts, **Then** the
   report names the entities it derived and the relationships it inferred, and calls out any it
   could not determine rather than silently choosing.

---

### Edge Cases

- **Spec cannot be read or is invalid** (bad path, malformed document, unresolvable `$ref`): the
  tool fails fast and states precisely what it could not parse; it does not start a half-alive
  mock.
- **No operations selected**, or a selection naming an operation the document does not contain:
  reported at startup; an empty selection is refused with an explanation rather than serving
  nothing.
- **Two live operations share a path** but differ by method: both are live and routed
  independently.
- **A path parameter that is not a simple identity** (nested sub-resources, composite keys): the
  tool must not silently mis-derive an entity — it reports the ambiguity.
- **PATCH with an empty body**, and **PATCH with `null` to clear a field**: both must be
  meaningful and match declared behaviour (a merge with nothing to merge versus an explicit clear).
- **PUT against a record that does not exist**: answered per the document (create or not-found),
  not by guessing.
- ~~**DELETE of a record referenced by another record**~~ **Deferred to slice 2.** Slice 1
  derives relationships only to report them and enforces no foreign keys (see `data-model.md`
  → "Deliberately absent"), so a delete cannot be refused for a reference. Slice 2 adds
  constraints with generation, where orphans become possible; the behaviour then is whatever
  configuration says for that relationship (restrict → conflict, cascade, or set-null), and the
  message names the relationship.
- **A record is deleted twice**: the second answer identifies it as missing; the store is not
  corrupted.
- **Concurrent create/list traffic**: list results do not show half-written records.
- **IDs**: a record's identity is produced in a way the real service would accept, and cannot
  collide with identities that a later slice supplies from fixtures.
- **A request arrives under the control surface's reserved prefix but is not a control
  operation**: answered as an unknown control operation, never routed into the mocked surface.
- **The configured store location is missing or not writable**: the mock reports the problem and
  does not start, rather than failing on the first request.
- **The port is already in use**: reported clearly at startup.
- **A very large list** (a collection with many records) is still answerable and paged, and does
  not exhaust memory.
- **A response the document does not describe** (an operation with no declared 2xx schema): the
  tool does not invent one; the behaviour is reported at startup.

## Requirements *(mandatory)*

### Functional Requirements

**Spec ingestion and operation selection**

- **FR-001**: The tool MUST load an OpenAPI 3.0 or 3.1 document from a local file or a URL and
  MUST resolve internal and external `$ref`s before using it.
- **FR-002**: The tool MUST accept a selection of operations — by `operationId`, or by
  `METHOD /path` when no `operationId` exists — and MUST make exactly those operations live.
- **FR-003**: Every operation that is *not* selected MUST answer in a way that identifies it as
  "not implemented in this mock", and that answer MUST be distinguishable from a record-not-found
  answer.
- **FR-004**: The tool MUST refuse to start, with an explicit report, when the document cannot be
  read, cannot be dereferenced, or when the selection is empty or names operations the document
  does not contain.

**Generic CRUD**

- **FR-005**: For a selected collection the tool MUST serve create, read-one, list, update and
  delete with the semantics the document declares for that operation, returning the status codes
  the document declares for success and for its declared error cases (created, empty, not found,
  conflict, invalid).
- **FR-006**: Update MUST honour both declared styles: a merge-style partial update applying only
  the fields present, and a replace-style update replacing the whole representation. Which style
  applies MUST follow the operation as the document declares it.
- **FR-007**: List operations MUST honour the filtering, sorting and paging parameters the
  document declares, including its paging style. Where the document declares none, the tool MUST
  behave predictably and say so in the startup report.
- **FR-008**: The tool MUST validate incoming requests (body, parameters, headers) against the
  document's schemas and MUST reject invalid requests with the error the document declares, rather
  than accepting them or failing generically.
- **FR-009**: Responses MUST be produced in the shape the document declares for that operation —
  the same field names, types and required fields — and MUST NOT include fields the document does
  not declare.
- **FR-010**: Records MUST persist across process restarts until explicitly reset or torn down.
- **FR-011**: Record identity MUST be produced in a form valid for the field the document
  declares, and MUST NOT conflict with identities reserved for fixture-supplied records in later
  slices.

**Control surface**

- **FR-012**: The tool MUST expose a control surface under a reserved prefix that cannot collide
  with the mocked API, and that prefix MUST be configurable.
- **FR-013**: The control surface MUST report health, including whether the underlying store is
  reachable.
- **FR-014**: The control surface MUST reset the mock. Slice 1 MUST support a full wipe removing
  all data written over the mock's API while leaving the mock running and answering. The wipe
  MAY be scoped to a subset of entities named in the request; an unscoped wipe removes
  everything.
- **FR-015**: The control surface MUST list the operations that are live and those that are not.
- **FR-016**: The control surface MUST record the requests that arrived and MUST serve that log
  with filtering.
- **FR-017**: The control surface MUST tear down the mock, releasing its port, and a repeated
  teardown MUST NOT be destructive.
- **FR-018**: The control surface MUST be described by an OpenAPI document of its own and MUST
  serve that description.

**Command line**

- **FR-019**: A command-line client MUST offer every slice-1 control capability — start, stop,
  reset, list operations, and read the request log — and MUST contain **no logic the control
  surface does not have**: each command is a client of the control surface. The enumeration
  here is exhaustive for slice 1: a capability the control surface gains in a later slice
  obliges the CLI to expose it too.
- **FR-020**: The command line MUST accept the operation selection at start, and the configuration
  file path, as arguments or environment, with no absolute host paths baked into shipped code.

**Configuration and reporting**

- **FR-021**: A single project configuration file MUST state the spec source, the selected
  operations, the server bind/port, the control prefix (and optional separate control port), and
  the store location.
- **FR-022**: The tool MUST NOT make any outbound network call other than fetching a spec the user
  pointed it at by URL.
- **FR-023**: On startup the tool MUST print a report listing the operations made live, the
  operations not selected, the entities derived from the live operations, the relationships it
  inferred, and every ambiguity or undetermined relationship it could not resolve confidently.
- **FR-024**: The startup report and any refusal to start MUST be readable by a human without
  reading source code, and MUST also be emitted as structured logs.

### Key Entities

- **Operation selection**: the user's declaration of which operations from the document are live;
  the unit the developer reasons about and the thing the not-implemented path protects.
- **Live operation**: a selected operation bound to a method and path, able to match a request and
  produce a contract-valid answer.
- **Entity (derived)**: a collection recognised from the live operations (a collection path and
  its instance path collapse to one entity). Slice 1 derives entities to give CRUD its shape and
  to report them; it does **not** generate data for them (slice 2).
- **Relationship (derived)**: a link from one entity to another, inferred from configuration, a
  spec extension, a naming convention, or nesting — the thing the startup report must show and the
  thing slice 2's generation depends on.
- **Record**: one stored item of an entity: an identity, its stored representation, an origin tag
  (always "written over the API" in slice 1), and created/updated times. The unit CRUD operates on.
- **Store**: the persistent home of records, reachable and resettable, isolated per mock instance.
- **Control operation**: one capability of the control surface (health, reset, operations, request
  log, teardown).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A developer can go from an OpenAPI document to a running, contract-valid,
  spec-selected mock in **under 5 minutes**, without writing any per-endpoint handler.
- **SC-002**: A record created over the mock's API is still readable after a restart of the
  process (**100% of runs**), and a wipe reset removes **100%** of records written over the API
  while the mock remains answering.
- **SC-003**: For every selected operation a conforming request receives a conforming response;
  for every request that violates the document the declared error is returned. Measured by a
  contract-conformance suite over the fixture document passing with **zero** unexpected status
  codes.
- **SC-004**: Calling an operation that was not selected returns the not-implemented answer in
  **100%** of cases, and its status is never the same as the record-not-found answer.
- **SC-005**: The lifecycle of health → create → list → reset → create → teardown is drivable end
  to end **from the command line alone**, with no HTTP call written by hand, and each command's
  output agrees with the control surface's own answer.
- **SC-006**: The startup report names every live operation, every entity derived, and every
  relationship it could not resolve confidently, such that a reader can decide what to pin in
  configuration without reading source.
- **SC-007**: Two mock instances started with different configuration (distinct ports and store
  locations) run side by side with **no** shared state and no cross-talk.
- **SC-008**: No outbound network traffic occurs beyond fetching a URL-supplied spec.

## Assumptions

- **Stack (binding for this project; recorded in the constitution's Additional Constraints):**
  TypeScript on Node.js 22+, ES modules, Fastify for both surfaces (separate plugin instances,
  optionally separate ports), Ajv for schema validation, SQLite behind a storage interface, and a
  commander-based CLI. The document-parsing library is chosen in `plan.md` (research step) between
  `@apidevtools/swagger-parser` and `@scalar/openapi-parser`.
- **Storage is behind an interface from day one** even though only one implementation exists,
  because the constitution's "Additive Evolution" principle (X) requires the seam before the
  feature that needs it.
- **"Store" here means the mock's own persistence**, using the term deliberately from `docs/02`.
- **"Reset" in slice 1 means wipe.** The richer modes (baseline, runtime-only) need the data layer
  and import/export (slices 2–3), so they are deferred; the reset mode exists as a parameter whose
  only implemented value is the wipe.
- **Entities are derived and reported, not populated.** Slice 1 generates nothing and imports
  nothing: a freshly started mock has an empty store. The origin tag exists on every record and is
  always "written over the API" here, because the other three origins arrive in slices 2–3.
- **The mocked surface is unauthenticated in slice 1.** Whether consumers must present an auth
  header is an open question in the handoff (`docs/04` Q12) and is explicitly deferred.
- **Paging style detection** covers the three styles the handoff names (offset/limit, page/size,
  cursor). Slice 1 detects what the document declares; if it declares none, the tool returns the
  full collection and says so in the startup report rather than inventing a default silently.
- **The real POS and marketplace documents are not available yet.** Slice-1 work uses fixture
  documents built for the purpose; validating inference against a real vendor document is a spike
  scheduled in slice 2 (`docs/04` Q6), not a slice-1 deliverable.
- **Conformance tooling** (Specmatic or equivalent) is wired in slice 7; slice 1 proves conformance
  with its own contract tests against the fixture document and documents the recipe.
- **Out of scope for slice 1** (explicitly): data generation and configuration layers, import and
  export, snapshots, events and webhooks, actions and simulation, webhook signing, a virtual
  clock, tenant scoping, GraphQL/gRPC/SOAP, and any GUI.
- **One recorded deviation from the handoff.** `docs/01` FR-006 writes the default reserved prefix
  with a trailing slash (`/__understudy/`); this spec's default is `/__understudy`, without one.
  The prefix is composed as `prefix + path`, so a trailing slash would produce
  `/__understudy//health`. `docs/02`, `docs/03` and `docs/04` all use the no-slash form, making
  `docs/01` the outlier; the no-slash form is adopted deliberately, and this note is the record
  of the deviation rather than a silent divergence from the source material.

## Traceability: handoff FR numbering → this specification

`docs/01-product-spec.md` numbers the product's requirements FR-001…FR-023. This specification
introduces its own FR-001…FR-024, and the two ranges **overlap while meaning different things** —
so the same identifier cannot be read across the two documents without this table. It is the
auditable record of what slice 1 carried, narrowed, or deferred.

| `docs/01` | Slice 1 status | This spec |
|---|---|---|
| FR-001 Load 3.0/3.1, resolve `$ref`s | carried | FR-001 |
| FR-002 Enable by `operationId` or `METHOD /path`; others 501 | carried | FR-002, FR-003 |
| FR-003 Validate requests and responses | carried | FR-008, FR-009 |
| FR-004 Generic CRUD with spec-defined status codes | carried | FR-005, FR-006 |
| FR-005 Persist in SQLite behind an interface | carried | FR-010 (+ `Store` seam, `plan.md`) |
| FR-006 Control API under a reserved prefix | **narrowed** to health/reset/operations/requests/teardown | FR-012–FR-018 |
| FR-007 CLI wrapping the control API | carried | FR-019, FR-020 |
| FR-008 Separate static/dynamic/imports/behaviour config | deferred (config *shape* only) | Assumptions; slice 2 |
| FR-009 Tag every row with `origin` | carried as a seam, one origin in use | Assumptions; `data-model.md` §2 |
| FR-010 Field precedence chain and FK inference | deferred | slice 2 (`specs/002-data-layer`) |
| FR-011 Absolute and per-parent counts | deferred | slice 2 |
| FR-012 Deterministic generation from a seed | deferred | slice 2 |
| FR-013 Reserved identity ranges per entity | **partly carried** — reservation now, fixture overlap checks in slice 2 | FR-011 |
| FR-014 Mapping-file import, export by origin | deferred | slice 3 |
| FR-015 Emit domain events | deferred | slice 4 |
| FR-016 Webhook targets, subscriptions, templates, retries | deferred | slice 4 |
| FR-017 Webhook fault injection | deferred | slice 6 |
| FR-018 Actions with typed params and steps | deferred | slice 5 |
| FR-019 Action triggers | deferred | slice 5 |
| FR-020 `writes: actions-only` entities | deferred | slice 5 |
| FR-021 Reset modes: baseline, runtime-only, wipe, per-entity | **narrowed** to wipe (entity-scoping optional) | FR-014 |
| FR-022 Request log with filtering | carried | FR-016 |
| FR-023 Webhook HMAC signing | deferred | slice 6 |

**FRs in this spec with no inherited *content* slot** — note this is a statement about meaning, not
about numbering: spec FR-021 and FR-023 share numbers with `docs/01` FR-021 and FR-023, and the
table above maps those two rows, but their subjects differ (the table's rows cover the handoff's
reset-modes and webhook-signing requirements; the spec's FR-021 and FR-023 are the config-file
contract and the startup report). The requirements below are ones slice 1 needs that the handoff
states only in prose or not at all: FR-004 (refuse to start on an unusable document or selection),
FR-007 (list parameter handling), FR-011 (identity allocation), FR-017 (idempotent teardown),
FR-018 (the control plane describes itself), FR-021 (the config-file contract), FR-023 and FR-024
(the startup report and structured logging). They trace to the spec's own edge cases and to
constitution principle VI.

## Dependencies

- A runnable Node.js 22+ toolchain and the project scaffold (in place: strict TypeScript build,
  eslint, vitest, CI).
- The constitution at `.specify/memory/constitution.md` (v1.0.0) — this spec is written against
  its principles, notably II (API-first), VII (test-first), and VI (explicit over magic).
- `docs/` — the handoff package; this spec refines `docs/01` Epics A and B and must be read as
  consistent with `docs/02` §3, §4, §5 and §10.
- `tasks.md` carries a post-approval amendment record. **Amendment 2026-10-04 (A1)** pins the
  not-implemented response — FR-003's "not implemented in this mock" answer — to one exported
  constant (`NOT_IMPLEMENTED`, 501 per RFC 9110 §15.6.2) and one body schema, replacing the prose-only
  assertion in T021/T026. It changes **no requirement** in this document; see the amendment section
  at the tail of `tasks.md` for the pinned decisions and their justification.

## Amendment Log

*This spec was approved as-is; entries here record amendments that touch its requirements. An
amendment that changes no requirement is recorded in `tasks.md` instead and merely noted below.*

| Date | Ref | Class | Effect on this spec |
|---|---|---|---|
| 2026-10-04 | A1 | PATCH | none — pins the not-implemented response (constant + body) in `tasks.md` T021/T026; FR-003 and SC-004 are unchanged and remain the contract |
