# Phase 0 — Research: Slice 2, Data Layer I (Configuration and Generation)

Decisions are recorded as: **Decision → Rationale → Alternatives considered**. Every option below
was checked against the live package registry and current upstream documentation on **2026-10-04**,
not recalled.

## 0. The vendor-specification spike — outcome recorded (closes `docs/04` Q6)

The slice-2 spec's original assumption ("the real vendor specification is still unavailable") was
retired by the 2026-10-04 amendment. `docs/05-target-apis.md` measured the real StubHub Point of Sale
document directly: it is **live, public and credential-free** — OpenAPI **3.0.1**, **165 paths, 224
operations**, sha256 `2209392493d3…c0af90`. This slice is where that measurement stops being a note
and becomes a design input. What it settles, and the design consequence:

| Measured fact | Design consequence |
|---|---|
| **0 of 224** operations declare an `operationId` | `METHOD /path` is the only universal selector; tags (28, one containing a space) are the ergonomic one. The selection grammar is inherited from slice 1's A1/A2 amendments, not reinvented |
| **`externalId` ×45**, and `eventId`/`viagogoEventId`/`primaryEventId` coexist | Naming-convention inference *proposes*, never *decides*, when ambiguous. The undetermined-link record in the report (FR-007) is the common path, not a fallback |
| Paging is a **cursor inside the response schema** (`paginationToken` ×21) + `maxPageSize` ×18 | The paging heuristic covers cursor-in-schema + size cap; offset/limit and page/size are not the target's forms, though a fixture exercises all three |
| Identities mixed *within one document*: `int64` ×78, `string` ×36, `int32` ×30, `uuid` ×29 | Reserved ranges are per **identity space**, not per integer counter. `viagogoEventId` (a prefixed string on a StubHub API) proves the prefixed form is real |
| The `Webhook` tag is a registrable **CRUD** collection (`POST /webhooks`, with a `409 Conflict`) | Webhook *registration* mocks like any collection; only webhook *delivery* is slice 4. No special-casing |
| The document is **not vendored** (redistribution terms unsettled) | CI MUST NOT require it; a fixture document stands in for CI, and the live derivation is an opt-in, non-blocking test |

**Still open after this slice's design** — the derivation *run* against the live document is
**implementation work** (a task in `tasks.md`), not planning work: the tool that would perform the
derivation is itself only complete at the end of slice 1. Its outcome appends to this document rather
than being invented now. What this slice can do is **pin the shape** the run will exercise, which the
table above does.

## 1. Deterministic plausible-value generation

**Decision**: `@faker-js/faker` v9, driven by a **per-collection** seeded randomizer, with
`faker.setDefaultRefDate()` pinned to the clock seam's instant before any draw.

**Rationale**: Faker is the constitution's named choice and its v9 default randomizer is a 53-bit
Mersenne Twister, so `faker.seed(n)` makes the whole draw sequence reproducible on every machine —
which is precisely the FR-016 property. The per-collection point is the load-bearing one: SC-007
requires that adding an unrelated collection leaves every existing collection's records unchanged,
and that only holds if each collection draws from a **stream derived from `(globalSeed, collection)`**
rather than from one shared sequence. A single global stream would satisfy SC-002 (same seed ⇒ same
output) while *failing* SC-007 (adding a collection shifts every later draw).

**The trap, checked not assumed.** Faker's own documentation warns that a seed is *not sufficient*
for the relative-date methods — `past`, `future`, `recent`, `soon`, `birthdate`, `git.commitEntry` —
because they are anchored to "today" and the clock moves between runs. Left unaddressed this is
exactly the silent non-determinism FR-019 forbids, and it would surface as an export that differs
only on a date field. **Mitigation**: every faker call is made against a faker instance whose
`setDefaultRefDate` is the clock seam's instant, so a date-dependent field is reproducible *and*
traceable to the clock. This is what makes FR-019's "governed by the tool's clock" real rather than
nominal.

**Alternatives considered**:
- **One global seeded stream** — rejected: fails SC-007 for the reason above. The failure is subtle
  (green determinism test, red independence test), which is why it is called out here.
- **Hand-rolled value tables** — rejected: reimplements a maintained library poorly, and the
  constitution names Faker.
- **`faker` for everything (no precedence chain)** — rejected: FR-010 requires the *order* (explicit
  rule → supplied → lookup → declared constraints → heuristic → default), and Faker is only level 5.

## 2. Expression / calculation engine

**Decision**: `jsonata` v2, with seeding-aware helpers (`$uniform`, `$choice`, …) registered into the
expression environment via `expression.registerFunction(name, impl, signature)`.

**Rationale**: The constitution names JSONata (`docs/03` uses `expr: "cost * $uniform(1.1, 2.5)"`),
and JSONata's JS API is exactly the shape this needs: `evaluate(input, bindings)` gives the compiled
expression access to the record's own sibling fields as its input (FR-011's "calculation over the
record's own sibling fields, evaluated after the fields it depends on"), and `registerFunction`
supplies the random helpers with a **type signature** so a wrong-typed argument raises at run time
rather than silently producing a bad value. Registering the helpers also keeps all randomness
funnelled through the same seeded source as the generators, so a calc rule is as reproducible as a
generator.

**Alternatives considered**: a bespoke arithmetic parser (a second, worse expression language);
evaluating only `faker`-backed rules and dropping `expr` (fails FR-011); `expr-eval` or similar (no
standard-function library, no JSON-aware navigation — it would re-implement what JSONata already is).

## 3. Per-collection seed derivation

**Decision**: derive each collection's stream as `hash(globalSeed, collectionName)` → an integer seed
for that collection's faker instance and its own deterministic ID/RNG source.

**Rationale**: This is the single mechanism that turns SC-002 and SC-007 from aspirations into
consequences: same `globalSeed` ⇒ same per-collection seed ⇒ same records; a new collection gets a
*different* stream and perturbs no other. It also makes the seed story legible in the report —
"collection `Inventory`, seed `0x…`" is a sentence an integrator can act on.

**Alternatives considered**: index-ordered derivation from one stream (fails SC-007 the moment a
collection is inserted); re-seeding globally per collection without hashing the name (fails when two
recipes reorder collections).

## 4. Identity spaces and reserved ranges

**Decision**: an identity's **space** is determined by the declared identity field's type — integer
(`int32`/`int64`), uuid, or declared string format / vendor-prefixed. A reserved range is a span
*within its own space*; fixture-assigned and generated values are kept in disjoint spans, and the
reservation is recorded under the store metadata key `id_seq:<resource>`.

**Rationale**: FR-017 as amended, and the measured reality that one document mixes four identity
types. A range that is meaningful for an integer (`100000…`) is meaningless for a uuid, and a
vendor-prefixed string (`EVT-…`) has its own pattern. Treating the space as a property of the field
— rather than assuming integers — is the only version that satisfies SC-006 on the real document. A
space the tool cannot express a range within (e.g. an opaque string with no format) is **reported**,
never guessed at, per principle VI.

**Alternatives considered**: an integer counter for everything (silently collides on uuid/prefixed
identities — the exact SC-006 failure); a single global counter (collides across collections).

## 5. Value provenance

**Decision**: every value-producing step returns `(value, provenance)`, where provenance names the
precedence level and, where applicable, the generator/rule that fired.

**Rationale**: FR-010 ends with "MUST be able to state which rule produced any given value", and
principle VI makes the report part of the interface. Carrying provenance *with* the value — rather
than reconstructing it later — is what lets a golden file assert it and the startup report print it
without a second inference pass. It is also the difference between an inference the user can pin and
one they can only trust.

**Alternatives considered**: log-only provenance (not assertable in a golden file); recompute-on-report
(a second implementation of the precedence chain, free to disagree with the first).

## 6. Foreign-key ordering and cycles

**Decision**: build a directed graph of collection references and generate in **topological order**;
on a cycle, report the cycle with the collections involved and generate the cycle's members in a
deterministic order with their cyclic links left unresolved-and-reported, rather than deadlocking.

**Rationale**: FR-009 (generate after dependencies) and FR-008 (detect and report cycles, never
deadlock or fail opaquely). A vendor document of this size can legitimately contain a cycle, and a
generator that hangs on one is worse than one that names it.

**Alternatives considered**: recursive generation with a visited-set (can blow the stack on a deep
graph and produces an order that depends on traversal, weakening SC-007); refusing to start on any
cycle (too harsh — a cycle in one corner should not block the rest).

## 7. Behaviour layer: parse and validate, do not consume

**Decision**: load `behavior/*.yaml` (targets, subscriptions, actions, reactions, simulations) and
validate it against the config schema now, but act on none of it.

**Rationale**: The spec's own boundary — "this slice must parse and validate them, not act on them."
Doing the validation here means slices 4–5 add *behaviour*, not *plumbing*, and a malformed behaviour
file fails at the same time as every other config error (FR-005) rather than at the moment slice 4
first reads it.

**Alternatives considered**: defer the whole layer to slice 4 (then a typo in a webhook target is
invisible until the feature that uses it lands).

## 8. What slice 2 deliberately does not resolve

Carried forward, each with a home:

- **Import mapping and importers** — slice 3. This slice defines the config shape and the `imported`
  origin; it does not read the sources.
- **Export and snapshot/restore** — slice 3. SC-002/SC-003 are *asserted* here by comparing a
  deterministic serialization produced for the test; the shipped export command is slice 3's.
- **Webhook delivery, the outbox, JSONata templates for payloads** — slice 4. Only the *registrable*
  `/webhooks` CRUD surface is in scope here, as an ordinary collection.
- **Actions, reactions, simulations** — slice 5; parsed and validated here, not run.
- **A virtual clock; Postgres** — slice 6. The clock *seam* lands now with the real implementation
  behind it.
- **Tenant scoping, authentication on the mock surface** — `docs/04` Q11/Q12, still open; the mocked
  surface remains open as in slice 1.
- **The config contract's location and the schema generator** — the build currently compiles
  `specs/001-slice-1-core/contracts/config.schema.yaml` into `src/config/schema.generated.ts` by a
  hardcoded path (`scripts/generate-config-schema.mjs`), guarded by the drift test in
  `tests/unit/config.test.ts`. Slice 2's contract is the authoritative one going forward, so a task
  in this slice **repoints the generator and the drift test** at
  `specs/002-data-layer/contracts/config.schema.yaml`; slice 1's file stays in place as history. This
  is an implementation task, not a planning one, but it is named here so it is not discovered late
  (see `plan.md` → Project Structure, "Known integration point").
