# Demo — Slice 1: core CRUD mock

Runnable walkthrough of slice 1: verbatim commands and their **observed** results, covering every
phase of the slice (T001–T045). It is the script for the human checkpoint — run it to see the
behaviour for yourself before accepting the slice.

It overlaps on purpose with [`quickstart.md`](quickstart.md), which is the contract suite's automated
script; this file is the *human* cycle and is organised by phase so each task maps to something you
saw happen.

## Prerequisites

Node.js 22+ and a checkout of this repository.

```bash
npm ci
npm run build                       # tsc -> dist/
node dist/cli/index.js --help       # the `ustdy` surface (Phases 1+2)
```

You should see `up`, `down`, `init`, `generate`, `ops`, `reset`, `logs`, `help` — the CLI is a thin
client, so every command is one control request.

A fresh scratch directory keeps this repeatable:

```bash
mkdir -p /tmp/demo1 && cd /tmp/demo1
```

Write the project configuration:

```bash
cat > understudy.yaml <<'YAML'
spec: /path/to/understudy/tests/fixtures/inventory-api.yaml   # <- absolute path to this checkout
operations:
  - POST   /inventory
  - GET    /inventory
  - GET    /inventory/{id}
  - PATCH  /inventory/{id}
  - DELETE /inventory/{id}
server:  { port: 8080 }
control: { prefix: /__understudy }
storage: { driver: sqlite, path: ./.understudy/state.db }
ids:     { generatedStart: 100000 }
YAML
```

## Scenario 1 — start it and read the report (Phases 6, 3)

```bash
node dist/cli/index.js up --config ./understudy.yaml
```

Run it in one terminal; it **serves until torn down**, so it does not return on its own. **Expected**,
a report naming each set on its own line, then a ready line:

```
live operations (5):
  POST /inventory (createInventory)
  GET /inventory (listInventory)
  GET /inventory/{id} (getInventoryById)
  PATCH /inventory/{id} (updateInventory)
  DELETE /inventory/{id} (deleteInventory)

not selected (1):
  GET /events (listEvents)

entities derived (1):
  Inventory (/inventory instance /inventory/{id}) id=id:integer space=integer paging=offset-limit …
relationships inferred (0):
undetermined links (0) — reported, not acted on:
generation order: Inventory
identity ranges (reserved per collection, kept disjoint from fixtures):
  Inventory: integer — reserved 100000.. [generatedStart=100000]
ambiguities (1):
  clock-unpinned: the real clock is not pinned, so time-derived values and record timestamps differ …
ready: control plane at http://127.0.0.1:8080/__understudy  mock at http://127.0.0.1:8080
```

The report is also one structured log line, so it can be asserted rather than read by eye
(SC-006). In another terminal:

```bash
node dist/cli/index.js up --config ./understudy.yaml 2>&1 \
  | grep '"message":"startup report"' | head -1 | jq -e '.report.live | length == 5' >/dev/null \
  && echo "SC-006 OK: report.live carries the 5 selected operations"
```

**Expected**: `SC-006 OK: report.live carries the 5 selected operations`. (This second `up` will
fail to bind — the instance is already running. Stop the first one first, or read its own log.)
Notice `clock-unpinned` is *reported*, not hidden: the real clock is not pinned here, so
time-derived values vary between runs.

## Scenario 2 — CRUD persists across a restart (Phase 3; SC-002, FR-010)

With the mock from Scenario 1 still running:

```bash
# the negative control first: read a record that does not exist.
# 404 is the document's own declared status for this path.
curl -s -o /dev/null -w 'GET /inventory/999999 -> %{http_code}\n' localhost:8080/inventory/999999

# create one record
curl -s -X POST localhost:8080/inventory -H 'content-type: application/json' \
  -d '{"sku":"GA-100","quantity":4}'
```

**Expected**: `GET /inventory/999999 -> 404`, then the created record in the **document's own
shape**, with a generated identity at or above `ids.generatedStart`:

```json
{"sku":"GA-100","quantity":4,"id":100000}
```

There is **no** `_origin` field in the response — origin is internal and surfaced only through the
control API's counts and `reset`. Restart and read it back:

```bash
node dist/cli/index.js down --config ./understudy.yaml
node dist/cli/index.js up   --config ./understudy.yaml     # leave it running again
curl -s localhost:8080/inventory/100000
```

**Expected**: the same record — it survived the restart.

## Scenario 3 — a not-implemented answer is distinct from a declared one (Phase 3; SC-004, FR-003)

```bash
curl -s -o /dev/null -w 'GET  /inventory/999999 -> %{http_code}\n' localhost:8080/inventory/999999
curl -s -o /dev/null -w 'GET  /events           -> %{http_code}\n' localhost:8080/events
curl -s localhost:8080/events
```

**Expected**: two *different* statuses — `404` for the missing record (declared) and `501` for the
operation that was never selected. The 501 body identifies the operation:

```json
{"error":"not_implemented","method":"GET","path":"/events",
 "detail":"operation GET /events (listEvents) is in the document but was not selected; this mock does not implement it",
 "operationId":"listEvents"}
```

## Scenario 4 — validation is the document's, not ours (Phase 3; FR-008)

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:8080/inventory \
  -H 'content-type: application/json' -d '{"sku":"GA-100","quantity":"lots"}'
```

**Expected**: `400` — the document declares an integer with a minimum, and this violates it. Not a
`200` (silently accepted) and not a `500` (our bug).

## Scenario 5 — drive the control plane (Phase 4; FR-012–FR-018)

```bash
curl -s localhost:8080/__understudy/health      # {"status":"ok","store":{"reachable":true,"path":"./.understudy/state.db"}}
curl -s localhost:8080/__understudy/operations | jq -c '{live:(.live|length), notImplemented:(.notImplemented|length)}'
curl -s 'localhost:8080/__understudy/requests?status=501' | jq -c '.requests[] | {method,path,status,live}'
curl -s localhost:8080/__understudy/openapi.json | jq -c 'keys'
```

**Expected**: `{"live":5,"notImplemented":1}`; the 501 requests logged with `"live":false`; and
`["components","info","openapi","paths"]` for the control API's own description. Note `openapi.json`
is a *checked-in* artefact served byte-identically, not generated from the code — a served copy
that could never disagree with the implementation would be the opposite of a contract.

## Scenario 6 — the CLI adds no logic (Phase 5; SC-005, FR-019)

```bash
node dist/cli/index.js ops list --config ./understudy.yaml
node dist/cli/index.js logs requests --status 501 --config ./understudy.yaml
```

**Expected**: each agrees with the control API's own answer (`ops list` prints the live and
not-implemented sets; `logs requests` prints the same 501 lines).

**Negative control** — with the control plane unreachable, a client command **fails** rather than
falling back to doing the work locally:

```bash
node dist/cli/index.js reset --to wipe --control-url http://127.0.0.1:9/__understudy
```

**Expected**, on stderr and a non-zero exit:

```
ustdy: cannot reach the control plane at http://127.0.0.1:9/__understudy (bad port); is the mock running? …
```

## Scenario 7 — instance isolation (Phase 7; SC-007)

```bash
cat > understudy-b.yaml <<'YAML'
spec: /path/to/understudy/tests/fixtures/inventory-api.yaml
operations: [POST /inventory, GET /inventory]
server:  { port: 8081 }
storage: { driver: sqlite, path: ./.understudy/state-b.db }
YAML
node dist/cli/index.js up --config ./understudy-b.yaml &
sleep 2
curl -s -X POST localhost:8080/inventory -H 'content-type: application/json' -d '{"sku":"A","quantity":1}'
curl -s localhost:8081/inventory
```

**Expected**: `[]` on 8081 — the record created on 8080 is not visible, because each instance has
its own store file. Two instances need **distinct ports and distinct store files**: a shared store
file is shared state, not isolation.

## Scenario 8 — a refusal is loud and names the cause (Phase 6, FR-005)

```bash
cat > bad.yaml <<'YAML'
spec: /path/to/understudy/tests/fixtures/inventory-api.yaml
operations: [GET /inventory]
storage: { driver: postgres, path: ./.understudy/x.db }
YAML
node dist/cli/index.js up --config ./bad.yaml
```

**Expected**: refuses to start and names the key, with a non-zero exit:

```
understudy: refusing to start: the config key storage.driver is reserved: the postgres adapter is a later slice; only "sqlite" is implemented
```

> Known wart: the refusal is currently printed **three times** (a rendered line, a structured log
> line, and a repeat from the CLI). One logical refusal, three copies. Tracked for a fix.

## Tidy up

```bash
node dist/cli/index.js reset --to wipe --config ./understudy.yaml   # rows removed per entity
node dist/cli/index.js down --config ./understudy.yaml              # the port is released
curl -s -o /dev/null -w '%{http_code}\n' localhost:8080/__understudy/health   # 000 (refused)
```

**Expected**: `reset` reports the rows it removed; `down` reports the control plane released; the
health probe cannot connect (`000`) once the mock is gone.

---

## Recorded run

Executed as written against the merged revision, in a throwaway directory.

- revision: `83c9737` · node: `v22.23.2` · date: `2026-10-06`
- gate: `npm run lint` clean · `npm run typecheck` clean · `npm run test` → **539 passed (66 files)**

## What slice 1 does not yet do

- The store starts **empty**: no generation, no fixtures, no import (slice 2).
- `reset` implements **wipe only**; `baseline` and `runtime-only` arrive with the data layer.
- No events, no webhooks (slice 4); no actions or simulation (slice 5).
- The mocked surface is **unauthenticated** — whether consumers must present an auth header is a
  deferred decision.
