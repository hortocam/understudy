# 01 — Product Specification

## 1. Problem

Teams integrating with third-party APIs (a ticket POS/inventory system, a ticket marketplace) need test doubles that behave like the real service: create/read/update/delete persists, lists reflect prior writes, IDs and foreign keys are consistent, lookup values appear consistently across responses, and the service sometimes calls back (webhooks) or receives events no API call of ours caused (a marketplace order arriving).

Existing mock tools are stateless, example-driven, or require hand-written scripts per endpoint. None combine **spec-driven CRUD**, **realistic bulk data generation**, **import of real reference data**, **webhooks**, and **synthetic third-party events**, with a **versionable static vs. dynamic configuration split** suitable for CI/CD.

## 2. Users

- **Integration developer** — runs the mock locally against their service while building.
- **CI pipeline / test author** — needs deterministic, resettable, scriptable state per test run.
- **QA / demo operator** — needs to trigger scenarios (an order arrives, a webhook fails) on demand.

## 3. Goals / Non-goals

**Goals**
- Select specific operations from a spec; only those are live.
- Persistent state until explicitly reset or torn down.
- Generated data valid against the spec's schemas, with consistent keys and relationships.
- Reproducible datasets (seeded).
- Clean separation of versioned static config from dynamic generation config.
- Outbound webhooks and synthetic inbound events, both configurable.
- API-first control plane with a CLI on top.

**Non-goals (v1)**
- Not a performance/load-testing tool or a full API gateway.
- No GUI.
- No attempt to replicate the real service's undocumented business logic beyond what is configured.
- No GraphQL/gRPC/SOAP; OpenAPI 3.x REST/JSON only.
- Webhook signature *verification on our side* of real services is out of scope; HMAC *signing of mock-emitted webhooks* is a later slice.

## 4. User Stories

### Epic A — Spec-driven CRUD mock
- **A1** As a developer, I point the tool at an OpenAPI spec and list the operations to enable (e.g. POST/GET/GET-by-id/PATCH/DELETE on `/inventory`) so only those respond.
- **A2** Requests and responses are validated against the spec; invalid requests return spec-conformant errors.
- **A3** Operations not enabled return a clear "not implemented in mock" response (501), distinct from 404-not-found.
- **A4** Created entities persist across restarts until reset/teardown.
- **A5** List endpoints support the filtering, sorting, and paging the spec declares.

### Epic B — Control plane
- **B1** Via API: reset (all, per entity, runtime-only, to baseline), snapshot/restore, health, list enabled operations, request log, teardown.
- **B2** Via CLI: every control-API function is available as a command; the CLI contains no logic the API lacks.
- **B3** The control API is isolated from the mocked API surface (reserved prefix, optionally a separate port).

### Epic C — Data layer
- **C1** Static config defines lookup tables and fixed entities with fixed IDs; applied identically every run; versioned in the repo.
- **C2** Dynamic config defines how many of each entity to generate, field generators, and a seed; kept separate from static config.
- **C3** Field values are chosen by a documented precedence chain (explicit generator → imported → lookup → spec constraints → faker heuristics → type default).
- **C4** Unconfigured entities still generate: FKs are inferred (config, extension, naming convention, `$ref`) and resolved to existing parent rows; other fields are filled by the precedence chain.
- **C5** Counts can be absolute or relative to a parent (`perParent` with a range/distribution).
- **C6** Custom named generators and computed fields (JSONata over sibling fields) keep data plausible (e.g. `price >= cost`, `sold <= quantity`).
- **C7** Same seed + same config + same imports ⇒ identical dataset.
- **C8** Generated IDs come from a reserved range so they never collide with static IDs.

### Epic D — Import / export
- **D1** Import real data (JSON/CSV, optionally a remote API pull) via a mapping file into specific entities while other entities are generated against them.
- **D2** Export current state, split by origin (static / imported / generated / runtime), in a format the importer and static loader can read back.
- **D3** Snapshot/restore the whole store quickly for CI.

### Epic E — Events and webhooks
- **E1** Every mutation emits an internal domain event with before/after and source; seeding/import/generation emit none unless opted in.
- **E2** Configure named webhook targets (URL, headers/auth, retry policy); the URL can be overridden at start time (flag/env).
- **E3** Configure subscriptions: trigger (entity event + JSONata condition, or specific operation) → payload template (JSONata) → target, with optional delay/jitter.
- **E4** Payloads are validated against spec `webhooks`/`callbacks` schemas where present.
- **E5** Deliveries are durable (survive restart), logged, replayable, retried per policy.
- **E6** Fault injection per subscription: drop, duplicate, delay, reorder.
- **E7 (later)** Consumer-supplied subscription secret is stored by the mock and used to HMAC-sign deliveries; algorithm/header names configurable.

### Epic F — Actions and simulated actors
- **F1** Define named actions with typed parameters and declarative steps: select, create, update, delete, webhook, fail-if.
- **F2** Actions run atomically in a single transaction and report a structured result.
- **F3** Invoke actions via control API, CLI, schedule, or event subscription (reaction).
- **F4** Entities can be marked `writes: actions-only` — readable through the spec's GET endpoints, created only by actions (the marketplace `orders` case).
- **F5** Reactions model side effects of mutations (e.g. deleting a listing cancels pending orders) without custom code.
- **F6** Simulation rules in dynamic config (e.g. "10 orders over 5 minutes", "20% of new listings receive an order after 30–300s").
- **F7** Scripted step escape hatch for logic the declarative steps cannot express.

### Epic G — Conformance
- **G1** Documented way to run contract tests (Specmatic or equivalent) against the running mock to prove generated and persisted responses conform to the spec.

## 5. Functional Requirements

| ID | Requirement |
|---|---|
| FR-001 | Load OpenAPI 3.0/3.1 specs (file or URL), resolving `$ref`s. |
| FR-002 | Enable operations by `operationId` or `METHOD /path`; all others return 501. |
| FR-003 | Validate request and response bodies, params, and headers against the spec. |
| FR-004 | Implement generic Create/Read/List/Update(PATCH merge-patch, PUT replace)/Delete semantics with spec-defined status codes (201, 204, 400, 404, 409, …). |
| FR-005 | Persist all state in an embedded database by default (SQLite); storage behind an interface. |
| FR-006 | Expose control API under a reserved prefix (default `/__understudy/`) for reset, seed, import, export, snapshot, restore, actions, webhooks, logs, health, teardown. |
| FR-007 | Provide a CLI wrapping the control API with equivalent commands. |
| FR-008 | Separate static, dynamic, imports, and behavior config into distinct files/folders with independent loading. |
| FR-009 | Tag every row with `origin` ∈ {static, imported, generated, runtime}. |
| FR-010 | Implement the field precedence chain (C3) and FK inference order (C4). |
| FR-011 | Support absolute and per-parent counts with ranges. |
| FR-012 | Deterministic generation from a seed. |
| FR-013 | Reserve ID ranges per entity for generated rows. |
| FR-014 | Mapping-file-driven import (JSONPath or JSONata) from JSON/CSV; export by origin. |
| FR-015 | Emit domain events for API and action mutations; configurable for other sources. |
| FR-016 | Webhook targets, subscriptions, JSONata payload templates, delays, retries, outbox persistence, delivery log, replay. |
| FR-017 | Webhook fault injection (drop/duplicate/delay/reorder). |
| FR-018 | Actions with typed params and steps (select/create/update/delete/webhook/fail-if/script), transactional execution. |
| FR-019 | Action triggers: manual, schedule, event reaction, simulation rule. |
| FR-020 | `writes: actions-only` entity mode. |
| FR-021 | Reset modes: baseline, runtime-only, wipe, per-entity. |
| FR-022 | Request log with filtering, available via control API. |
| FR-023 | Webhook HMAC signing using a consumer-supplied secret (deferred slice). |

## 6. Non-functional Requirements

- **Determinism:** reproducible given seed + config + imports (excluding wall-clock fields unless a virtual clock is enabled).
- **Startup:** a 10k-row dataset generates and the service is ready in under 30s on a developer laptop; restore-from-snapshot under 5s.
- **Isolation:** multiple mock instances can run side by side (distinct ports and DB files).
- **Observability:** structured logs; request, event, and delivery logs queryable.
- **Safety:** webhook targets are explicit; no outbound calls other than configured targets/imports; no real credentials in static config (secrets via env).
- **Portability:** runs on Windows, macOS, Linux; Docker image provided.
- **Documentation:** every config key documented with an example.

## 7. Acceptance Scenarios (examples)

1. *Given* a spec with `/inventory` and enabled ops POST/GET/GET-id/PATCH/DELETE, *when* I POST an item then restart the mock, *then* GET by id returns it.
2. *Given* `dynamic/ci-small.yaml` with seed 42, *when* I generate twice from wipe, *then* both exports are byte-identical.
3. *Given* imported Events and a recipe of 10–50 Inventory per Event, *then* every Inventory has a valid `eventId` referencing an imported Event, and `price >= cost`.
4. *Given* a webhook subscription on `Inventory.updated` where status became `sold`, *when* I PATCH status to `sold`, *then* exactly one delivery is queued with the rendered payload to the configured target; with the target down, it retries per policy and survives a restart.
5. *Given* `orders` has only GET enabled and `writes: actions-only`, *when* I run action `marketplace-order`, *then* an available Inventory becomes `sold`, an Order exists and is returned by `GET /orders`, and the order-created webhook is queued — all or nothing.
6. *Given* no available inventory satisfies the action, *then* the action fails with a structured error and no state changes.
7. *Given* `reset --to baseline`, *then* runtime-origin rows are gone and static/imported/generated rows are reproduced identically.

## 8. Success Measures

- A new service can be mocked from its spec in under a day, including fixtures.
- CI suites can run against a fresh mock per job with no shared state.
- Zero hand-written per-endpoint handlers for standard CRUD.
