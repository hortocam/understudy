# Implementation Plan: Slice 2 — Data Layer I: Configuration and Generation

**Branch**: `wt/002-data-layer-plan` (feature `002-data-layer`) | **Date**: 2026-10-04 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/002-data-layer/spec.md` (amended 2026-10-04 against the
measured vendor facts, `docs/05-target-apis.md`).

## Summary

Make the slice-1 mock **populated and configured**. Slice 1 served a subset of operations with an
empty store; this slice adds the layer that decides *what records exist* — versioned fixtures, a
six-level value-precedence chain, a generator registry, reserved identity ranges, and a
deterministic generation run ordered by the foreign-key graph — plus the configuration surface that
pins every one of those decisions.

The technical approach: load four independent config layers (fixtures, imports, recipes,
behaviour), derive collections/links/identity-spaces/paging from the dereferenced document, then run
one **data-driven generation pass** whose only inputs are the config, the document and a seed. Every
inference that a real vendor document makes ambiguous is **reported, not resolved** (FR-006/FR-007,
principle VI); every value chosen is traceable to the rule that chose it (FR-010).

Nothing here is per-entity code. The slice-2 engine is the same shape as slice 1's: one code path
driven by a model derived from the specification and the configuration.

## Technical Context

**Language/Version**: TypeScript 5.9, Node.js 22 LTS, ES modules (`moduleResolution: NodeNext`) —
unchanged from slice 1, because this slice extends the same modules rather than adding a runtime.

**Primary Dependencies**:

| Concern | Choice | Version | Note |
|---|---|---|---|
| Plausible-value generation | `@faker-js/faker` | ^9 | seeded; the constitution's named choice. Used only at precedence level 5 |
| Expressions / calc rules | `jsonata` | ^2 | constitution names JSONata; the recipe `expr` rule is JSONata with seeding-aware helper functions registered into the environment |
| HTTP / validation / storage / config / CLI / test | unchanged from slice 1 | — | `fastify` ^5.12, `ajv`(+`ajv-formats`) ^8.20/^3, `better-sqlite3` ^13, `yaml` ^2, `commander` ^15, `vitest` ^5 |

No new storage, HTTP or CLI technology: slice 2 writes new *origins* through the existing `Store`
seam and adds config-file layers to the existing loader.

**Storage**: unchanged `Store` interface, one new concern — a **per-collection identity range** held
in the store's metadata table under the documented key `id_seq:<resource>` (the key slice 1's T047
renamed to). Generated rows are written with `origin='generated'`; fixture rows with `origin='static'`;
neither ever overwrites the other (FR-002, principle IV). No migration risk: slice 1 already carries
the `origin` column and the metadata table.

**Testing**: vitest 5. Golden-file tests for the three things principle VII names — the precedence
chain, entity/FK inference, and generators — plus determinism proven by **double-generation equality**
of an export (SC-002, SC-007) and fixture immutability by byte-comparison before/after generation and
API activity (SC-003). Integration tests run a real server against a real SQLite file. The
derivation against the **real vendor document** is an opt-in test (network, not vendored) that is
**not** CI-blocking.

**Target Platform**: unchanged — Node CLI + HTTP server, Linux/macOS/Windows, no shell-outs in
library code.

**Project Type**: single project (a library, a server, a CLI over one core) — unchanged.

**Performance Goals**: SC-008 — a few thousand records across several collections generated and the
mock serving in **well under a minute** on a developer machine; SC-001 — >100 records per major
collection reachable with **zero** per-endpoint/per-field code. Paged reads keep a large collection
off the heap (slice 1's `listPaged` seam).

**Constraints**: no outbound calls other than a URL-supplied spec and explicitly configured import
sources / webhook targets (constitution VIII) — imports are slice 3 and delivery is slice 4, so this
slice opens no socket but *parses and validates* the behaviour layer without acting on it. The real
vendor document is fetched on demand and **never vendored** (licence unsettled); CI MUST NOT depend
on it. Secrets come from the environment, never config files. Determinism is not a feature here, it
is the default (principle III).

**Scale/Scope**: thousands of records per collection; generation ordered over a foreign-key DAG that
may contain cycles (reported, never deadlocked — FR-008); identity spaces that are integer, uuid or
vendor-prefixed string, frequently mixed within one document.

## Constitution Check

*GATE: must pass before Phase 0 research; re-checked after Phase 1 design.*

| Principle | Gate | Verdict |
|---|---|---|
| I. Spec is the source of truth | Config refines the document; a contradiction is reported, never resolved by guessing | **PASS** — FR-005 refuses to start naming the offending key; the generator produces only values the document's schema admits (FR-014) |
| II. API-first control | Every capability is in the control API; the CLI adds no logic | **PASS with one documented act** — generation is a control-API operation (FR-021) and `ustdy generate` is a client. `ustdy init` (FR-020) scaffolds files on disk, which is the same class of local act as slice 1's `up`; it contains no generation logic |
| III. Determinism by default | Same spec + config + seed ⇒ same state, byte-identical on export | **PASS** — the core of the slice: per-collection seed derivation (FR-016), a frozen clock seam (FR-019), double-generation equality (SC-002) and independence from unrelated collections (SC-007) |
| IV. Static/dynamic separation | Fixtures are never mutated; origins are distinct and exportable | **PASS** — FR-002 + FR-004; generation writes `generated`-origin rows only, fixtures stay `static`, and the report counts by origin |
| V. Atomicity | A change and its events commit together or not at all | **PASS (narrow)** — no events until slice 4, but a generated record, its origin and its identity-range advance are one transaction, so slice 4's outbox joins an already-atomic write |
| VI. Explicit over magic | Every inference reported at startup and pinnable | **PASS** — FR-006/FR-007 and the amended FR-006: a naming-convention hit *proposes*, and an ambiguous link is reported as undetermined rather than decided |
| VII. Test-first, contract-verified | Failing test first; golden files; determinism proven | **PASS by process** — every task is written test-first; the three golden-file families are named in Testing above |
| VIII. Safe and portable | No hidden outbound calls; secrets from env; portable | **PASS** — no socket is opened in this slice; the vendor document is fetched on demand, never vendored |
| IX. Small, documented config surface | Every key documented with an example in the same change | **PASS** — this slice *is* the config surface; `contracts/config.schema.yaml` is extended and every key added ships with a documented example; `signing`/`clock`/`postgres` stay reserved |
| X. Additive evolution | Seams exist before the features that use them | **PASS** — the **clock seam** lands now (real implementation, slice 6 swaps the virtual one behind it); the `Store`, `origin` and reset-mode seams from slice 1 are consumed here unchanged |

**Post-Phase-1 re-check**: unchanged. The design adds only the clock seam (principle X) and the
generator registry (FR-012); it introduces no abstraction the spec does not require, and the
behaviour config layer is *parsed and validated but not consumed*, which is the spec's own boundary.

## Project Structure

### Documentation (this feature)

```text
specs/002-data-layer/
├── plan.md              # This file
├── spec.md              # The what and why (amended 2026-10-04)
├── research.md          # Phase 0: decisions, alternatives, and the recorded vendor-spec outcome
├── data-model.md        # Phase 1: config entities, store tables, the derivation model
├── quickstart.md        # Phase 1: runnable validation scenarios
├── contracts/           # Phase 1: the config schema this feature extends
│   └── config.schema.yaml   # the slice-1 contract, extended (never forked)
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created by /speckit-plan)
```

### Source Code (repository root)

New and extended modules, all inside the slice-1 tree — no new top-level boundary:

```text
src/
├── config/
│   ├── schema.ts            # EXTENDED: the full config surface as one JSON Schema
│   └── layers/
│       ├── fixtures.ts      # static/lookups + static/entities — versioned, never mutated
│       ├── recipes.ts       # dynamic/*.yaml — the switchable dataset (FR-003)
│       └── behaviour.ts     # behavior/*.yaml — parsed + validated now, consumed in slices 4–5
├── data/
│   ├── precedence.ts        # FR-010 the six-level value-precedence chain, and its provenance
│   ├── seed.ts              # FR-016 per-collection seed derivation
│   ├── identity.ts          # FR-017/018 reserved ranges across integer/uuid/prefixed spaces
│   ├── invariants.ts        # FR-013 stated invariants, redraw budget, loud failure
│   ├── generate.ts          # the run: order by FK DAG, counts, draw, validate, store (FR-009/015)
│   └── generators/
│       ├── registry.ts      # built-in + custom generators, one addressable namespace (FR-011/012)
│       ├── faker.ts         # plausible values by category (precedence level 5)
│       ├── lookup.ts        # lookup-table draws, uniform or weighted
│       ├── reference.ts     # a reference into an existing record of another collection
│       ├── sequence.ts      # a sequence
│       ├── choice.ts        # a choice from an explicit set
│       └── expr.ts          # JSONata calc over sibling fields, seeding-aware helpers registered
├── spec/
│   ├── resources.ts         # EXTENDED: entity derivation, FK evidence, and the ambiguity record
│   └── report.ts            # EXTENDED: collections, links + evidence, undetermined links, origins
├── clock.ts                 # the clock seam (real now; virtual behind it in slice 6)
└── control/routes.ts        # EXTENDED: the generation operation (FR-021) — the CLI's only path

tests/
├── fixtures/                # fixture documents + expected-state golden files
├── unit/                    # precedence, inference, generators, seed derivation, identity ranges
├── integration/             # real server + SQLite: generate → export → compare; restart; isolation
└── contract/                # conformance driven by the fixture document (extends slice 1)
```

**Structure Decision**: the four config layers are separate modules because they have four
different lifetimes — fixtures are versioned and frozen, recipes are switchable, imports are slice
3's, behaviour is parsed now and consumed later. Collapsing them would put a slice-1 concern and a
slice-4 concern in one file. `data/` sits beside `spec/` and depends on it (generation reads the
derived model) while `spec/` never depends on `data/`, so the derivation stays testable without a
store.

## Derivation rules (what is inferred, and what is refused)

Principle VI demands inference be explicit, reported and pinnable. Slice 1 derived the *shape*; this
slice derives the *population*, and its rules are stated against the measured vendor document
(`docs/05`) rather than a five-operation fixture:

- **Collections and links.** Collections come from the live operations; links follow the FR-006
  evidence order — explicit config, a declared spec extension, a naming convention (configurable),
  implied nesting. **A convention hit proposes a link; it decides one only when it is unambiguous.**
  Where the convention is not decisive the link is recorded as *undetermined* in the report and is
  not acted on. This is the common case on the target document, not the edge case: `externalId`
  occurs 45 times meaning a different external system per collection, and
  `eventId`/`viagogoEventId`/`primaryEventId` coexist on the same resources.
- **Identity spaces.** The identity field's declared type determines its space — integer (`int64`
  ×78, `int32` ×30), uuid (`×29`) or declared string format/vendor-prefixed (`×36`, and
  `viagogoEventId` on a StubHub document proves the prefixed form is real). A reserved range is a
  span *within that space*, kept disjoint from fixture values; two ranges that overlap refuse to
  start naming the collection. A space the tool cannot reserve within is reported, not guessed.
- **Paging.** Read from the operation's declared query parameters and response schema: the target
  document paginates by a **cursor inside the response schema** (`paginationToken` on 21
  operations) with a size cap (`maxPageSize` on 18), *not* by an `offset`/`limit` or `page`/`size`
  envelope. Generation must produce collections large enough to page, and the count and the declared
  style must agree.
- **Value precedence.** Six levels, in order (FR-010): explicit rule → supplied/imported value →
  lookup-table reference → the document's own constraints/examples/defaults → a plausible-value
  heuristic → the type default. The rule that produced any given value is recorded, so the report
  can state it and a golden file can assert it.
- **Ordering and cycles.** Generation is ordered so a collection is generated after the collections
  it references (FR-009). A cycle is detected and **reported**, never deadlocked and never failed
  opaquely (FR-008).
- **Refusals.** Invalid or unknown-key config, a reference to a collection/field that does not
  exist, a config that contradicts the document, overlapping identity ranges, and an invariant
  violated beyond its redraw budget — each refuses with a named cause.

## Complexity Tracking

> No constitution violations. This section records the seams and one deliberate dependency choice
> that a reader might otherwise mistake for speculative abstraction.

| Addition | Why now | Simpler alternative rejected because |
|---|---|---|
| Clock **seam** with a real-clock implementation only | FR-019 requires every time-derived field be reproducible and the mode reported; principle X requires the seam before slice 6's virtual clock | A direct `Date.now()` call would make exports non-comparable the moment a field depends on time, and retrofitting the seam is a refactor of shipped generation |
| Generator **registry** (built-ins + custom from config/plugin) | FR-012 requires custom named generators usable exactly like built-ins | A `switch` over built-in names would have to be rewritten for the first user-supplied generator; the registry is the seam |
| `jsonata` as the expression engine, with seeding-aware `$`-helpers registered | The constitution names JSONata; recipes need a calc rule over sibling fields (FR-011) and seeded draws like `$uniform` | A bespoke expression parser is a second, worse language; baking randomness into generators only would make FR-011's "calculation over the record's own sibling fields" impossible to express |
| Four separate config layers rather than one settings file | The layers have different lifetimes and different consumers (FR-001) | One file would load behaviour config in slice 2 and give it nowhere to be consumed until slice 4 — exactly the "parsed but inert" state the spec bounds explicitly |
| Reserved ranges spanning multiple identity spaces | FR-017 as amended; the target document mixes integer/uuid/prefixed identities | An integer-only reservation silently collides on a uuid or prefixed identity, which is the failure SC-006 exists to prevent |
