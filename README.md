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

**Planning.** This repository is being driven spec-first with
[Spec Kit](https://github.com/github/spec-kit): the project constitution and one feature
specification per delivery slice land before any implementation code.

| Slice | Scope |
|---|---|
| 1 | Core CRUD mock (spec load, operation selection, validation, generic CRUD, SQLite persistence, 501 handling, minimal control API + CLI) |
| 2 | Data layer I — config layers, entity/FK inference, generation, determinism |
| 3 | Import / export / snapshot |
| 4 | Events and webhooks |
| 5 | Actions, reactions, simulation |
| 6 | Hardening (fault injection, HMAC signing, virtual clock) |
| 7 | Conformance and shipped examples |

## Repository layout

```
.specify/        Spec Kit engine (scripts, templates, memory/constitution.md)
specs/           One directory per feature, produced by the Spec Kit cycle
docs/            Handoff package — the source material for the specs
  README.md        how the package maps onto the Spec Kit phases
  01-product-spec.md              problem, users, stories, FRs  (→ /speckit-specify)
  02-architecture.md              components, data model, tech  (→ /speckit-plan)
  03-config-reference.md          draft config formats           (→ /speckit-clarify)
  04-phasing-and-open-questions.md  slices, deferrals, open questions (→ /speckit-constitution)
  05-target-apis.md               the target vendor APIs, measured (→ /speckit-plan)
src/             implementation (filled by the feature specs, not before)
tests/           unit + integration + contract tests
```

## Development

Node.js 22+.

```bash
npm ci
npm run lint        # eslint
npm run typecheck   # tsc --noEmit
npm run test        # vitest
```

## License

MIT — see [LICENSE](LICENSE).
