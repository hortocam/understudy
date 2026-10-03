# Understudy — Handoff Package

**Name:** Understudy (npm/package: `understudy`, CLI binary: `ustdy`). Open source, TypeScript/Node.

It learns the part (your OpenAPI spec) and performs it until the real service is available.

A tool that takes selected operations from an OpenAPI spec and serves a **stateful, persistent, contract-valid mock** of them, pre-populated with realistic generated/imported data, able to emit webhooks and simulate third-party-initiated events. Controlled API-first and via CLI.

## Documents

| File | Purpose | Spec Kit phase |
|---|---|---|
| `01-product-spec.md` | What and why: problem, users, user stories, functional/non-functional requirements, acceptance criteria, out of scope | `/speckit.specify` input |
| `02-architecture.md` | How: components, data model, generation pipeline, event bus, webhooks, actions, control API, CLI, tech choices | `/speckit.plan` input |
| `03-config-reference.md` | Draft config file formats with examples (static / dynamic / imports / behavior) | `/speckit.plan` + `/speckit.clarify` input |
| `04-phasing-and-open-questions.md` | Suggested delivery slices, deferred items, open decisions, constitution suggestions | `/speckit.constitution`, `/speckit.tasks` input |

## How to use with Spec Kit

1. `/speckit.constitution` — seed from "Constitution suggestions" in `04`.
2. `/speckit.specify` — one feature per slice in `04` (start with Slice 1). Paste the relevant stories/requirements from `01`; reference requirement IDs (FR-xxx).
3. `/speckit.clarify` — resolve the open questions in `04` that touch the slice.
4. `/speckit.plan` — supply `02` and `03` as technical context; the stack in `02` is a recommendation, not a mandate.
5. `/speckit.tasks` / `/speckit.implement` — iterate per slice.

## Decisions already made

- Prior art reviewed: Specmatic, Mockoon, Imposter, WireMock, Prism, json-server. None provides spec-selected CRUD + persistence + data generation + webhooks + synthetic actions. Specmatic is the closest and is intended as a **conformance verifier** for this tool, not a foundation (verify its stateful-mode capabilities during planning).
- Expression/template language: **JSONata**.
- Webhook signing (HMAC with a secret supplied by the consumer at subscription time): **deferred**, but the design must leave room for it.
- Control surface: HTTP control API is the source of truth; the CLI is a thin client over it.
- Domain driving the design: ticket-broker POS/inventory system, plus a ticket marketplace (StubHub-like) integration.
