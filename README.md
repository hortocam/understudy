# understudy

> It learns the part (your OpenAPI spec) and performs it until the real service is available.

**Understudy** is a suite of tools for declarative, stateful mocking of the APIs and webhook
events that show up in modern B2B integrations. Point it at an OpenAPI 3.x spec, select the
operations you care about, and it serves a persistent, contract-valid mock of them — pre-populated
with realistic generated or imported data, able to emit webhooks and to simulate
third-party-initiated events. Controlled API-first, with a thin CLI (`ustdy`) on top.

Domain driving the design: a ticket-broker POS/inventory system plus a ticket-marketplace
integration.

## Status

**Slice 1 shipped — core CRUD mock. Slice 2 implemented — configuration and generation.**
Slice 1 loads an OpenAPI 3.0/3.1 document (file or URL), makes exactly the operations you select
live, serves persistent CRUD against SQLite with the document's own status codes and validation,
answers unselected operations distinctly, and exposes a control API with a `ustdy` CLI client.
Slice 2 makes that mock **populated and configured**: versioned fixtures, named generation
recipes, entity/foreign-key inference that shows its working, reserved identity ranges across
integer / uuid / prefixed-string identity spaces, and generation that is byte-for-byte reproducible
from a seed. The remaining slices are planned spec-first with
[Spec Kit](https://github.com/github/spec-kit) and land over time.

| Slice | Scope | State |
|---|---|---|
| 1 | Core CRUD mock (spec load, operation selection, validation, generic CRUD, SQLite persistence, 501 handling, control API + CLI) | **shipped** |
| 2 | Data layer I — config layers, entity/FK inference, generation, determinism | **implemented** (in review) |
| 3 | Import / export / snapshot | not started |
| 4 | Events and webhooks | not started |
| 5 | Actions, reactions, simulation | not started |
| 6 | Hardening (fault injection, HMAC signing, virtual clock) | not started |
| 7 | Conformance and shipped examples | not started |

## Quick start

Node.js 22+. From a checkout:

```bash
npm ci
npm run build        # tsc -> dist/
```

Write a project config and start the mock (see [Configuration](#configuration) for every key):

```yaml
# understudy.yaml
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

```bash
ustdy up --config ./understudy.yaml      # or: node dist/cli/index.js up --config ./understudy.yaml
curl -s -X POST localhost:8080/inventory -H 'content-type: application/json' \
  -d '{"sku":"GA-100","quantity":4}'
curl -s localhost:8080/inventory/100000  # the record, in the document's own shape
ustdy down
```

The full runnable walkthrough — every step with its expected output — is
[`specs/001-slice-1-core/quickstart.md`](specs/001-slice-1-core/quickstart.md).

## CLI (`ustdy`)

`ustdy` is a **thin client of the control API** (constitution II): every command issues one control
request and renders the answer; the only exception is `up`, which constructs and starts the server
from a config and then polls `/health` until ready; `init` is the other local act (it writes files).
The command surface:

| Command | Does |
|---|---|
| `ustdy up [--config <path>] [--port <n>] [--control-port <n>] [--control-url <url>] [--operation <entry>]… [--recipe <name>] [--seed <n>]` | start the mock from a config; apply the named recipe at start; print the startup report, then a ready line |
| `ustdy init --spec <path-or-url> [--dir <path>] [--force]` | scaffold the four configuration layers and `understudy.yaml` for a specification, and print the inferred collection report |
| `ustdy generate [--recipe <name>] [--seed <n>] [--control-url <url>]` | apply a recipe to the running mock; report what it created by collection and origin |
| `ustdy down [--control-url <url>]` | tear the running mock down; exit 0 only once the port is released |
| `ustdy ops list [--control-url <url>]` | list the live and not-implemented operations |
| `ustdy reset [--to <mode>] [--entity <name>]… [--control-url <url>]` | reset the mock; the only mode is `--to wipe` (removes every non-fixture record and rewinds identities) |
| `ustdy logs requests [--method <m>] [--status <code>] [--live] [--limit <n>] [--control-url <url>]` | print the request log, newest first |

**Environment:** `USTDY_CONFIG` (config file path) and `USTDY_CONTROL_URL` (control-plane base
URL). `--control-url`, else `USTDY_CONTROL_URL`, else composed from the config
(`http://<control.host>:<control.port|server.port><control.prefix>`), else
`http://127.0.0.1:8080/__understudy`. With the control plane unreachable, every client command
exits non-zero with a clear connection error rather than falling back to doing the work locally.

## Configuration

A single project config file (`understudy.yaml`) states the spec source, the operation selection,
the server bind/port, the control prefix (and optional separate control port), and the store
location. It is validated against
[`contracts/config.schema.yaml`](specs/002-data-layer/contracts/config.schema.yaml) (slice 2 extends slice 1's contract, which stays as history); unknown
keys and the reserved keys below are refused at startup.

| Key | Type / default | Meaning |
|---|---|---|
| `spec` | string (required) | Path or URL of the OpenAPI 3.0/3.1 document. A URL is the **only** outbound network call the tool ever makes. |
| `operations` | string[] (required, ≥1) | The operations to make live. Each entry is `METHOD /path` (e.g. `POST /inventory`), an `operationId`, or a **tag** (a tag with a space is written with `_`: `Market_Orders`) — three peers, none a fallback. Everything else answers 501. Empty, unknown or ambiguous entries refuse to start. |
| `server.port` | integer, `8080` | Port the mocked surface binds. |
| `server.host` | string, `"127.0.0.1"` | Host the mocked surface binds. |
| `server.basePath` | string, `""` | Prefix every mocked route behind this path. |
| `control.prefix` | string, `"/__understudy"` | Reserved prefix for the control surface; a request here is never routed into the mocked surface. |
| `control.port` | integer, unset | Serve the control API on its own port instead of on the mock's. |
| `control.host` | string, unset | Host for the separate control port (defaults to `server.host`). |
| `storage.driver` | `"sqlite"` \| `"postgres"`, `"sqlite"` | **`postgres` is reserved** — accepted by the schema so the shape is stable, but selecting it refuses to start until the adapter ships. |
| `storage.path` | string, `"./.understudy/state.db"` | SQLite file. Its directory is created if absent; an unwritable path refuses to start. |
| `ids.generatedStart` | integer, `100000` | First identity for records created over the API. A reserved range that must not overlap fixture-supplied identities (slice 2). |
| `signing.alg` / `signing.header` | string (`hmac-sha256` / `X-Signature`) | **RESERVED** (under `signing`) — the shape of webhook HMAC signing (slice 4+), refused on presence for now. |
| `signing` | object | **RESERVED** — accepted so the shape is stable, but selecting it is a startup refusal naming the key. Webhook HMAC signing lands with the webhook slices. |

| `paths.static` | string, `"./static"` | Folder of versioned fixtures (`lookups/`, `entities/`). A missing folder is not an error. |
| `paths.imports` | string, `"./imports"` | Folder of import mappings. Shape validated now; read in slice 3. |
| `paths.dynamic` | string, `"./dynamic"` | Folder of generation recipes, one file per recipe (the file name is the recipe name). |
| `paths.behavior` | string, `"./behavior"` | Folder of webhook/action/simulation files. Parsed and validated now; acted on in slices 4–5. |
| `recipe` | string, unset | The recipe applied at start (a file under `paths.dynamic`, without extension). Absent means fixtures only. Overridden by `--recipe`. |
| `seed` | integer, `0` | The global seed. A recipe's own `seed` overrides it and `--seed` overrides both. Per-collection streams derive from it, so adding a collection moves no existing one. |
| `entities.<Name>.idField` | string | The identity property (defaults to the derived one). |
| `entities.<Name>.writes` | `"api"` \| `"actions-only"`, `"api"` | `actions-only` is reserved: it is refused at startup until slice 5. |
| `entities.<Name>.ids.generatedStart` | integer | First generated/API identity for an **integer** identity space (wins over `ids.generatedStart`). Fixture identities at or above it refuse to start. |
| `entities.<Name>.ids.reserved` | string | An explicit span for a non-integer space, written `<from>..<to>`: `EVT-100000..EVT-199999` (formatted/prefixed) or `a0000000..afffffff` (the leading hex digits of a uuid). Overlap with a fixture identity refuses to start naming the collection. |
| `entities.<Name>.relations.<field>.to` | `Collection.field` | Pin a link: it wins over every inferred one and the report says it was `configured`. The target must be that collection's identity. |
| `entities.<Name>.relations.<field>.onDelete` | `restrict` \| `cascade` \| `setNull`, `restrict` | The delete policy of the foreign key generated for a **decided** link. An undetermined link gets no constraint. |
| `inference.idSuffixes` | string[], `["Id","_id"]` | Name suffixes that *propose* a link (`eventId` proposes `Event`). A proposal is decided only when unambiguous. |
| `inference.ambiguousNames` | string[], `["externalId","referenceId","refId","parentId"]` | Names that denote a different entity per collection: never decided by convention, always reported as undetermined and pinned by you. |
| `clock.mode` | `"real"`, `"real"` | `virtual` is **reserved** (slice 6) and refuses to start naming the mode. |
| `clock.start` | ISO date-time | Pin the instant the clock reports. With it, a seeded run — timestamps included — is byte-reproducible; without it the report says the clock is unpinned. |

Each key with a runnable config fragment:

```yaml
# spec: a local file, or a URL (the one permitted outbound fetch)
spec: ./tests/fixtures/inventory-api.yaml
# spec: https://example.test/openapi.json

# operations: METHOD /path, an operationId, or a tag — three peers
operations:
  - POST /inventory
  - getInventoryById
  - Market_Orders          # a tag; the document need not declare any operationId

server:  { port: 8080, host: 127.0.0.1, basePath: "" }
control: { prefix: /__understudy }        # add `port: 9090` for a separate control listener
storage: { driver: sqlite, path: ./.understudy/state.db }
ids:     { generatedStart: 100000 }
# signing: { alg: hmac-sha256 }           # RESERVED — refuses to start until the feature lands

# --- slice 2 ---
paths:     { static: ./static, imports: ./imports, dynamic: ./dynamic, behavior: ./behavior }
recipe:    ci-small                        # or: ustdy up --recipe ci-small
seed:      42                              # default 0; a recipe's seed wins; --seed wins over both
clock:     { mode: real, start: "2026-01-01T00:00:00Z" }   # mode: virtual is RESERVED (slice 6)
inference: { idSuffixes: [Id, _id], ambiguousNames: [externalId, referenceId, refId, parentId] }
entities:
  Event:
    idField: id
    writes: api                            # actions-only: reserved (refused until slice 5)
    ids: { generatedStart: 500000 }        # an integer identity space
    relations:
      venueId: { to: Venue.id, onDelete: restrict }   # restrict | cascade | setNull
  Ticket:
    ids: { reserved: "EVT-100000..EVT-199999" }       # a prefixed-string space (or a uuid span)
```

## Configuration layers, recipes and generation (slice 2)

Four independent layers, each loadable without the others (a missing folder is never an error); every
file is validated against the one contract and a mistake refuses to start as `file: key — cause`:

| Layer | Folder | State |
|---|---|---|
| Fixtures | `static/lookups/*.yaml`, `static/entities/*.yaml` | Loaded; rows are written with origin `static`, applied identically on every start, and never touched by generation or import. The fixture **files** are never rewritten. |
| Recipes | `dynamic/<name>.yaml` | The switchable dataset; the file name is the recipe name. |
| Behaviour | `behavior/*.yaml` | **Parsed and validated only** (webhook targets, subscriptions, actions, reactions, simulations); acted on in slices 4–5. `${NAME:-default}` stays text — secrets come from the environment, never a file. |
| Imports | `imports/*.mapping.yaml` | **Shape validated only**; import execution is slice 3. |

<!-- behavior-example -->
```yaml
# behavior/webhooks.yaml — validated now, acted on in slices 4–5
targets:
  pos:
    url: ${USTDY_WEBHOOK_POS_URL:-http://localhost:9000/hooks/pos}
    headers: { X-Source: mock }
    retry: { max: 5, backoff: exponential, baseMs: 500, jitterMs: 200 }
    timeoutMs: 5000
subscriptions:
  - { name: inventory-sold, on: Inventory.updated, target: pos }
actions:
  sell:
    description: Sell one ticket
    params:
      quantity: { type: integer, optional: true, default: 1 }
    steps:
      - select: { as: ticket, entity: Inventory, pick: random }
      - fail_if_empty: { var: ticket, code: 409, message: nothing to sell }
simulations:
  steady:
    seed: 7
    rules:
      - { run: sell, every: { range: [20s, 5m] }, probability: 0.8 }
```

```yaml
# static/entities/venues.yaml — keys: entity, idField, rows
entity: Venue
rows:
  - { id: 1, name: "Test Arena", city: "Boston", state: "MA" }
```

```yaml
# dynamic/ci-small.yaml — recipe keys: seed, entities, generators
seed: 42
entities:
  Venue: { count: 3 }                                   # an absolute count
  Event:
    perParent: { entity: Venue, range: [2, 4], distribution: uniform }   # range [min,max]; uniform | zipf
    fields:
      category: { choice: [music, sport] }
  Inventory:
    perParent: { entity: Event, range: [5, 12], distribution: zipf }
    fields:
      section:  { generator: sectionCode }              # a custom (or built-in) named generator
      row:      { faker: "string.alpha", length: 1, casing: upper }
      quantity: { faker: "number.int", min: 2, max: 8 }
      statusId: { lookup: InventoryStatus, weights: { available: 0.8, held: 0.1, sold: 0.1 } }
      price:    { expr: "cost * $uniform(1.1, 2.5)" }   # JSONata over sibling fields
    constraints: ["price >= cost"]                      # invariants, enforced by redraw
    redraws: 50                                         # the redraw budget (default 50), then it fails loudly
  Customer: { source: import }                          # reserved: its records come from slice 3's import
generators:
  sectionCode: { choice: ["100", "101", "FLOOR", "GA"] }   # also: faker, seq, plugin: ./gens/x.mjs
```

A field rule is exactly one of `generator`, `faker`, `lookup` (with `weights`, `by`, `value`), `ref`
(`Collection.field`), `seq` (with `start`, `step`), `choice` (with `weights`) or `expr`. A collection
absent from the recipe is not generated; one with no `fields` is populated from the specification.

**How a value is chosen (FR-010).** An explicit recipe rule wins; else a supplied value; else a
reference into an existing parent along a decided link; else the specification's own `const`, `enum`,
`example`(s) or `default`; else a plausible-value heuristic from the declared format, pattern or field
name; else the type's default. The startup report names the level that supplies each unruled field, and a
value chosen by a heuristic or type default is reported as a fallback.

**Inference shows its working.** Collections come from the live operations; links follow the evidence
order *configured → declared extension (`x-understudy-relationships`) → naming convention → nesting*. A
convention hit **proposes**; it decides a link only when it is unambiguous. Where it is not
(`externalId` on many collections; `eventId` / `viagogoEventId` / `primaryEventId` on one) the link is
listed as **undetermined**, with its candidates, and is neither used for ordering nor given a foreign
key — pin it under `entities.<Name>.relations`. Relationship cycles are reported and never deadlock
generation; generation runs parents-first.

**Determinism.** The same specification, configuration, fixtures, seed and (pinned) clock produce
byte-identical state. Each collection draws from its own stream derived from `(seed, collection name)`,
so adding an unrelated collection changes no existing collection's records. Identities come from a
range reserved per collection in the identity space the document declares, kept disjoint from fixtures.
Generating onto a store that already holds a different recipe, seed or configuration refuses and says
`ustdy reset --to wipe`; the same one is a no-op that says so.

## Control API

Every capability is reachable over HTTP under the reserved prefix (FR-012–FR-018); the CLI adds no
capability the API lacks. The operations:

| Method & path | Does |
|---|---|
| `GET  <prefix>/health` | report the mock is alive and whether the store is reachable |
| `GET  <prefix>/operations` | list the live and not-implemented operations |
| `POST <prefix>/reset` | reset the mock (`{"mode":"wipe"}`); body is `application/json` |
| `POST <prefix>/generate` | apply a recipe (`{"recipe":"ci-small","seed":42}`); answers counts by collection and origin, and the clock mode |
| `GET  <prefix>/requests` | the request log, filterable by `method`/`path`/`status`/`live`/`limit` |
| `GET  <prefix>/openapi.json` | this control API's own OpenAPI description |
| `POST <prefix>/teardown` | stop serving and release the port; idempotent |

## Repository layout

```
.specify/        Spec Kit engine (scripts, templates, memory/constitution.md)
specs/           One directory per feature, produced by the Spec Kit cycle
docs/            Handoff package — the source material for the specs
src/             implementation — spec/ config/ data/ mock/ control/ store/ cli/
tests/           unit + integration + contract tests
```

## Development

Node.js 22+.

```bash
npm ci
npm run lint        # eslint
npm run typecheck   # tsc --noEmit
npm run test        # vitest
npm run build       # tsc -p tsconfig.build.json (runs `generate` first)
node dist/cli/index.js --help
npm run test:live   # opt-in: derive against a real vendor document (USTDY_LIVE_SPEC=<url>); never part of `npm test`
```

## License

MIT — see [LICENSE](LICENSE).
