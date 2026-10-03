# 04 — Phasing, Open Questions, Constitution Suggestions

## Suggested delivery slices

Each slice is intended to be one Spec Kit feature (`/speckit.specify` → … → `/speckit.implement`) and leaves the product usable.

| # | Slice | Delivers | Stories / FRs |
|---|---|---|---|
| 1 | **Core CRUD mock** | Spec load, operation selection, validation, generic CRUD, SQLite persistence, 501 handling, `/__understudy` health/reset/teardown, minimal CLI (`up`, `down`, `reset`, `ops`) | A1–A5, B1–B3 (basic), FR-001–007, FR-021 (wipe) |
| 2 | **Data layer I: config + generation** | Config layers, entity/FK inference + startup report, precedence chain, faker, counts/perParent, seed determinism, ID ranges, origin tagging, `ustdy init`, `ustdy generate` | C1–C8, FR-008–013 |
| 3 | **Import / export / snapshot** | Mapping-driven import, export by origin, snapshot/restore, reset modes (`baseline`, `runtime-only`) | D1–D3, FR-014, FR-021 |
| 4 | **Events and webhooks** | Event bus (transactional outbox), targets, subscriptions, JSONata templates, outbox dispatcher with retry/delay, delivery log + replay, operation-bound triggers, spec-schema payload validation | E1–E5, FR-015–016 |
| 5 | **Actions, reactions, simulation** | Action runner + step set, `actions-only` entities, manual/schedule/reaction/simulation triggers, scripted step | F1–F7, FR-018–020 |
| 6 | **Hardening and extras** | Webhook fault injection, **HMAC signing with consumer-supplied secret**, consumer subscription store, virtual clock, request log filters, Postgres adapter | E6–E7, FR-017, FR-022–023 |
| 7 | **Conformance and examples** | Specmatic (or equivalent) conformance recipe in CI, shipped example projects (ticket-broker POS, marketplace), docs site | G1, NFR docs |

Slices 1–3 produce a usable data-rich mock; 4–5 add behavior. Slice 6 items can be pulled forward individually if needed.

## Explicitly deferred

- Webhook signing/HMAC (Slice 6). The dispatcher must expose a `signer` hook from Slice 4 so it can be added without rework. Algorithm unconfirmed — assume HMAC-SHA256, keep algorithm/header/signed-content configurable.
- Postgres/shared-state mode, GUI, multi-protocol support, virtual clock.

## Open questions (resolve in `/speckit.clarify`)

1. ~~Implementation language~~ **Decided:** TypeScript/Node, open source. CLI binary `ustdy`, package `understudy`. Remaining: verify npm/GitHub name availability and choose a license (MIT or Apache-2.0 suggested).
2. **Runtime-only reset semantics.** Delete runtime rows only, or also revert runtime edits to non-runtime rows (requires a change journal)? See `02` §6.7.
3. **Specmatic's stateful mode.** Verify what it actually supports today and its licensing; decide whether it is only a conformance verifier (current plan) or something to integrate more deeply.
4. **Pagination/filter conventions.** Which patterns does the target POS and marketplace spec use (offset/limit, page/size, cursor, `filter[...]`)? Drives list-endpoint inference.
5. **ID types.** Integer vs. UUID vs. vendor-prefixed strings in the target specs; whether IDs must follow a vendor format.
6. **FK naming consistency in the real POS spec.** Run the inference against the actual spec early (spike in Slice 2) to see how much pinning is needed.
7. **Webhook delivery guarantees to model.** At-least-once with duplicates only when injected? Ordering guarantees per entity?
8. **Real payload formats.** Collect real webhook payload samples (POS and marketplace) to build the reference templates.
9. **Consumer-created subscriptions.** Does the target service's spec have a subscribe endpoint? If so it becomes a mocked CRUD entity whose rows drive webhook targets and secrets (dynamic targets vs. static config).
10. **Import sources.** Static files only, or live pulls from the real service (credentials handling)?
11. **Multi-tenancy.** Does the real POS scope data by company/tenant ID (e.g. `companyId` on everything)? Should the mock enforce tenant scoping from a header/token?
12. **Auth on the mock surface.** Do consumers require an auth header to be present/valid (mock the token endpoint?) or is the mock open?
13. **Simulated time.** Is wall-clock acceptable for CI, or are virtual-clock-driven scenarios (fast-forward 30 minutes) required sooner?
14. **Distribution.** npm package, Docker image, or both as the primary distribution?

## Constitution suggestions

Principles to seed `/speckit.constitution`:

1. **API-first control.** Every capability is available through the control API; the CLI is a client of it and adds no logic.
2. **Spec is the source of truth.** Behavior derives from the OpenAPI spec; configuration refines it and never silently contradicts it. Conflicts are reported at startup.
3. **Determinism by default.** Given the same seed, config, imports, and spec, state is reproducible. Nondeterminism is opt-in.
4. **Static vs. dynamic separation.** Versioned fixtures (static, behavior) are never mutated by generation or runtime activity.
5. **Safe to run in CI.** No hidden global state; no outbound calls except configured webhook targets and import sources; secrets come from the environment, never config files.
6. **Explicit over magic.** Inference (entities, FKs, generators) is always visible in a report and pinnable in config.
7. **Atomicity.** State changes, events, and outbox entries commit together or not at all.
8. **Test-first for the engine.** Precedence chain, inference, generation, and templates have golden-file tests; contract conformance runs in CI.
9. **Small, documented config surface.** Every config key has docs and an example; new keys require both.
10. **Additive evolution.** Reserved extension points (signer, storage adapter, clock) exist before the features that use them.

## Glossary

- **Entity:** a schema-backed collection in the mock store (e.g. Inventory).
- **Origin:** how a row came to exist — static, imported, generated, runtime.
- **Recipe:** a dynamic config file defining seed, counts, and generators.
- **Baseline:** state produced by static + imports + a recipe with its seed, before any runtime activity.
- **Action:** a named declarative sequence that mutates state/emits events without an API endpoint.
- **Reaction:** an event-triggered action.
- **Simulation:** seeded rules that run actions over time.
