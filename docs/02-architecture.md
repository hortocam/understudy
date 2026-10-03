# 02 — Architecture and Design

Stack choices below are recommendations; confirm during `/speckit.plan`.

## 1. Recommended stack

- **Runtime:** Node.js + TypeScript (JSONata and Faker are first-class in JS).
- **HTTP:** Fastify (mock surface and control surface as separate plugin instances; optionally separate ports).
- **Spec handling:** `@apidevtools/swagger-parser` (or `@scalar/openapi-parser`) for `$ref` resolution; Ajv for schema validation; `openapi-backend` or custom router for operation matching.
- **Storage:** SQLite via `better-sqlite3` behind a `Store` interface (Postgres adapter later).
- **Data generation:** `@faker-js/faker` (seedable) + custom generator registry.
- **Expressions/templates:** JSONata.
- **CLI:** `commander` or `oclif`; talks to the control API over HTTP.
- **Packaging:** npm package + Docker image.

## 2. Component overview

```
                 ┌────────────────────────── control plane (/__understudy/) ───────────────────────────┐
 CLI ──HTTP──►   │ reset · seed · import/export · snapshot · actions · webhooks · logs · teardown │
                 └───────────────┬────────────────────────────────────────────────────────────────┘
                                 │
 consumer ──► Mock API surface ──┤   ┌──────────────┐   ┌───────────────┐
 (enabled ops   │ route match    ├──►│  CRUD engine │──►│    Store      │◄── Data layer
  only)         │ validate       │   └──────┬───────┘   │ (SQLite)      │    (static/dynamic/
                │ resolve entity │          │ emits     └───────▲───────┘     imports/gen)
                                 │          ▼                   │
                                 │   ┌──────────────┐   ┌───────┴───────┐
                                 └──►│  Event bus   │──►│ Action runner │ (steps, tx)
                                     └──────┬───────┘   └───────────────┘
                                            ▼
                                     ┌──────────────┐   outbox table   ┌────────────┐
                                     │ Webhook      │─────────────────►│ Dispatcher │──► targets
                                     │ subscriptions│                  │ retry/sign │
                                     └──────────────┘                  └────────────┘
```

## 3. Spec ingestion and operation selection

1. Parse and dereference the spec.
2. Apply `understudy.yaml` operation selection → list of live operations; the rest respond 501 with a body identifying the unimplemented operation.
3. **Resource inference:** group live operations by collection path (`/inventory`, `/inventory/{id}`). Derive for each resource: entity name, ID field/type (from the path param and response schema), create schema (POST request body), representation schema (2xx response), patchable fields.
4. **Entity graph:** every schema reachable from live operations (including those only returned by GET, e.g. `Order`) becomes an entity. FK discovery order:
   1. explicit mapping in config
   2. `x-understudy-ref` (or similar) extension in the spec
   3. naming convention (`eventId`, `event_id` → `Event.id`; configurable rules)
   4. nested `$ref` structure (embedded vs. referenced)
5. Topologically sort entities for generation; detect and report cycles (break via nullable FK or config).
6. A startup report lists inferred entities, FKs, and ambiguities so the user can pin them in config.

## 4. Storage model

- One table per entity: `id` (typed), `origin`, `created_at`, `updated_at`, `doc` (JSON), plus generated/indexed columns for FKs and any fields used in list filters.
- Meta tables: `_understudy_meta` (spec hash, seed, config hashes), `_events`, `_outbox`, `_deliveries`, `_requests`, `_id_ranges`, `_subscriptions` (consumer-created, for the signing feature).
- Spec/config hash mismatch on startup → warn, and require `--migrate` or reset.
- Snapshot = copy of the DB file (checkpointed) + metadata; restore = replace file.

## 5. CRUD engine semantics

- **POST:** validate → apply schema defaults → allocate ID (runtime range) → insert (`origin=runtime`) → 201 + representation (+ `Location` if spec defines it).
- **GET by id / list:** read; list honors spec-declared query params (filters by field equality/range, sort, paging style detected from spec: offset/limit, page/size, or cursor).
- **PATCH:** JSON merge patch (RFC 7386) then re-validate. **PUT:** replace.
- **DELETE:** 204; FK constraint behavior configurable per relationship (`restrict` → 409, `cascade`, `set-null`).
- Spec-defined error responses (400/404/409/422) are produced in the schema the spec declares.
- `writes: actions-only` entities reject POST/PUT/PATCH/DELETE at the mock surface.

## 6. Data layer

### 6.1 Config layers (loaded in this order)
1. **static/** — lookups and fixed entities. Idempotent, versioned, small.
2. **imports/** — mapping files + source data → entity rows (`origin=imported`).
3. **dynamic/** — recipe: seed, counts, generators (`origin=generated`).
4. **behavior/** — webhooks, actions, reactions, simulation (versioned with static; simulation schedules may live in dynamic).

### 6.2 Field value precedence
1. explicit generator/expression in dynamic config
2. imported value
3. lookup reference (value drawn from a static table)
4. spec constraints (`enum`, `format`, `minimum`/`maximum`, `minLength`, `pattern`, `example`/`default` optional)
5. faker heuristic by field name / format
6. type default

### 6.3 Generators
- Faker paths (`finance.amount`, `person.fullName`), with params.
- Named custom generators registered in config or a plugin file (`sectionCode`, `seatLabel`).
- `lookup: <Table>` (random or weighted), `ref: <Entity>` (pick existing parent), `sequence`, `choice`.
- Computed fields: JSONata over the row being built (`price: "cost * 1.4"`), evaluated after independent fields, in dependency order.
- Constraints block: post-generation invariants (`price >= cost`); violations re-roll up to N times then fail loudly.

### 6.4 Counts and distributions
`count: 500` or `perParent: { entity: Event, range: [10, 50], distribution: zipf|uniform|normal }`.

### 6.5 Determinism
One root seed → derived per-entity seeds (stable under entity addition). Wall-clock fields use a configurable clock (real by default, virtual optional) so snapshots are reproducible.

### 6.6 ID management
Per-entity ranges: static rows use their declared IDs; generated rows start at a configured base (default 100000 for ints); runtime rows continue after generated. UUID entities use seeded UUIDs for generated and random for runtime. Overlap is a config error.

### 6.7 Import / export
- **Import mapping:** source (file/URL/command), format (JSON/CSV), selector (JSONPath or JSONata), field map, entity target, optional upsert key. Imported rows can feed FKs for generated children.
- **Export:** by origin and entity, in the same format static/import loaders read. Typical flow: generate → inspect → export generated layer → promote to static fixture.
- **Reset modes:** `baseline` (wipe non-static, replay imports and generation), `runtime` (delete `origin=runtime` and revert runtime updates to baseline rows via change journal or re-apply), `wipe`, per-entity.

> Design note: reverting *updates to baseline rows* requires either a change journal or a full baseline replay. Simplest v1: `baseline` = replay from scratch (deterministic via seed); `runtime-only` = delete runtime rows only and document that mutations to non-runtime rows persist unless `baseline` is used. Decide in planning.

## 7. Event bus

Event shape:
```json
{ "id": "evt_…", "type": "Inventory.updated", "entity": "Inventory", "entityId": 1234,
  "op": "updated", "before": {…}, "after": {…}, "changed": ["status"],
  "source": "api|action|import|generated|simulation",
  "operation": "PATCH /inventory/{id}", "actor": "api|<action name>", "at": "…" }
```
Emitted inside the same transaction as the mutation into `_events`; subscribers are driven from that table (transactional outbox pattern), so events are never lost or emitted for rolled-back changes.

## 8. Webhooks

- **Targets:** `{ name, url, headers, auth, retry: {max, backoff, jitter}, timeout }`. URL overridable via env/CLI (`USTDY_WEBHOOK_TARGET_<NAME>`).
- **Subscriptions:** `{ on: "Inventory.updated" | operation, when: <JSONata>, template: <JSONata or file>, target, delay, faults }`.
- **Template context:** `before`, `after`, `changed`, `event`, `request` (headers/body/params when API-sourced), `related(entity,id)`, `now()`, `uuid()`, `$env`.
- **Validation:** if the spec has `webhooks` (3.1) or operation `callbacks`, validate rendered payload against that schema; mismatch is logged and optionally blocks delivery (`strictPayloads`).
- **Outbox:** row per delivery attempt chain, state machine `pending → delivering → delivered | failed | dead`. Dispatcher is a single in-process worker honoring `deliverAt` for delays. Survives restart.
- **Fault injection:** `drop: p`, `duplicate: n`, `delay: range`, `reorder: window`.
- **Signing (deferred slice):** the real service lets the consumer supply a secret when subscribing; deliveries carry an HMAC signature computed from it (algorithm unconfirmed — assume HMAC-SHA256 but keep algorithm, header name, and signed-content template configurable). Design for it now by (a) modelling a `subscriptions` store for consumer-created subscriptions where the spec has a subscribe endpoint, and (b) giving the dispatcher a pluggable `signer` hook.

## 9. Actions and simulated actors

Actions cover events the spec has no endpoint for.

- **Definition:** `{ name, params (JSON Schema), steps[] }`.
- **Steps:**
  - `select` — query entity by JSONata predicate and/or id, `pick: random|first|all`, `limit`, binds to a variable.
  - `fail_if_empty` / `fail_if` — abort with structured error (HTTP-like code) and rollback.
  - `create` — create entity via the data layer (generators fill unspecified fields; FKs resolved).
  - `update` / `delete` — mutate selected entity.
  - `webhook` — queue a delivery with explicit template/payload.
  - `script` — sandboxed JS escape hatch with read/write handles into the same transaction.
  - `emit` — raw custom event.
- **Execution:** single DB transaction; events and outbox rows commit atomically with state.
- **Result:** `{ ok, createdIds, updatedIds, events, webhooksQueued, error? }`.
- **Triggers:** `manual` (control API/CLI), `schedule` (cron/interval), `reaction` (on event + condition → action with param mapping), `simulation` (rate/probability rules with delay ranges, seeded).
- **Actor tag:** mutations from actions carry `source=action`, `actor=<name>`; subscriptions can distinguish, e.g. a POS staff change versus an API change.

## 10. Control API (illustrative)

```
GET    /__understudy/health
GET    /__understudy/operations                  PATCH to enable/disable
POST   /__understudy/reset        {mode, entities?}
POST   /__understudy/generate     {recipe}
POST   /__understudy/import       {mapping}
GET    /__understudy/export?origin=&entity=
POST   /__understudy/snapshots    GET list · POST /{id}/restore
GET    /__understudy/requests     (log, filterable)
GET    /__understudy/events
GET    /__understudy/webhooks/deliveries   POST /{id}/replay · PATCH pause/resume
POST   /__understudy/actions/{name}/run    {params}
GET    /__understudy/actions
POST   /__understudy/simulations/{name}/start|stop
DELETE /__understudy                       (teardown)
```
The control API is OpenAPI-described itself (served at `/__understudy/openapi.json`).

## 11. CLI (illustrative)

```
ustdy init <spec>                  scaffold understudy.yaml + folders, print inferred entity report
ustdy up [--config] [--recipe ci-small] [--webhook-target marketplace=http://…]
ustdy ops list|enable|disable <op…>
ustdy generate [--recipe]   ustdy import <mapping>   ustdy export [--origin generated]
ustdy reset [--to baseline|--runtime-only|--wipe]
ustdy snapshot save|restore <name>
ustdy action run <name> [--param k=v]
ustdy webhooks list|replay|pause
ustdy sim start|stop <name>
ustdy logs requests|events|deliveries
ustdy down
```

## 12. Verification strategy

- **Unit:** precedence chain, FK inference, generators (seeded golden outputs), JSONata templates, merge-patch.
- **Integration:** full CRUD against a fixture spec; restart persistence; reset modes; webhook delivery with a local receiver (retry, restart survival, faults).
- **Property/contract:** run Specmatic (or Schemathesis/Dredd equivalent) against the mock to confirm responses conform; generated data validated against schemas in CI.
- **Determinism test:** generate twice with the same seed; export must be identical.
- **Reference scenarios:** the ticket-broker POS (inventory/events/venues/lookup tables) and marketplace (listings + `marketplace-order` action) as end-to-end example projects shipped in `examples/`.

## 13. Risks

| Risk | Mitigation |
|---|---|
| FK/entity inference fails on inconsistently named vendor specs | Startup report, easy config pinning, `x-` extension, early test on the real POS spec |
| Spec schemas lack constraints, producing unrealistic data | Faker heuristics, computed fields, constraints block, import real reference data |
| Runtime-only reset semantic ambiguity | Decide journal vs. replay early (see §6.7 note) |
| Webhook templates become a mini-language to maintain | Stick to JSONata only; provide template testing command (`ustdy webhooks render`) |
| Spec evolves; persisted DB goes stale | Spec/config hash check on startup with explicit migrate/reset |
