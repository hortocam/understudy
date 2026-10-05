# Implementation Plan: Slice 1 — Core CRUD Mock

**Branch**: `wt/slice-1-spec` (feature `001-slice-1-core`) | **Date**: 2026-10-03 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/001-slice-1-core/spec.md`

## Summary

Serve a subset of operations from an OpenAPI 3.x document as a live, persistent, contract-valid
CRUD API. The technical approach: parse and dereference the document once at startup, derive a
resource model from the selected operations, drive a generic CRUD engine from that model, keep
records in SQLite behind a storage interface, and expose a separate control plane (health, reset,
operations, request log, teardown) that the CLI is a thin client of.

The whole slice is **one code path driven by data derived from the spec** — there are no
per-endpoint handlers, by construction and by acceptance criterion SC-001.

## Technical Context

**Language/Version**: TypeScript 5.9, targeting Node.js 22 LTS, ES modules (`"type": "module"`,
`moduleResolution: NodeNext`). Node 22 is the floor because it is the LTS line the project's CI
pins and the toolchain is already proven on it.

**Primary Dependencies** (pinned; see `research.md` for the alternatives each one beat):

| Concern | Choice | Version |
|---|---|---|
| HTTP server | `fastify` | ^5.12 |
| Spec parsing + `$ref` resolution | `@scalar/openapi-parser` + `@scalar/openapi-upgrader` | ^0.29 / ^0.4 |
| Schema validation | `ajv` + `ajv-formats` | ^8.20 / ^3.0 |
| Storage | `better-sqlite3` | ^13.0 |
| CLI | `commander` | ^15.0 |
| Config file parsing | `yaml` | ^2 |
| Test runner | `vitest` | ^5.0 |

**Storage**: SQLite via `better-sqlite3`, accessed **only** through a `Store` interface. The
interface exists now, with one implementation, because constitution principle X ("Additive
Evolution") requires the seam before the feature that needs it — slice 6 adds Postgres.

**Testing**: vitest 5. Unit tests for derivation and validation; integration tests that start a
real server on an ephemeral port against a real SQLite file; contract tests that drive the mock
over HTTP using the fixture OpenAPI document.

**Target Platform**: Node CLI + HTTP server. Linux, macOS, Windows (path handling and no
shell-outs in library code). Container image is a later slice.

**Project Type**: single project — a library, a server, and a CLI over the same core.

**Performance Goals**: a contract-conformance suite over the fixture document completes in
seconds. Slice 1 makes no claim about dataset size (that is slice 2's 10k-rows-under-30s target);
it must not be *slower* than that budget for a few thousand records.

**Constraints**: no outbound network calls other than fetching a spec the user supplied by URL
(FR-022, constitution VIII); no secrets in config or repository; a mock instance is isolated by its
own store file and ports (SC-007).

**Scale/Scope**: one mock instance per process, serving a handful to a few dozen selected
operations; thousands of records per collection without exhausting memory (paged reads).

## Constitution Check

*GATE: must pass before Phase 0 research; re-checked after Phase 1 design.*

| Principle | Gate | Verdict |
|---|---|---|
| I. Spec is the source of truth | Behaviour derives from the document; config refines and never silently contradicts | **PASS** — every route, schema and status code is read from the dereferenced document; FR-004 requires refusal on contradiction |
| II. API-first control | Control capabilities live in the control API; the CLI adds no logic | **PASS** — FR-019 makes the CLI a client with no logic of its own; the CLI is a separate module (`src/cli/`) that may not import the engine |
| III. Determinism by default | Same spec + config ⇒ same behaviour | **PASS** — slice 1 has no generation, so its only nondeterminism is identity allocation (FR-011) and request-log timestamps. Both are confined to seams |
| IV. Static/dynamic separation | Fixtures never mutated by runtime | **PASS (by construction)** — slice 1 has no fixtures; every record is `origin=runtime`. The tag exists so slice 2 adds origins without a migration |
| V. Atomicity | State changes and their events commit together | **N/A for now** — no events until slice 4. The engine writes one record per operation inside a single transaction, which is the shape slice 4's outbox will join |
| VI. Explicit over magic | Every inference reported at startup and pinnable | **PASS** — FR-023/FR-024 make the startup report a deliverable; the derivation rules below pin exactly what is inferred and what is refused |
| VII. Test-first, contract-verified | Failing test first; golden files; conformance in CI | **PASS by process** — every task in `tasks.md` is written test-first; the contract suite is a slice-1 deliverable (SC-003) |
| VIII. Safe and portable | No hidden outbound calls; secrets from env; portable | **PASS** — FR-022 forbids outbound calls beyond a URL spec; slice 1 has no credentials at all |
| IX. Small, documented config surface | Every key documented with an example; future keys reserved | **PASS (corrected — see below)** — each *implemented* key is documented and exemplified in `quickstart.md`; `signing`, `clock` and `storage.driver: postgres` are reserved in the schema so the shape is stable before their features land |
| X. Additive evolution | Seams exist before the features that use them | **PASS** — the `Store` interface, the reset-mode parameter, and the three reserved config keys all land now with one implementation/value |

**Post-Phase-1 re-check**: unchanged. The design adds no abstraction that isn't a named seam from
principle X, and invents no behaviour the spec does not require.

**Correction (independent review, 2026-10-03).** The Principle IX row first read "PASS — five config
keys, each documented", which was wrong: principle IX requires *future* keys to be **reserved** so
the shape is stable before the feature lands. **Three** are reserved in the schema — `signing`,
`clock` and `storage.driver: postgres` — and a fourth, relationship `onDelete`, is deliberately
*not* reserved (see the end of this paragraph). The initial schema offered only `storage.driver: ["sqlite"]`, which
locks the door from the wrong side — adding Postgres would have been a schema change on every
consumer config. The reviewer caught it; the schema now reserves those keys and `storage.driver`
accepts `postgres` (refusing to start with a named message until the adapter exists, because a
config key that silently does nothing is worse than one that does not exist). Relationship
`onDelete` arrives with the `entities:` block in slice 2, where relationships first become
concrete — reserving a shape for a key that has no object to hang from yet would be noise.

## Project Structure

### Documentation (this feature)

```text
specs/001-slice-1-core/
├── plan.md              # This file
├── spec.md              # The what and why
├── research.md          # Phase 0: decisions and alternatives
├── data-model.md        # Phase 1: entities, tables, derivation rules
├── quickstart.md        # Phase 1: runnable validation scenarios
├── contracts/           # Phase 1: the interfaces this feature exposes
│   ├── README.md                      # why the control contract is checked in, not generated
│   ├── control-api.openapi.json
│   ├── config.schema.yaml
│   └── cli.md
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
src/
├── index.ts                 # library entry: createMock(config) -> { server, close }
├── errors.ts                # error taxonomy; every refusal names what was wrong
├── spec/
│   ├── load.ts              # read + dereference; upconvert 3.0 -> 3.1; fail fast
│   ├── operations.ts        # selection, not-implemented set, method+path routing keys
│   ├── resources.ts         # resource/entity derivation and relationship inference
│   └── report.ts            # startup report construction (data, not formatting)
├── config/
│   ├── schema.ts            # the config contract, as a JSON Schema (contracts/)
│   └── load.ts              # read understudy.yaml, validate, apply defaults
├── mock/
│   ├── route.ts             # match a request against live operations
│   ├── validate.ts          # request/response validation via ajv per operation
│   ├── crud.ts              # generic create/read/list/update/delete semantics
│   ├── list.ts              # filter/sort/paging behaviour over declared params
│   └── errors.ts            # spec-declared error responses
├── control/
│   ├── server.ts            # control-plane fastify instance
│   ├── routes.ts            # health, reset, operations, requests, teardown
│   └── openapi.ts           # serves contracts/control-api.openapi.json (FR-018)
├── store/
│   ├── index.ts             # the Store interface — the seam (principle X)
│   ├── sqlite.ts            # SQLite implementation
│   └── schema.ts            # DDL and metadata tables
├── cli/
│   ├── index.ts             # `ustdy` entrypoint (commander)
│   └── client.ts            # HTTP client for the control plane — the CLI's ONLY engine access
└── logging.ts               # structured logs (FR-024)

tests/
├── fixtures/                # fixture OpenAPI documents + expected responses
├── unit/                    # derivation, selection, list semantics, config
├── integration/             # real server + real SQLite: persist/restart, reset, isolation
└── contract/                # conformance suite driven by the fixture document
```

**Structure Decision**: a single project with a hard internal boundary — `cli/` talks to
`control/` over HTTP and imports nothing else; `mock/` never imports `control/`; both sit on
`store/` and `spec/`. The boundary is what makes FR-019 (no CLI logic the API lacks) checkable
rather than aspirational, and it is enforced by a test asserting `src/cli/`'s import graph does not
reach `src/mock/` or `src/store/`.

## Derivation rules (what is inferred, and what is refused)

Principle VI demands inference be explicit and pinnable. Slice 1's inference is deliberately small,
and every rule below is visible in the startup report:

- **Resource recognition.** Live operations are grouped by path template. A collection path
  (`/inventory`) and its instance path (`/inventory/{id}`) collapse to one resource when the
  instance path extends the collection path by exactly one parameter. A path matching neither is
  reported as a route with no resource — served, but with no CRUD semantics inferred.
- **Entity name.** Taken from the operation's response schema `title`, else the collection path
  segment, singularised. Reported either way, so a wrong guess is visible.
- **Identity field.** The path parameter name if the schema declares a matching property, else
  `id`. The declared type drives identity allocation (FR-011).
- **Representation schema.** The 2xx response schema for the operation that produces the resource.
  Create/update request shapes are read from their own request bodies.
- **Relationships.** Inference order per `docs/02` §3: (1) explicit config, (2) a spec extension,
  (3) naming convention, (4) nesting. Slice 1 must *derive and report* them (FR-023) but does not
  act on them — acting is slice 2. Rules (3) and (4) are the ones that will be wrong on real vendor
  documents, which is exactly why the report names the evidence source per link.
- **List semantics.** Filtering, sorting and paging parameters are read from the operation's
  declared query parameters. Where the document declares none, the tool returns the full
  collection and says so in the report (spec assumption) rather than inventing a default.
- **Refusals.** Unreadable or undereferenceable document, empty selection, selection naming unknown
  operations, unparseable config, unwritable store — all refuse to start with a named cause
  (FR-004, FR-021).

## Complexity Tracking

> No constitution violations. This section records the seams that exist before their features,
> which principle X requires and which a reader should not mistake for speculative abstraction.

| Addition | Why now | Simpler alternative rejected because |
|---|---|---|
| `Store` interface with one implementation | Slice 6 adds Postgres; slice 3 adds snapshot/restore over the same seam | Direct `better-sqlite3` calls would put SQL in the CRUD engine, and adding the seam later means rewriting shipped, reviewed behaviour |
| Reset *mode* parameter with only `wipe` implemented | Slice 3 adds `baseline` and `runtime-only`, which need the data layer | A mode-less reset endpoint becomes a breaking API change when slice 3 lands; the parameter is cheaper than the migration |
| `origin` tag on every record (always `runtime`) | Slices 2–3 add `static`, `imported`, `generated`; slice 3's reset-by-origin reads it | Adding the column later means a migration and a backfill on live mock databases |
| `src/cli/` restricted to the control API | FR-019, principle II | A CLI with direct engine access would be faster to write and would immediately fork the tool into two products |
