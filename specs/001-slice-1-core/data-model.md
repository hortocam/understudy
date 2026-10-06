# Phase 1 — Data Model: Slice 1, Core CRUD Mock

Two layers: the **derived model** (what the tool works out about the document, in memory) and the
**stored model** (what is persisted, and the tables around it). The store's shape is fixed now
even where slice 1 is its only writer, because slices 2–3 add rows of other origins and slice 4
adds events; the seams are named in `plan.md` → Complexity Tracking.

## 1. Derived model (in memory, rebuilt at every startup)

Rebuilt rather than persisted: it is a pure function of the document plus the selection, and
persisting it would create a second thing that can go stale against the spec — the exact failure
`docs/02` §13 names.

### `Resource`

| Field | Meaning | Derivation |
|---|---|---|
| `name` | entity name, e.g. `Inventory` | response schema `title`, else singularised collection path segment |
| `collectionPath` | path template for the collection, e.g. `/inventory` | the live operation's path |
| `instancePath` | path template for one instance, if any, e.g. `/inventory/{id}` | a live path extending the collection path by one parameter |
| `idField` | name of the identity property | the instance path parameter if the representation declares it, else `id` |
| `idType` | `integer` \| `string` \| `string`+`pattern` | the declared schema type of `idField` |
| `representationSchema` | the shape returned to consumers | the 2xx response schema of the producing operation |
| `createSchema` | the accepted shape for create | POST request body schema |
| `updateMode` | `merge` \| `replace` | PATCH → `merge`, PUT → `replace` (FR-006) |
| `listParams` | declared filter/sort/paging parameters | the list operation's query parameters, classified |
| `operations` | which methods are live for this resource | the selection |

### `Relationship`

| Field | Meaning | Derivation |
|---|---|---|
| `from` / `to` | `Resource` names | see evidence order below |
| `field` | the property carrying the link | the schema property that produced it |
| `cardinality` | `one` \| `many` | the property's type (scalar vs array) |
| `evidence` | **which rule decided it** | `configured` \| `extension` \| `convention` \| `nesting` |

`evidence` is the field that makes principle VI checkable: the startup report prints it, so a
`convention` guess on a real vendor document is visible for what it is. Inference order is
configured → extension → convention → nesting (`docs/02` §3).

### `Selection`

The resolved operation set: for each entry in the config's `operations`, the matched
`METHOD /path` and its `operationId` if it has one; plus the complement (live operations that exist
in the document but were not selected) which answers "not implemented in this mock" (FR-003).

### `StartupReport`

A plain data structure (not a formatted string — `spec/report.ts` builds data, the caller renders)
carrying: live operations, not-selected operations, derived resources, derived relationships with
their evidence, and an explicit list of **ambiguities** (paths that matched no resource, operations
with no declared 2xx schema, documents with no declared list parameters). This is the artefact
FR-023/FR-024 and SC-006 are measured against.

## 2. Stored model

### Tables

One table per derived resource, created on first start (and on a resource's first appearance after
a spec change):

```sql
CREATE TABLE "<resource>" (
  id          TEXT PRIMARY KEY,      -- stored as text; typed by the derived idType on read
  origin      TEXT NOT NULL          -- 'runtime' in slice 1; slices 2-3 add the other three
                CHECK (origin IN ('static','imported','generated','runtime')),
  doc         TEXT NOT NULL,         -- the record body, JSON, stored as the consumer's own field names
  created_at  TEXT NOT NULL,         -- ISO-8601 UTC
  updated_at  TEXT NOT NULL
);
CREATE INDEX "<resource>_origin_idx" ON "<resource>" (origin);
```

**Why `id` is `TEXT`:** identities in the wild are integers, strings, and vendor-formatted
strings. Text stores all three, and the derived `idType` decides how it is produced and how it is
rendered back, so a consumer sees an integer where the document declares an integer. Typing the
column per resource instead would mean DDL that varies by document, which makes migrations (slice
3) and indexing (slice 2) document-dependent for no gain here.

**Why `doc` is a JSON blob rather than columns:** the shape is the document's, not ours. Columns
would have to be derived per resource and migrated whenever the document changes, and slice 1 needs
no query that JSON cannot serve. Slice 2 adds generated/indexed columns for the fields used in list
filters *and records why*, per `docs/02` §4.

**Deliberately absent:** foreign keys. Slice 1 derives relationships for its report but enforces
nothing (no writes to reject yet); slice 2 adds them, where generation makes orphans possible.

### Metadata tables

```sql
CREATE TABLE _understudy_meta (
  key   TEXT PRIMARY KEY,   -- 'spec_hash' | 'config_hash' | 'schema_version' | 'created_at'
  value TEXT NOT NULL
);

CREATE TABLE _requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,     -- ISO-8601 UTC
  method      TEXT NOT NULL,
  path        TEXT NOT NULL,     -- the concrete path, as received
  status      INTEGER NOT NULL,
  live        INTEGER NOT NULL,  -- 1 if the mock's CRUD served the request, 0 if the answer was a 501
  duration_ms INTEGER NOT NULL
);
CREATE INDEX _requests_at_idx ON _requests (at);
```

`_understudy_meta.schema_version` is the store's own version, distinct from the OpenAPI version:
it is what a future slice reads to decide whether it can use an existing database, and it is why
`spec_hash` mismatch is a warning rather than a silent reinterpretation of old rows (`docs/02` §4).

### Identity allocation

| Declared `idType` | Generated as |
|---|---|
| `integer` | next value from a per-resource counter starting at `ids.generatedStart` (default `100000`) |
| `string` | a value satisfying the declared `pattern` where present, else an opaque short id, from the same reserved space |
| (none declared) | integer, as above |

The counter lives in `_understudy_meta` (`id_seq:<resource>`), not in the table, so a wiped table
does not recycle identities a consumer may still hold. Reserved-range checking (FR-011) refuses to
start when a configured range overlaps the values slice 2's fixtures will declare.

## 3. State transitions

A record in slice 1 has one origin (`runtime`) and two lifecycle events worth naming, because the
reset semantics of slice 3 depend on them being well defined now:

- **created** → `origin=runtime`, `created_at` set, `updated_at` equal to it
- **updated** → `doc` replaced (PUT) or merged (PATCH), `updated_at` advanced, `created_at` fixed
- **deleted** → row removed

Reset (`wipe`) removes every row whose `origin` is not `static` — in slice 1, all of them — and
**resets the identity counters**, because a wiped mock is expected to start counting again where it
began. `baseline` and `runtime-only`, when slice 3 lands, will read the same `origin` tag.

## 4. What is deliberately not modelled yet

| Not modelled | Why | Where it lands |
|---|---|---|
| `_events`, `_outbox`, `_deliveries` | no domain events until the event bus exists | slice 4 |
| `_id_ranges` as a table | a single counter key in `_understudy_meta` is enough for one writer | slice 2 (when fixtures declare ranges) |
| `_subscriptions` | consumer-created subscriptions are a deferred feature (E7) | slice 6 |
| Foreign-key constraints and `onDelete` policy | nothing can create an orphan until generation and import exist | slice 2 |
| Snapshot/restore tables | snapshot is a checkpointed file copy, not rows | slice 3 |
