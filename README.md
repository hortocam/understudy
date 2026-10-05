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

**Slice 1 shipped — core CRUD mock.** Slice 1 of seven is implemented and green on `main`: it
loads an OpenAPI 3.0/3.1 document (file or URL), makes exactly the operations you select live,
serves persistent CRUD against SQLite with the document's own status codes and validation,
answers unselected operations distinctly, and exposes a control API with a `ustdy` CLI client.
The remaining slices are planned spec-first with [Spec Kit](https://github.com/github/spec-kit)
and land over time.

| Slice | Scope | State |
|---|---|---|
| 1 | Core CRUD mock (spec load, operation selection, validation, generic CRUD, SQLite persistence, 501 handling, control API + CLI) | **shipped** |
| 2 | Data layer I — config layers, entity/FK inference, generation, determinism | planning |
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
from a config and then polls `/health` until ready. The command surface shipped in slice 1:

| Command | Does |
|---|---|
| `ustdy up [--config <path>] [--port <n>] [--control-port <n>] [--control-url <url>]` | start the mock from a config; print the startup report, then a ready line |
| `ustdy down [--control-url <url>]` | tear the running mock down; exit 0 only once the port is released |
| `ustdy ops list [--control-url <url>]` | list the live and not-implemented operations |
| `ustdy reset [--to <mode>] [--entity <name>]… [--control-url <url>]` | reset the mock; slice 1 implements `--to wipe` only |
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
[`contracts/config.schema.yaml`](specs/001-slice-1-core/contracts/config.schema.yaml); unknown
keys and the reserved keys below are refused at startup.

| Key | Type / default | Meaning |
|---|---|---|
| `spec` | string (required) | Path or URL of the OpenAPI 3.0/3.1 document. A URL is the **only** outbound network call the tool ever makes. |
| `operations` | string[] (required, ≥1) | The operations to make live. Each entry is either `METHOD /path` (e.g. `POST /inventory`) or an `operationId` — both forms are peers, neither is a fallback. Everything else answers 501. Empty or unknown entries refuse to start. |
| `server.port` | integer, `8080` | Port the mocked surface binds. |
| `server.host` | string, `"127.0.0.1"` | Host the mocked surface binds. |
| `server.basePath` | string, `""` | Prefix every mocked route behind this path. |
| `control.prefix` | string, `"/__understudy"` | Reserved prefix for the control surface; a request here is never routed into the mocked surface. |
| `control.port` | integer, unset | Serve the control API on its own port instead of on the mock's. |
| `control.host` | string, unset | Host for the separate control port (defaults to `server.host`). |
| `storage.driver` | `"sqlite"` \| `"postgres"`, `"sqlite"` | **`postgres` is reserved** — accepted by the schema so the shape is stable, but selecting it refuses to start until the adapter ships. |
| `storage.path` | string, `"./.understudy/state.db"` | SQLite file. Its directory is created if absent; an unwritable path refuses to start. |
| `ids.generatedStart` | integer, `100000` | First identity for records created over the API. A reserved range that must not overlap fixture-supplied identities (slice 2). |
| `signing` | object | **RESERVED** — accepted so the shape is stable, but selecting it is a startup refusal naming the key. Webhook HMAC signing lands with the webhook slices. |
| `clock` | object | **RESERVED** — accepted so the shape is stable, but selecting it is a startup refusal naming the key. A virtual clock is a later slice; until then the real clock is used and reported. |

Each key with a runnable config fragment:

```yaml
# spec: a local file, or a URL (the one permitted outbound fetch)
spec: ./tests/fixtures/inventory-api.yaml
# spec: https://example.test/openapi.json

# operations: METHOD /path or operationId — both are accepted
operations:
  - POST /inventory
  - getInventoryById

server:  { port: 8080, host: 127.0.0.1, basePath: "" }
control: { prefix: /__understudy }        # add `port: 9090` for a separate control listener
storage: { driver: sqlite, path: ./.understudy/state.db }
ids:     { generatedStart: 100000 }
# signing: { alg: hmac-sha256 }           # RESERVED — refuses to start until the feature lands
# clock:   { mode: real }                 # RESERVED — refuses to start until the feature lands
```

## Control API

Every capability is reachable over HTTP under the reserved prefix (FR-012–FR-018); the CLI adds no
capability the API lacks. Slice 1's operations:

| Method & path | Does |
|---|---|
| `GET  <prefix>/health` | report the mock is alive and whether the store is reachable |
| `GET  <prefix>/operations` | list the live and not-implemented operations |
| `POST <prefix>/reset` | reset the mock (`{"mode":"wipe"}`); body is `application/json` |
| `GET  <prefix>/requests` | the request log, filterable by `method`/`path`/`status`/`live`/`limit` |
| `GET  <prefix>/openapi.json` | this control API's own OpenAPI description |
| `POST <prefix>/teardown` | stop serving and release the port; idempotent |

## Repository layout

```
.specify/        Spec Kit engine (scripts, templates, memory/constitution.md)
specs/           One directory per feature, produced by the Spec Kit cycle
docs/            Handoff package — the source material for the specs
src/             implementation — spec/ config/ mock/ control/ store/ cli/
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
```

## License

MIT — see [LICENSE](LICENSE).
