# Quickstart — validating slice 1

A runnable guide that proves the feature works end to end. It is also the script the contract
suite automates; every step below has a matching test in `tests/contract/`.

Commands below use `ustdy`. After `npm ci && npm run build`, run it either as
`node dist/cli/index.js <command>` (always available, offline) or, if the package is linked onto
your `PATH`, as `ustdy <command>` — the two are the same program.

## Prerequisites

Node 22+ and a checkout of this repository.

```bash
npm ci
npm run build      # tsc -> dist/
```

## 1. A fixture document to mock

`tests/fixtures/inventory-api.yaml` is a small OpenAPI 3.1 document with one inventory collection:
`POST /inventory`, `GET /inventory`, `GET /inventory/{id}`, `PATCH /inventory/{id}`,
`DELETE /inventory/{id}`, plus one operation the mock will *not* be asked to serve. It exists to be
the acceptance target; it is not a stand-in for a real vendor document.

## 2. A project configuration

```yaml
# understudy.yaml — every key documented in contracts/config.schema.yaml
spec: ./tests/fixtures/inventory-api.yaml
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
```

## 3. Start it

Time this step: from a clean checkout, **`npm ci` → first successful response must be under
5 minutes** (SC-001). Note the wall-clock start before §1 and the time the mock answers in §4.

```bash
node dist/cli/index.js up --config ./understudy.yaml
```

**Expected**: the process prints the startup report and starts serving. The report must name, each
on its own line and machine-checkably (SC-006):

- **every live operation** — the five from the config, by method and path;
- **every not-selected operation** — including the deliberately-unselected one in the fixture;
- **every derived resource**, with its identity field and identity type;
- **every inferred relationship with its evidence source**, rendered so a `convention`-sourced
  link is distinguishable from a `configured` one;
- **every ambiguity** — a path that matched no resource, an operation with no declared 2xx schema,
  a document with no declared list parameters.

```bash
# The report is ALSO emitted as one structured log line, interleaved with the human text on
# stdout. Extract that line and assert its parts, rather than reading the prose by eye.
node dist/cli/index.js up --config ./understudy.yaml 2>&1 | \
  grep '"message":"startup report"' | head -1 | jq -e \
  '.report.live | length == 5' \
  && echo "SC-006: report carries the live set"
```

## 4. Prove CRUD persists across a restart (SC-002, FR-010)

```bash
curl -s -X POST localhost:8080/inventory -H 'content-type: application/json' \
  -d '{"sku":"GA-100","quantity":4}' | tee /tmp/created.json

ID=$(jq -r .id /tmp/created.json)     # an integer, >= 100000
curl -s localhost:8080/inventory/$ID  # the record, in the document's own shape

node dist/cli/index.js down
node dist/cli/index.js up --config ./understudy.yaml
curl -s localhost:8080/inventory/$ID  # STILL the record: it survived the restart
```

**Negative control**: the same read before the create must answer the document's declared
not-found status. A mock that answers nothing with 200 is not passing this.

## 5. Prove the not-implemented answer is distinct (SC-004, FR-003)

```bash
curl -s -o /dev/null -w '%{http_code}\n' localhost:8080/inventory/999999   # not found
curl -s -o /dev/null -w '%{http_code}\n' localhost:8080/events             # 501, not 404
```

**Expected**: two *different* statuses. The 501 body identifies the unimplemented operation.

## 6. Prove validation is the document's, not ours (FR-008, SC-003)

```bash
# 'quantity' is declared an integer with a minimum; a string must be refused with the
# document's declared error status, not a 200 and not a 500.
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:8080/inventory \
  -H 'content-type: application/json' -d '{"sku":"GA-100","quantity":"lots"}'
```

## 7. Drive the control plane (FR-012–FR-018)

```bash
curl -s localhost:8080/__understudy/health      # { status: ok, store: { reachable: true } }
curl -s localhost:8080/__understudy/operations  # { live: [...], notImplemented: [...] }
curl -s localhost:8080/__understudy/requests    # the requests from steps 4-6
curl -s -X POST localhost:8080/__understudy/reset -H 'content-type: application/json' \
  -d '{"mode":"wipe"}'
curl -s localhost:8080/__understudy/requests?status=501
curl -s localhost:8080/__understudy/openapi.json # this API's own description
```

## 8. Prove the CLI adds no logic (SC-005, FR-019)

```bash
node dist/cli/index.js ops list
node dist/cli/index.js logs requests --status 501
node dist/cli/index.js reset --to wipe
node dist/cli/index.js down
```

**Expected**: each command's output agrees with the control API's own answer for the same
request. With the control plane stopped, each command fails with a clear connection error rather
than falling back to doing the work locally — that is what proves it is a client.

## 9. Prove instance isolation (SC-007)

Two instances need **distinct ports and distinct store files** — a shared store file is shared
state, not isolation. Give the second instance its own config:

```bash
cat > ./understudy-b.yaml <<'YAML'
spec: ./tests/fixtures/inventory-api.yaml
operations: [POST /inventory, GET /inventory]
server:  { port: 8081 }
storage: { driver: sqlite, path: ./.understudy/state-b.db }
YAML

node dist/cli/index.js up --config ./understudy.yaml   --port 8080 &
node dist/cli/index.js up --config ./understudy-b.yaml --port 8081 &
sleep 2
curl -s -X POST localhost:8080/inventory -H 'content-type: application/json' \
  -d '{"sku":"A","quantity":1}'
curl -s localhost:8081/inventory     # EMPTY []: no cross-talk between instances
```

**Expected**: the second instance answers `[]` — the record created on 8080 is not visible on
8081, because each instance has its own store file.

## 10. Prove no hidden outbound calls (SC-008, FR-022)

Run steps 3–9 with the fixture document supplied as a **local file** and confirm no outbound
connection is made. The only permitted outbound call in the whole slice is fetching a spec the
user supplied as a URL.

## What slice 1 does not yet do

- The store starts **empty**: no generation, no fixtures, no import (slice 2).
- `reset` implements **wipe only**; `baseline` and `runtime-only` arrive with the data layer
  (slice 3).
- No events, no webhooks (slice 4); no actions or simulation (slice 5).
- The mocked surface is **unauthenticated** — whether consumers must present an auth header is a
  deferred decision.
