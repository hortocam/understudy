# Phase 1 — Data Model: Slice 2, Data Layer I (Configuration and Generation)

Two layers, as in slice 1: the **derived model** (what the tool works out about the document, in
memory) and the **stored model** (what is persisted). Slice 2 changes both — it *extends* the
derived model with the population facts inference was previously only reporting, and it *fills in*
the stored-model items slice 1 explicitly deferred to here (its §4 table names four: `_id_ranges`,
foreign-key constraints, generated/indexed filter columns, and the non-`runtime` origins).

## 1. Derived model (extensions in bold)

Rebuilt at every startup, still a pure function of document + selection + configuration.

### `Resource` — extended

| Field | Meaning | Derivation |
|---|---|---|
| *(slice 1 fields unchanged)* | name, collectionPath, instancePath, idField, idType, representationSchema, createSchema, updateMode, listParams, operations | see slice 1 `data-model.md` §1 |
| **`idSpace`** | the identity space the reserved range lives in: `integer` \| `uuid` \| `formatted` (declared `pattern`/vendor prefix) \| `opaque` | the declared type+format of `idField` (FR-017) |
| **`pagingStyle`** | how this collection pages: `cursor-in-schema` \| `offset-limit` \| `page-size` \| `none-declared` | the list operation's query parameters **and** its 2xx response schema (a `paginationToken`-like property) — the target document's form is `cursor-in-schema` |
| **`filterFields` / `sortFields`** | the declared filterable/sortable properties | classified from `listParams`, as slice 1 already classifies them |
| **`count`** | absolute count, or a relative range over a parent | the recipe's `count` / `perParent` (FR-015) |

`idSpace` and `pagingStyle` are the two that make the *amendments* real: an integer-only reservation
and an offset/limit paging assumption are both wrong on the measured target, and both are visible in
the report.

### `Relationship` — extended

| Field | Meaning | Derivation |
|---|---|---|
| *(slice 1 fields unchanged)* | from, to, field, cardinality, evidence | see slice 1 |
| **`status`** | `decided` \| `undetermined` | `decided` when exactly one candidate survives the evidence order; `undetermined` when the convention yields ≥2 equally-plausible candidates or the name is a known-ambiguous one |
| **`candidates`** | the competing targets, when `undetermined` | the properties/targets that made it ambiguous |

**This is the FR-006 amendment made structural.** The measured target produces `externalId` 45 times
(different external system per collection) and co-locates `eventId`/`viagogoEventId`/
`primaryEventId`; a single `evidence: convention` field cannot express "the convention fired but did
not decide". A link with `status: undetermined` is **reported and not acted on** — it is not used to
order generation, and it produces no foreign-key constraint.

### `GenerationPlan` (new)

What generation will do, computed before any row is written, so it is reportable and golden-testable:

| Field | Meaning |
|---|---|
| `order` | collections in topological order over the `decided` relationships (FR-009) |
| `cycles` | any cycle among collections, named, generated deterministically with cyclic links reported (FR-008) |
| `perCollection[]` | `{ name, seed, count, idRange, fieldRules[] }` — the per-collection seed is `hash(globalSeed, name)` (FR-016/SC-007) |
| `refusals` | every reason generation must not proceed (unknown collection/field, overlapping ranges, contradicted spec) — non-empty ⇒ refuse to start (FR-005) |

### `StartupReport` — extended

Slice 1 carried live/not-selected operations, derived resources, relationships-with-evidence, and
ambiguities. Slice 2 **adds**: per-collection identity range and space, paging style, the generation
order and any cycles, **undetermined links with their candidates**, the precedence level that will
supply each unruled field, configured counts, and **counts by origin** (FR-004). The report is still
data, not a rendered string.

## 2. Configuration model (new — the four layers of FR-001)

Each layer is a separate file or folder, loadable without the others. All validated against
`contracts/config.schema.yaml`, which is the extended slice-1 contract (never a fork).

| Layer | File(s) | Consumer in this slice |
|---|---|---|
| **Fixtures** | `static/lookups/*.yaml`, `static/entities/*.yaml` | loaded; rows written with `origin='static'`; **never mutated** (FR-002) |
| **Imports** | `imports/*.mapping.yaml` + data | **shape defined and validated; not read** (slice 3) |
| **Recipes** | `dynamic/*.yaml` | loaded; the selected recipe drives generation (FR-003) |
| **Behaviour** | `behavior/*.yaml` | **parsed and validated only; not acted on** (slices 4–5) |

Key entities (the spec's own glossary, made concrete): **Fixture record**, **Lookup table**,
**Recipe**, **Generator** (built-in or custom), **Field rule**, **Invariant**, **Relationship**,
**Identity range**, **Origin**.

### Field rules (FR-011), and the precedence they sit in (FR-010)

A field rule is one instruction for one field. The set this slice must support (from the spec, and
from `docs/03`'s worked examples):

| Rule | Example (`docs/03`) | Precedence level it satisfies |
|---|---|---|
| `generator: <name>` | `section: { generator: sectionCode }` | 1 (explicit rule) |
| `faker: <path>` | `row: { faker: "string.alpha", length: 1 }` | 5 (plausible heuristic) |
| `lookup: <Table>` (uniform or `weights`) | `statusId: { lookup: InventoryStatus, weights: {...} }` | 3 |
| `ref: <Collection>.<field>` | `eventId: { ref: Event.id }` | 3/4 as applicable |
| `seq: <name>` | a monotonic sequence | 1 |
| `choice: [...]` | `generators.sectionCode: { choice: [...] }` | 1 |
| `expr: <jsonata>` | `price: { expr: "cost * $uniform(1.1, 2.5)" }` | 1 (calc over siblings, evaluated after its dependencies) |

Unlisted fields fall through the levels below them (supplied value → declared constraint/example →
heuristic → type default); the level that fired is recorded as value provenance (research §5).

### Invariants (FR-013)

A stated condition over a generated record (`constraints: ["price >= cost"]`), with a redraw budget;
past the budget the run **fails loudly naming the rule** rather than storing an invalid record.

## 3. Stored model (extensions in bold)

### Per-resource table — one addition

```sql
CREATE TABLE "<resource>" (
  id          TEXT PRIMARY KEY,
  origin      TEXT NOT NULL CHECK (origin IN ('static','imported','generated','runtime')),
  doc         TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX "<resource>_origin_idx" ON "<resource>" (origin);
-- NEW: a generated column for each field the document declares as filterable/sortable,
-- so a filtered/paged list is served by SQLite, not by reading every row into memory.
CREATE INDEX "<resource>_<field>_idx" ON "<resource>" (json_extract(doc, '$.<field>'));
```

The **generated index columns / indexes** are the item slice 1 §2 deferred here ("Slice 2 adds
generated/indexed columns for the fields used in list filters **and records why**"). The *why* is
recorded in the report: each indexed field names the declared list parameter that caused it.

### New / promoted metadata tables

```sql
-- Promoted from a single counter key to a table: slice 1 §4 deferred this
-- ("a range table when fixtures declare ranges"). Now that fixtures DO declare
-- ranges and ranges carry a SPACE, one integer counter is no longer sufficient.
CREATE TABLE _id_ranges (
  resource  TEXT PRIMARY KEY,
  id_space  TEXT NOT NULL,      -- 'integer' | 'uuid' | 'formatted' | 'opaque'
  declared  TEXT NOT NULL,      -- the configured/derived range or format, as written
  reserved  TEXT NOT NULL,      -- the span this tool will generate within
  next      TEXT,               -- next value to allocate (TEXT: uuid/formatted are not integers)
  updated_at TEXT NOT NULL
);
```

`_understudy_meta` keeps `spec_hash`, `config_hash`, `schema_version`, `created_at`, and gains
`recipe` (the selected recipe name) and `clock_mode` (real|virtual) so a reopened store can report
which mode produced its rows.

### Foreign-key constraints — the slice-1 deferral, now resolved

Slice 1 said plainly: *"Deliberately absent: foreign keys … slice 2 adds them, where generation
makes orphans possible."* So this slice adds them, with the policy the config exposes:

| Relationship `status` | Constraint |
|---|---|
| `decided`, cardinality `one`, `onDelete: restrict` (default) | a real `REFERENCES` clause; deleting a referenced parent refuses |
| `decided`, `onDelete: cascade` | `ON DELETE CASCADE` |
| `decided`, `onDelete: setNull` | `ON DELETE SET NULL` (the child link field is set to null) |
| **`undetermined`** | **no constraint.** The tool does not enforce a link it could not decide; the report lists it instead |

The last row is the point: enforcing an undetermined link would *hide* a real integration bug behind
a mock that looked consistent. `onDelete` is the fourth config key slice 1 §Constitution-Check
deliberately did **not** reserve ("reserving a shape for a key that has no object to hang from yet
would be noise") — it arrives here, where relationships become concrete.

### State transitions

- **generated** → row written `origin='generated'`, id from the collection's reserved range,
  `created_at`/`updated_at` from the clock seam; the identity advance and the row are one transaction.
- **fixture** → row written `origin='static'` with its **declared** identity; never updated by
  generation, import or API activity (FR-002, SC-003).
- **regeneration** → a re-run with the same seed produces byte-identical rows; generation does not
  mutate rows of another origin, and `wipe` (slice 1) still removes every non-`static` row.

## 4. What is deliberately not modelled yet

| Not modelled | Why | Where it lands |
|---|---|---|
| Import mapping execution, the `imported` origin in practice | imports are slice 3; this slice fixes the **shape** and validates it | slice 3 |
| Export / snapshot / restore tables | SC-002/SC-003 are asserted over a deterministic serialization; the shipped command is slice 3's | slice 3 |
| `_events`, `_outbox`, `_deliveries` | no domain events until the event bus | slice 4 |
| Action/reaction/simulation state | behaviour is validated, not run | slice 5 |
| A virtual clock's state, a Postgres adapter | the **seam** lands now, the implementation does not | slice 6 |
| `_subscriptions` (consumer-created) | deferred feature (E7) | slice 6 |

## 5. Clarifications recorded during implementation

### `_requests.live` — which clause wins

Slice 1's `data-model.md` §2 documented the column as "1 if the operation was selected, 0 if it
answered 501". Those two clauses were written when "a selected operation never answers 501" was
assumed — true until slice 2's convergence task T050 introduced a *selected* operation the derived
model cannot bind (a route with no resource), which answers `NOT_IMPLEMENTED` (501) instead of a
silent empty 2xx. Such a request is **selected** (clause 1 → `live=1`) *and* **answered 501**
(clause 2 → `live=0`): the frozen document supported two contradictory readings.

**Decision of record: the behavioural clause wins.** `live` means "did the mock's CRUD serve this
request?", so a *selected but unbound* operation is recorded `live=0`, exactly as the implementation
does. This is the reading the log's only consumer needs ("which requests hit real CRUD?"), and it is
consistent with the `live` query filter on `GET /requests`. The slice-1 comment has been corrected to
this wording in the same change. No requirement, schema or behaviour changes.
