# Demo — Slice 2: data layer I (configuration and generation)

Runnable walkthrough of slice 2: verbatim commands and their **observed** results, covering every
phase of the slice. It is the script for the human checkpoint — run it and watch the data layer
work. [`quickstart.md`](quickstart.md) is the (longer) runnable-validation document with a recorded
run in [`quickstart-run.txt`](quickstart-run.txt); this file is the *human* cycle, organised by
phase and re-run on the merged revision.

## Prerequisites

Node.js 22+ and a checkout of this repository.

```bash
REPO=/path/to/understudy            # <- absolute path to your checkout
cd "$REPO" && npm ci && npm run build
node dist/cli/index.js --help       # note `init` and `generate`, new in this slice
```

A fresh scratch project, seeded with slice 2's dataset — the fixtures and recipes that ship in
`tests/fixtures/gen-project/`:

```bash
mkdir -p /tmp/demo2 && cd /tmp/demo2
cp -r "$REPO/tests/fixtures/gen-project/static" .
mkdir -p dynamic && cp "$REPO/tests/fixtures/gen-project/dynamic/"*.yaml dynamic/
```

One project config over the multi-collection `shop-api.yaml`, with the clock pinned so a seeded run
is byte-reproducible. (Only operations you make live are collected, so the enumeration matters; a
tag entry for a document that declares no tags refuses to start.)

```bash
cat > understudy.yaml <<YAML
spec: $REPO/tests/fixtures/shop-api.yaml
operations:
  - GET /venues
  - POST /venues
  - GET /venues/{id}
  - PATCH /venues/{id}
  - DELETE /venues/{id}
  - GET /events
  - POST /events
  - GET /events/{id}
  - PATCH /events/{id}
  - DELETE /events/{id}
  - GET /inventory
  - POST /inventory
  - GET /inventory/{id}
  - PATCH /inventory/{id}
  - DELETE /inventory/{id}
  - GET /inventory-statuses
  - POST /inventory-statuses
  - GET /inventory-statuses/{id}
  - PATCH /inventory-statuses/{id}
  - DELETE /inventory-statuses/{id}
  - GET /audit-notes
  - POST /audit-notes
  - GET /audit-notes/{id}
  - PATCH /audit-notes/{id}
  - DELETE /audit-notes/{id}
server:  { port: 8080 }
storage: { driver: sqlite, path: ./.understudy/state.db }
paths:   { static: ./static, dynamic: ./dynamic }
clock:   { mode: real, start: "2026-01-01T00:00:00Z" }
YAML
```

> Every `up` below **serves until torn down**, so run each in its own shell (or background it). The
> scenarios below are ordered so `down` releases the port before the next `up`; if you see
> `EADDRINUSE`, the previous instance is still running.

## Scenario 1 — start with a recipe: fixtures and generation (Phases 2, 5, 6, 8)

```bash
node dist/cli/index.js up --config ./understudy.yaml --recipe ci-small --seed 42
```

**Expected**, the report naming the derived collections, the **inferred links with their evidence**,
the **undetermined** ones listed separately, and the configured counts — then the generation summary:

```
entities derived (5):
  Venue (/venues instance /venues/{id}) id=id:integer space=integer paging=offset-limit …
  Event (/events instance /events/{id}) id=id:integer … params=[limit:paging,offset:paging,sort:sort,venueId:filter]
  …
relationships inferred (2):
  Event -> Venue via venueId [one, convention]
  Inventory -> Event via eventId [one, convention]

undetermined links (2) — reported, not acted on:
  AuditNote.externalId (no single target) [convention]
    pin it with entities.AuditNote.relations.externalId: { to: <Collection>.<id> } if it is a link
  AuditNote.referenceId (no single target) [convention]
    …

configured counts:
  Venue: 3 records
  Event: 2..4 per Venue (via venueId, uniform)
  Inventory: 5..12 per Event (via eventId, zipf)

generation: recipe ci-small, seed 42 — 133 records created, 0 invariant redraws
  created Venue: generated 3
  created Event: generated 13
  created Inventory: generated 117
records by origin:
  Event: generated 13, static 2
  InventoryStatus: static 4
  Venue: generated 3, static 2
```

Every inferred link names its evidence (`convention` here); the two `AuditNote` reference fields are
**undetermined** — reported with their pinning recipe, never silently resolved (constitution VI).

## Scenario 2 — `init` scaffolds from the tool's own understanding (Phase 9; FR-020, US4)

```bash
mkdir initdemo && cd initdemo
node ../dist/cli/index.js init --spec "$REPO/tests/fixtures/inventory-api.yaml"
```

**Expected**: the four layer folders (`static/{lookups,entities}`, `imports`, `dynamic`, `behavior`)
and an `understudy.yaml`, and stdout prints the report **of the spec `init` was pointed at** — here
`inventory-api.yaml`'s two collections — so nothing is scaffolded from a guess. It ends:

```
wrote 7 files under /tmp/demo2/initdemo:
  wrote …/behavior/webhooks.yaml.example
  wrote …/dynamic/ci-small.yaml.example
  wrote …/dynamic/starter.yaml
  wrote …/imports/events.mapping.yaml.example
  wrote …/static/entities/venues.yaml.example
  wrote …/static/lookups/inventory-statuses.yaml.example
  wrote …/understudy.yaml
next: review the report above, pin anything undetermined in understudy.yaml, then `ustdy up --recipe starter`.
```

`cd ..` to return to the project.

## Scenario 3 — fixtures are byte-identical forever (Phases 5, 10; FR-002, SC-003, US1)

Start without a recipe so only `static/` is loaded, read the fixture rows, mutate over the API, and
read them again:

```bash
rm -rf .understudy
node dist/cli/index.js up --config ./understudy.yaml &
sleep 2
curl -s localhost:8080/venues | jq -S '[.[]|select(.id<100000)]' > /tmp/f1.json
for i in 1 2 3; do
  curl -s -X POST localhost:8080/venues -H 'content-type: application/json' -d '{"name":"Runtime Hall"}' >/dev/null
done
curl -s localhost:8080/venues | jq -S '[.[]|select(.id<100000)]' > /tmp/f2.json
diff /tmp/f1.json /tmp/f2.json && echo "OK: the fixture rows are byte-identical after 3 API writes"
node dist/cli/index.js down --config ./understudy.yaml
```

**Expected**: `OK: the fixture rows are byte-identical after 3 API writes` — the fixture rows
(identities below `ids.generatedStart`) survive the writes unchanged, and restart reproduces them.
There is **no `_origin` field** in a served record; origin is internal (the report's `records by
origin` and `reset` are where you see it).

## Scenario 4 — generation is deterministic and independent per collection (Phases 6, 10; FR-016, SC-002, SC-007)

```bash
snap() { for c in venues events inventory; do curl -s "localhost:8080/$c" | jq -S 'sort_by(.id)'; done; }
run() { rm -rf .understudy; node dist/cli/index.js up --config ./understudy.yaml "$@" & \
        for i in $(seq 1 200); do curl -sf localhost:8080/__understudy/health >/dev/null 2>&1 && break; sleep 0.2; done; }

run --recipe ci-small --seed 42      ;  snap > /tmp/d1.json ;  node dist/cli/index.js down --config ./understudy.yaml
run --recipe ci-small --seed 42      ;  snap > /tmp/d2.json ;  node dist/cli/index.js down --config ./understudy.yaml
run --recipe ci-small --seed 7       ;  snap > /tmp/d3.json ;  node dist/cli/index.js down --config ./understudy.yaml
run --recipe ci-small-plus --seed 42 ;  snap > /tmp/d4.json ;  node dist/cli/index.js down --config ./understudy.yaml

diff /tmp/d1.json /tmp/d2.json && echo "OK: same seed -> byte-identical"
diff /tmp/d1.json /tmp/d3.json >/dev/null || echo "OK: a different seed changes the data"
diff /tmp/d1.json /tmp/d4.json && echo "OK: adding an unrelated collection (AuditNote) moved nothing"
```

**Expected**: the first `diff` and the last are empty; the middle line prints. Observed byte sizes
were `31816`, `31816`, `27572`, `31816` and `d1`/`d2` shared sha `d34b68582add3724…`. `ci-small-plus`
declares an **unrelated** `AuditNote` collection, generated *first* — and every existing collection's
records are unchanged, because each collection draws from its own stream derived from
`(seed, collection name)`.

## Scenario 5 — identities never collide, and an overlap refuses (Phase 7; FR-017/018, SC-006)

```bash
rm -rf .understudy && node dist/cli/index.js up --config ./understudy.yaml --recipe ci-small --seed 42 &
sleep 2
for c in venues events inventory; do echo "duplicate ids in /$c: [$(curl -s localhost:8080/$c | jq -r '.[].id' | sort -n | uniq -d | tr '\n' ' ')]"; done
node dist/cli/index.js down --config ./understudy.yaml
```

**Expected**: `[]` for each — no identity is allocated twice.

**Negative control** — a range that overlaps a fixture identity must refuse to start, naming the
collection:

```bash
cat > overlap.yaml <<YAML
spec: $REPO/tests/fixtures/shop-api.yaml
operations: [GET /venues, POST /venues]
storage: { driver: sqlite, path: ./.understudy/o.db }
paths:   { static: ./static, dynamic: ./dynamic }
entities: { Venue: { ids: { generatedStart: 1 } } }
YAML
node dist/cli/index.js up --config ./overlap.yaml
```

**Expected**, a non-zero exit:

```
understudy: refusing to start: 17 configuration problems:
  understudy.yaml: entities.Venue.ids.generatedStart — fixture identity 1 of Venue lies at or above the generated range start 1; the ranges overlap
  static/entities/events.yaml: entity — Event is neither a collection of the live operations nor a lookup table (lookups live under static/lookups/)
  …
```

The first line is the one under test; the rest are collateral (this project makes fewer operations
live, so `static/entities/events.yaml` no longer names a collection). It names the collection and the
cause, not a stack trace.

## Scenario 6 — a stated invariant is enforced or the run fails loudly (Phase 8; FR-013)

```bash
node dist/cli/index.js up --config ./understudy.yaml --recipe impossible
```

**Expected**, a non-zero exit, naming the rule and stating nothing was stored:

```
understudy: refusing to start: collection Inventory: the invariant "price > 1000000" could not be satisfied within 5 redraws; nothing was stored
```

It never stores a record that violates a stated invariant, and never silently drops the invariant.

## Scenario 7 — the behaviour layer is validated but not run (Phase 2; FR-005)

The `behavior/` layer is parsed and validated in this slice even though nothing acts on it until
slices 4–5. Introduce a typo:

```bash
mkdir -p behavior
printf 'targets:\n  pos:\n    urll: http://localhost:9000/hooks/pos\n' > behavior/webhooks.yaml
node dist/cli/index.js up --config ./understudy.yaml
rm -rf behavior
```

**Expected**, a non-zero exit with the same message shape as a bad `understudy.yaml` key:

```
understudy: refusing to start: behavior/webhooks.yaml: targets.pos.url — missing required key "url" (behavior layer)
```

## Scenario 8 — scale: thousands of rows, generated and serving (Phase 10; SC-008)

```bash
rm -rf .understudy && node dist/cli/index.js up --config ./understudy.yaml --recipe load-test &
until curl -sf localhost:8080/__understudy/health >/dev/null; do sleep 0.1; done
for c in venues events inventory audit-notes inventory-statuses; do echo "$c: $(curl -s localhost:8080/$c | jq 'length')"; done
echo "page of 25 from /inventory?limit=25&offset=1000: $(curl -s 'localhost:8080/inventory?limit=25&offset=1000' | jq 'length')"
node dist/cli/index.js down --config ./understudy.yaml
```

**Expected**: a few thousand records across five collections and a paged read working:

```
venues: 32
events: 817
inventory: 5316
audit-notes: 500
inventory-statuses: 54
page of 25 from /inventory?limit=25&offset=1000: 25
```

The committed recorded run (`quickstart-run.txt`) timed generation-and-serving at ~2.9 s — the bar
is "well under a minute" on a developer machine.

## Scenario 9 — apply a recipe to a *running* mock (Phase 9; FR-021)

```bash
rm -rf .understudy && node dist/cli/index.js up --config ./understudy.yaml &
sleep 2
echo "venues before: $(curl -s localhost:8080/venues | jq 'length')"          # 2 — the fixtures only
node dist/cli/index.js generate --recipe ci-small --seed 42 --config ./understudy.yaml
echo "venues after:  $(curl -s localhost:8080/venues | jq 'length')"          # 5
```

**Expected**:

```
created, by collection and origin:
  Venue: generated 3  (total: generated 3, static 2)
  Event: generated 13  (total: generated 13, static 2)
  Inventory: generated 117  (total: generated 117)
```

Now the guards — re-applying the same recipe is a **no-op that says so**, and a different seed is
**refused**:

```bash
node dist/cli/index.js generate --recipe ci-small --seed 42 --config ./understudy.yaml
node dist/cli/index.js generate --recipe ci-small --seed 1  --config ./understudy.yaml
```

**Expected**:

```
already applied: recipe ci-small, seed 42 — the store holds this recipe, seed and configuration; nothing regenerated
ustdy: the store already holds generated records with seed "42", not "1"; run `ustdy reset --to wipe` first
```

**Negative control** — the remedy the refusal names, with the new seed:

```bash
node dist/cli/index.js reset --to wipe --config ./understudy.yaml
node dist/cli/index.js generate --recipe ci-small --seed 1 --config ./understudy.yaml
node dist/cli/index.js down --config ./understudy.yaml
```

**Expected**: `reset` reports the rows removed per entity (`Venue: 3, Event: 13, Inventory: 117,
InventoryStatus: 0, AuditNote: 0`), then generation runs at seed 1 (`Inventory: generated 94 …`) —
a different dataset, from a different seed, on a wiped store.

## Scenario 10 — the report tells the truth about inference (Phase 4; FR-007, SC-005, US4)

A document whose reference fields are genuinely ambiguous (the `collisions-api.yaml` fixture mimics
the vendor document) lists those links as **undetermined with their candidates**, rather than
picking one:

```bash
node dist/cli/index.js init --spec "$REPO/tests/fixtures/collisions-api.yaml" --dir ./collide
```

**Expected**:

```
undetermined links (8) — reported, not acted on:
  Order.externalId (no single target) [convention]
    pin it with entities.Order.relations.externalId: { to: <Collection>.<id> } if it is a link
  Order.eventId -> Event [convention]  candidates: eventId, primaryEventId, viagogoEventId
    pin it with entities.Order.relations.eventId: { to: <Collection>.<id> } if it is a link
  …
```

Each decided link names its evidence source (`configured` | `extension` | `convention` | `nesting`);
no link is resolved silently.

## Scenario 11 — a refusal names the cause (Phases 2, 11; FR-005)

```bash
cat > bad.yaml <<YAML
spec: $REPO/tests/fixtures/shop-api.yaml
operations: [GET /venues]
storage: { driver: postgres, path: ./.understudy/x.db }
YAML
node dist/cli/index.js up --config ./bad.yaml
```

**Expected**, a non-zero exit:

```
understudy: refusing to start: the config key storage.driver is reserved: the postgres adapter is a later slice; only "sqlite" is implemented
```

> Known wart: the refusal is currently printed **three times** (a rendered line, a structured log
> line, and a repeat from the CLI). One logical refusal, three copies. Tracked for a fix.

## Tidy up

```bash
node dist/cli/index.js down --config ./understudy.yaml   # if anything is still running
```

---

## Recorded run

Executed as written against the merged revision, in a throwaway directory.

- revision: `83c9737` · node: `v22.23.2` · date: `2026-10-06`
- determinism: `d1 == d2` byte-identical (31816 bytes, sha `d34b68582add3724…`); seed 7 → 27572 bytes; `ci-small-plus` → `d1 == d4` (independence)
- gate: `npm run lint` clean · `npm run typecheck` clean · `npm run test` → **539 passed (66 files)**

## What this slice does not yet do

- **Import** execution (the `imports/` layer is shape-validated only) — slice 3.
- **Export / snapshot / restore**, and the `baseline`/`runtime-only` reset modes — slice 3.
- The **behaviour** layer (webhooks, actions, reactions, simulations) is parsed and validated only —
  slices 4–5.
- `storage.driver: postgres`, `clock.mode: virtual`, `signing`, and `entities.<X>.writes:
  actions-only` are **reserved** keys: accepted by the schema so the shape is stable, refused on
  presence until their slices land.
