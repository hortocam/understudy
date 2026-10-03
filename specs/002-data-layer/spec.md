# Feature Specification: Slice 2 — Data Layer I: Configuration and Generation

**Feature Branch**: `002-data-layer`

**Created**: 2026-10-03

**Status**: Draft

**Input**: Handoff package `docs/`. Slice 2 of seven; source material is
`docs/01-product-spec.md` §4 Epic C (C1–C8) and §5 FR-008–FR-013, `docs/02-architecture.md` §3
(ingestion and resource inference) and §6 (data layer), `docs/03-config-reference.md` (the
configuration formats), and `docs/04-phasing-and-open-questions.md` slice table row 2.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Versioned fixtures that are identical every run (Priority: P1)

An integration developer wants a mock whose lookup tables and fixed records are the same every
time it starts, because they are testing *their* code, not the mock's data. They write the fixed
records and lookup tables into versioned files next to the specification, commit them, and get
exactly those records — same identities, same values — on every run, on every machine, forever,
until someone edits the file deliberately.

**Why this priority**: it is the difference between a mock and a random data generator. Without
stable fixtures there are no golden tests, no reproducible CI, and no reviewing a fixture diff. It
is first because every generation story below depends on having fixed parents to attach to.

**Independent Test**: Write a small fixtures file, start the mock twice from a wiped store, and
compare the exported state of those records byte for byte. Edit the file, restart, and confirm the
change is the only difference.

**Acceptance Scenarios**:

1. **Given** a fixtures file declaring lookup tables and fixed records with explicit identities,
   **When** the mock starts from a wiped store, **Then** those records exist with exactly the
   declared identities and values.
2. **Given** the same fixtures file, **When** the mock is started twice from a wiped store,
   **Then** the resulting state of those records is identical in both runs.
3. **Given** a running mock, **When** records are created over its API, **Then** the fixture
   records themselves are unchanged, byte for byte.
4. **Given** a record supplied by fixtures, **When** it is read over the mocked API, **Then** it
   is indistinguishable in shape from a record created over the API — the mock surface does not
   expose which layer a record came from.

---

### User Story 2 - A populated mock that was never hand-written (Priority: P1)

The same developer needs a collection with *many* records to make their list, filter and paging
code worth testing — but writing hundreds of plausible records by hand is the work they are
trying to avoid. They write a short recipe: how many of each collection, and special rules for
the fields that matter to them (a code from a fixed set, a price that must exceed a cost). They
start the mock and get a filled database.

**Why this priority**: this is the product's headline promise — a data-rich mock with zero
hand-written per-endpoint work. It is what makes the tool worth having over an example-driven mock.

**Independent Test**: Start from a wiped store with a recipe asking for a specific count of one
collection, then read that collection over the mocked API and confirm exactly that many records,
each conforming to the specification's schema, with the recipe's special rules honoured.

**Acceptance Scenarios**:

1. **Given** a recipe asking for a number of records of a collection, **When** the mock starts,
   **Then** exactly that many records exist, all conforming to the specification's schema.
2. **Given** a field rule naming a fixed set of values, **When** records are generated, **Then**
   every generated value for that field comes from the named set.
3. **Given** a field rule that picks a value from a lookup table (optionally with weights),
   **When** records are generated, **Then** the stored value references a real row of that table.
4. **Given** a record rule expressed as a calculation over its own sibling fields, **When** records
   are generated, **Then** the calculated field is consistent with the fields it derives from.
5. **Given** a stated invariant over generated records, **When** generation would violate it,
   **Then** the tool re-draws until it holds, and if it cannot, it fails loudly rather than storing
   an invalid record.
6. **Given** a collection with no generation rules at all, **When** the mock starts, **Then** it is
   still populated from the specification's own schema and the values around it — the developer
   does not have to describe every field to get data.

---

### User Story 3 - The same data every time, on purpose (Priority: P1)

A test author needs a failing test to stay failing and a passing test to stay passing. They ask
for a specific seed and get the same dataset every time; if a test depends on a particular record
being unusual, that record is still unusual tomorrow.

**Why this priority**: a mock whose data drifts makes every failure ambiguous. It is a hard
requirement of the product (`docs/01` C7) and the thing that lets generated data back a CI suite
at all.

**Independent Test**: Generate twice from a wiped store with the same seed and the same
configuration and compare the two exports; they must be identical. Change the seed and confirm the
data changes.

**Acceptance Scenarios**:

1. **Given** a seed, a configuration and fixtures, **When** the mock is generated twice from a
   wiped store, **Then** the two exported states are identical.
2. **Given** the same configuration with a different seed, **When** the mock is generated, **Then**
   the generated data differs.
3. **Given** a dataset generated with fixture and generated records, **When** the mock is wiped
   and regenerated from the same seed, **Then** every generated record is reproduced with the same
   identity and values, not merely an equal count.
4. **Given** a configuration that grows by one unrelated collection, **When** the seed is
   unchanged, **Then** the records of the pre-existing collections are unchanged.

---

### User Story 4 - Startup tells me what it inferred, and how to pin it (Priority: P1)

A developer points the tool at a real vendor specification whose schemas do not spell out how
records relate. The tool works out the collections and the links between them, populates the
database, and — crucially — **shows its working**: which collection references which, how it
decided, and what it could not decide. Where it got something wrong or was unsure, the developer
can pin the truth in configuration and restart.

**Why this priority**: this is the product's central risk (`docs/02` §13, "FK/entity inference
fails on inconsistently named vendor specs"). Generation that silently guesses produces a mock
that quietly does not behave like the real service — the exact failure the product exists to fix.

**Independent Test**: Start against a fixture document whose naming conventions imply some
relationships and hides others; confirm the report names the collections, states the source of
each inferred link, flags the undetermined ones, and that pinning one in configuration changes the
outcome.

**Acceptance Scenarios**:

1. **Given** a document with several collections, **When** the mock starts, **Then** the report
   lists every collection and the links between them.
2. **Given** a link inferred from a naming convention, **When** the report is read, **Then** the
   report states that the inference came from the convention, not from explicit configuration.
3. **Given** a link the tool cannot determine confidently, **When** the mock starts, **Then** the
   report calls it out and the tool does not choose silently.
4. **Given** a relationship pinned in configuration, **When** the mock starts, **Then** the pinned
   relationship wins and the report says it was configured rather than inferred.
5. **Given** a document whose collections form a relationship cycle, **When** the mock starts,
   **Then** the cycle is reported and generation does not deadlock.

---

### User Story 5 - Generated children attach to real parents (Priority: P2)

The developer wants their list and detail screens to make sense: every generated record for a
child collection must reference a parent that actually exists, with a quantity that can vary by
parent rather than being flat.

**Why this priority**: it is what makes the data *plausible* rather than merely valid — an order
with a customer reference pointing at nothing is worse than useless. It is P2 because a flat,
correctly-linked dataset already supports most testing; per-parent variety refines it.

**Independent Test**: Import or generate a known set of parents, ask for children per parent within
a range, and confirm every child references a real parent, the per-parent counts fall in the
declared range, and no child is orphaned.

**Acceptance Scenarios**:

1. **Given** a declared parent–child link, **When** children are generated, **Then** every child
   references a parent that exists.
2. **Given** a per-parent count as a range, **When** children are generated, **Then** each parent's
   child count falls inside the range and is reproducible from the seed.
3. **Given** a per-parent count with a stated distribution, **When** children are generated, **Then**
   the shape of the counts follows that distribution rather than being uniform.
4. **Given** a link whose parent rows come from fixtures, **When** children are generated, **Then**
   they attach to the fixture parents, and the fixture rows are not modified.

---

### User Story 6 - Identities that cannot collide (Priority: P2)

A test author relies on a generated record never wearing the identity of a fixture record — because
if they collide, a test that edits "its own" record silently edits a fixture and the fixture stops
being the thing that was reviewed.

**Why this priority**: it protects the static/dynamic separation the constitution makes a
principle (IV). It is P2 because it is a safety property of a working system, not a new capability.

**Independent Test**: Start with fixtures, generate, and confirm that no generated identity
overlaps a fixture identity, that generated identities are stable for a given seed, and that
overlapping ranges in configuration are rejected with a clear error.

**Acceptance Scenarios**:

1. **Given** fixtures with declared identities and generation configured for the same collection,
   **When** generation runs, **Then** every generated identity lies outside the fixture identities.
2. **Given** a configuration whose fixture and generated identity ranges overlap, **When the mock
   starts, **Then** it refuses to start and names the overlapping collection.
3. **Given** the same seed twice, **When** generation runs twice, **Then** the same identities are
   produced for the same records.
4. **Given** a collection whose identity is not a number, **When** records are generated, **Then**
   identities are produced in the form the specification declares and remain stable for the seed.

---

### User Story 7 - Values chosen by a rule I can predict (Priority: P2)

A developer needs to know *why* a given field ended up with a given value, because when the data
is wrong they have to decide whether to fix their specification, their fixtures, or their recipe.
The tool applies a documented order of precedence and can tell them which rule produced a value.

**Why this priority**: it is the debuggability half of "explicit over magic" (constitution VI).
It is P2 because the data is produced correctly without it; it is what makes the tool teachable.

**Independent Test**: Configure a field with an explicit rule, then remove it and confirm the value
falls to the next rule in the documented order; repeat down the chain and confirm the order holds.

**Acceptance Scenarios**:

1. **Given** a field with an explicit rule, **When** records are generated, **Then** the explicit
   rule wins over every other source.
2. **Given** a field that also has a supplied fixture value, **When** records are generated, **Then**
   the supplied value wins over any generator or specification-derived default.
3. **Given** a field with no explicit rule and a specification that constrains it (a fixed set of
   allowed values, a format, a range), **When** records are generated, **Then** the value respects
   every constraint the specification states.
4. **Given** a field the tool has no rule for and the specification does not constrain, **When
   records are generated, **Then** the value is plausible for the field's name and type, and the
   report says the value was chosen by a fallback.

## Requirements *(mandatory)*

### Functional Requirements

**Configuration layers**

- **FR-001**: The tool MUST load configuration from four independent layers — fixtures (fixed
  records and lookup tables), imports, generation recipes, and behaviour — each from its own file
  or folder, loadable without the others being present.
- **FR-002**: Fixture configuration (fixed records and lookup tables) MUST be applied identically
  on every run and MUST NEVER be modified by generation, import, or activity over the mocked API.
- **FR-003**: Generation configuration MUST be selectable by name ("recipe") so that several
  datasets (a small one for continuous integration, a large one for load) can coexist in one
  project and be chosen at start.
- **FR-004**: Every stored record MUST carry its origin — supplied by fixtures, imported, generated,
  or written over the mocked API — and the tool MUST be able to report counts by origin.
  (FR-009; the origin tag itself landed in slice 1.)
- **FR-005**: The tool MUST refuse to start, naming the offending key, when a configuration file is
  invalid, references a collection or field that does not exist, or contradicts the specification.
  A configuration MUST NOT be able to silently contradict the specification (constitution I).

**Collection and relationship inference**

- **FR-006**: The tool MUST derive collections from the live operations and MUST derive the links
  between them, using this order of evidence, and MUST record which source each link came from:
  (1) explicit configuration, (2) a declared extension in the specification, (3) a naming
  convention (configurable rules), (4) implied nesting in the schemas.
- **FR-007**: The startup report MUST list every derived collection, every derived link with its
  evidence source, and every link the tool could not determine confidently; an undetermined link
  MUST NOT be resolved silently.
- **FR-008**: The tool MUST detect relationship cycles and report them, and MUST NOT deadlock or
  fail opaquely when one exists.
- **FR-009**: The tool MUST order generation so that a collection is generated after the
  collections it references.

**Value selection**

- **FR-010**: Field values MUST be chosen by this precedence, and the tool MUST be able to state
  which rule produced any given value: (1) an explicit rule in the generation configuration,
  (2) a supplied/imported value, (3) a reference into a lookup table, (4) the specification's own
  constraints and declared examples/defaults, (5) a plausible-value heuristic based on the field's
  name and declared format, (6) the type's default value.
- **FR-011**: The tool MUST support, as field rules: a value from a named generator; a plausible
  value by category (names, codes, amounts, dates, quantities); a value drawn from a lookup table
  (uniformly or by weights); a reference to an existing record of another collection; a sequence;
  a choice from an explicit set; and a calculation over the record's own sibling fields, evaluated
  after the fields it depends on.
- **FR-012**: The tool MUST support custom named generators, defined in configuration or a plugin
  file, usable exactly like a built-in generator.
- **FR-013**: The tool MUST support a stated invariant over generated records and MUST re-draw on
  violation up to a configured number of attempts and then fail loudly, naming the rule, rather
  than storing an invalid record.
- **FR-014**: Every value the tool produces MUST conform to the specification's schema for that
  field, including allowed-value sets, formats, ranges and lengths.

**Counts, identity and determinism**

- **FR-015**: The tool MUST support an absolute record count for a collection and a count relative
  to a parent collection given as a range, optionally with a stated distribution.
- **FR-016**: The tool MUST produce identical records — identity and values — for the same seed,
  configuration, fixtures and specification, and MUST be unaffected by the addition of an unrelated
  collection (per-collection derivation of the seed).
- **FR-017**: The tool MUST allocate generated identities from a range reserved per collection,
  distinct from fixture identities, MUST produce them in the form the specification declares, and
  MUST refuse to start when configured ranges overlap.
- **FR-018**: Records written over the mocked API MUST receive identities that cannot collide with
  fixture or generated identities.
- **FR-019**: Generated values that depend on the current time MUST be reproducible: any
  time-derived field MUST be governed by the tool's clock, and the mode used MUST be reported at
  startup.

**Commands**

- **FR-020**: A project-initialisation command MUST scaffold the configuration files and folders
  for a given specification and print the inferred collection report, so the developer starts from
  the tool's understanding rather than a blank directory.
- **FR-021**: A generation command MUST apply a named recipe to a running mock, and MUST report
  what it created by collection and origin.

### Key Entities

- **Fixture record**: a record declared in versioned configuration with an explicit identity; never
  modified by the tool; the parent that generation attaches to.
- **Lookup table**: a small named table of codes/values that fixture records and generated records
  reference; the source of "values that appear consistently".
- **Recipe**: a named generation configuration defining a seed, counts, field rules and invariants;
  the unit a test author switches between.
- **Generator**: a named producer of a value for a field — built-in or custom — addressable from a
  recipe.
- **Field rule**: one instruction for one field: an explicit generator, a lookup draw, a reference,
  a calculation, or a choice.
- **Invariant**: a stated condition over a generated record that must hold before it is stored.
- **Relationship**: a derived link from one collection to another, carrying the evidence that
  produced it (configured, declared, conventional, or structural) — the thing the report exposes.
- **Identity range**: the reserved span of identities for a collection's generated records, kept
  disjoint from fixture identities.
- **Origin**: how a record came to exist (fixture, imported, generated, API-written); the tag that
  makes reset-by-origin possible in slice 3.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A developer can go from a specification to a populated mock with **more than one
  hundred** records per major collection in **under a day's work**, writing **zero** per-endpoint
  or per-field code for the collections they do not care about.
- **SC-002**: Two generations from a wiped store with the same seed and configuration produce
  **byte-identical** exports; with a different seed, the exports differ.
- **SC-003**: Fixture records are **byte-identical** before and after any amount of generation and
  API activity, in **100%** of runs.
- **SC-004**: **100%** of generated records conform to the specification's schema, and **100%** of
  declared relationships resolve to a record that exists in the store.
- **SC-005**: Every derived relationship in the startup report names its evidence source, and every
  relationship the tool could not determine is listed; a reader can decide what to pin in
  configuration without reading source code.
- **SC-006**: No generated identity collides with a fixture identity, and overlapping configured
  ranges are refused with a message naming the collection — in **100%** of tested configurations.
- **SC-007**: Adding an unrelated collection to a recipe leaves every existing collection's
  generated records unchanged, verified by export comparison.
- **SC-008**: A dataset of a few thousand records across several collections is generated and the
  mock is serving in **well under a minute** on a developer machine.

## Assumptions

- **Slice 1 is a prerequisite.** Collections, relationships and the store exist from slice 1;
  this slice makes them *populated* and *configured*.
- **"Static" and "dynamic" split, in the handoff's terms**: fixtures and behaviour are versioned;
  recipes are the switchable dataset. Behaviour files (webhooks, actions, simulations) are loaded
  from this slice onward but only *consumed* in slices 4–5 — this slice must parse and validate
  them, not act on them.
- **Import is out of scope here.** `docs/03` describes an imports layer; this slice defines the
  configuration's shape and the origin tag, and slice 3 implements mapping-driven import. Records
  in this slice arrive from fixtures or from generation.
- **The time-derived-field question is settled conservatively:** a real clock is the default, and
  any field derived from it is recorded so exports can be compared; a fully virtual clock is
  slice 6. The startup report states which mode is in force.
- **The plausible-value heuristic** is built on a well-known fake-data library plus the
  specification's own declared formats and examples; the exact library is chosen in `plan.md`.
  Its outputs are *heuristic*, which is why the report must say when it was used (FR-010).
- **The real vendor specification is still unavailable**; validation of inference against it remains
  a spike (`docs/04` Q6), now scheduled inside this slice since inference is its subject. The
  outcome of the spike is recorded in `plan.md` research, and the fixture documents stand in until
  then.
- **Identity format follows the specification** (integer, string, or formatted identifier). The
  handoff's open question about vendor-prefixed identifiers (`docs/04` Q5) is answered
  conservatively: the tool produces whatever form the document declares and reserves a range inside
  it; a vendor-specific format is configuration, not code.
- **Paging, filtering and sorting detection** landed in slice 1; this slice does not revisit it.
- **Out of scope for slice 2**: import/export and snapshots (slice 3), events, webhooks
  (slice 4), actions/reactions/simulation (slice 5), postgres, virtual clock, tenant scoping.

## Dependencies

- Slice 1 (`specs/001-slice-1-core`) — collections, relationships, the store, the control surface
  and the CLI all originate there.
- The constitution v1.0.0 — this slice is where principles III (determinism), IV (static/dynamic
  separation) and VI (explicit over magic) become load-bearing.
- `docs/03-config-reference.md` — the draft configuration formats this slice must reconcile; the
  delivered configuration schema is expected to differ in detail and the differences must be
  recorded in `plan.md`.
