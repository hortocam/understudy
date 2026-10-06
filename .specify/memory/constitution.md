# Understudy Constitution

## Core Principles

### I. Spec Is the Source of Truth

The upstream **OpenAPI document is the contract**; every mock behaviour derives from it.
Configuration refines the spec and MUST NOT silently contradict it — a conflict is reported at
startup, never resolved by guessing. The same rule governs this repository: the Spec Kit feature
spec is the source of truth for implementation. Code is written to match the spec; the spec is
never edited to match the code. A behaviour that is not in a spec is not a behaviour.

*Rationale:* the product's entire value is that a mock of a service behaves like the service. The
moment the tool's own convenience overrides the declared contract, mocks stop predicting reality
and start hiding integration bugs.

### II. API-First Control Surface

Every capability is reachable through the **control API**; the CLI is a thin client over it and
MUST add no logic the API lacks. The control API is itself described by an OpenAPI document,
served at the reserved prefix (default `/__understudy/`) and isolated from the mocked surface.

*Rationale:* one implementation of behaviour, two spellings of the UI. A CLI that grows its own
logic becomes a second, divergent product.

### III. Determinism by Default

Given the same spec, seed, configuration, and imports, the tool MUST produce the same state,
byte-identical on export. Nondeterminism is **opt-in** and confined behind explicit seams (the
clock, runtime ID allocation). Seeding, ordering, and ID allocation are defined, not incidental.

*Rationale:* a mock that differs between runs cannot back a reproducible CI suite, and
"flaky mock" is indistinguishable from "flaky code under test".

### IV. Static / Dynamic Separation

Versioned fixtures (`static/`, `behavior/`) are **never mutated** by generation, import, or
runtime activity. Generation writes only `generated`-origin rows; the mock surface writes only
`runtime`-origin rows. Every row carries its `origin`, and export can reproduce any layer.

*Rationale:* fixtures are reviewable artefacts under version control. A tool that rewrites them
in place destroys the reviewer's ability to diff intent.

### V. Atomicity

State changes, domain events, and outbox entries commit together in a single transaction or not
at all. There MUST be no event for a rolled-back change, and no committed change without its
event. Actions execute atomically and report a structured result.

*Rationale:* the transactional-outbox invariant is the difference between a mock that models a
real integration and one that produces phantom side effects.

### VI. Explicit Over Magic

Every inference — entities, foreign keys, field generators, list-paging style — is **reported at
startup** and **pinnable in configuration**. Silent guessing is a defect; an ambiguity the tool
cannot resolve is surfaced, not resolved arbitrarily. The startup report is part of the
interface, not debug output.

*Rationale:* the failure mode this product exists to fix is a test double that quietly differs
from the real service. Hidden inference re-creates that failure inside the tool.

### VII. Test-First, Contract-Verified (NON-NEGOTIABLE)

TDD is mandatory: a failing test exists before the code that passes it (red → green → refactor).
The precedence chain, entity/FK inference, generators, and templates carry **golden-file tests**;
determinism is proven by double-generation equality; and contract conformance (Specmatic or
equivalent) runs against the running mock **in CI**. A capability with no test is not delivered.

*Rationale:* the engine is a pile of inference and ordering rules whose bugs are invisible by
inspection and obvious in a golden file.

### VIII. Safe and Portable by Default

The tool makes **no outbound calls** other than explicitly configured webhook targets and import
sources. Secrets come from the environment and MUST NOT appear in config files or the repository.
The tool runs identically on Linux, macOS, and Windows, and ships as a container image; multiple
instances run side by side without shared state.

*Rationale:* this is a thing developers leave running in CI. If it can surprise them with network
traffic or a leaked credential, it is unsafe by construction.

### IX. Small, Documented Config Surface

Every configuration key MUST have documentation and a runnable example in the same change that
introduces it. A new key without both is incomplete work. Reserved keys (`signing`, `clock`,
`storage.driver: postgres`, relationship `onDelete`) are documented **as reserved** until
implemented, so the shape is stable before the feature lands.

*Rationale:* the config file is the product's API for its users; undocumented surface is
unusable surface.

### X. Additive Evolution

Extension seams (webhook `signer`, storage adapter, clock) MUST exist before the features that
use them, so later slices add capability without rework. Amendments to this constitution
**extend**; they never rewrite history — the record of what was decided, and why, is retained in
every version.

*Rationale:* the delivery slices are sequenced deliberately; a seam added after the fact is a
refactor of shipped behaviour, which is exactly the cost this sequencing avoids.

### XI. Every Unit of Work Ships a Runnable Demo

Every phase and every delivery slice MUST ship a short, **runnable** walkthrough that a person can
follow — on their own machine, against a built checkout — to exercise each of the unit's tasks and
see the change for themselves. It lives beside the spec as `specs/<feature>/demo.md`: a cycle
through the real CLI/API, not a QA checklist and not a description of the tests.

- It MUST be **executable as written**: verbatim commands, each with its **observable** expected
  outcome (a status code, a printed line, an exit status) — never "it works".
- It MUST exercise **each phase** of its unit, so a reader can trace every task to something they
  saw happen.
- It MUST carry a **negative control** wherever the behaviour is a refusal, a guard or an
  invariant: a step showing the wrong input being rejected, so a green run cannot be mistaken for
  a mock that fails open.
- Its expected outcomes are the **committed surface** of the unit. A demo that reads a field the
  API does not serve, or quotes a message the code does not print, is a defect in the demo — and
  it is updated in the same change that changes what it shows.
- It is the **human checkpoint's script**: the owner (or the reviewer) runs it to accept the unit,
  and the unit is not "done" until it runs as written on the merged revision.

*Rationale:* a spec says what a unit should do and a test says the code agrees with itself; neither
lets a person *see* the behaviour and build their own mental model of it. A demo the owner can run
is how the owner keeps first-hand familiarity with the product as it grows, and how manual
validation differs from trusting a green suite. A demo written from the code but never run is a
second description that rots — so it is executed as written before the unit is complete.

## Additional Constraints

- **Stack.** TypeScript on Node.js 22+, ES modules. HTTP: Fastify (mock surface and control
  surface as separate plugin instances, optionally separate ports). Spec handling:
  `@apidevtools/swagger-parser` or `@scalar/openapi-parser` for `$ref` resolution, Ajv for
  schema validation. Storage: SQLite via `better-sqlite3`, behind a `Store` interface. Data
  generation: `@faker-js/faker` (seeded) plus a generator registry. Expressions and templates:
  **JSONata**. CLI: `commander`. These are defaults, not a mandate: a deviation is recorded in
  `plan.md` → Complexity Tracking with the reason.
- **Protocol scope.** OpenAPI 3.0/3.1, REST/JSON. No GraphQL, gRPC, or SOAP. No GUI. The tool is
  not a load-testing tool and not an API gateway.
- **Distribution.** Public repository. npm package `understudy`, CLI binary `ustdy`, container
  image. License: MIT.
- **Prohibited.** Direct pushes to `main`; force-pushes to `main`; committing runtime state
  (`.understudy/`, `*.db`) or secrets; hand-written per-endpoint handlers for standard CRUD;
  merging without a clean review (see below); fabricated evidence of a run that did not happen.

## Development Workflow & Quality Gates

- **Spec-first.** No implementation code for a feature until that feature's `spec.md`, `plan.md`
  and `tasks.md` exist. The **spec** and **plan** are human checkpoints: the project owner approves
  each before the next phase runs.
- **GitHub Flow.** One feature per branch (`NNN-feature-name` from Spec Kit numbering, or
  `wt/<description>` for agent tasks). `main` is protected: PR required, **1 approving review**,
  the `test` status check required and strict, `enforce_admins` on, force pushes and deletions
  off. Every change to `main` arrives as a merged pull request.
- **TDD.** Red before green, per Principle VII. Test and implementation land in the same change.
- **Every unit ships a runnable demo.** A phase or slice is not complete until `specs/<feature>/demo.md`
  runs as written on the merged revision (Principle XI): verbatim commands, observable outcomes,
  every phase exercised, a negative control for each guard.
- **Independent review.** The reviewer MUST come from a **different model lineage** than the
  author. The reviewer runs a Spec Kit converge cycle against the delivered branch and opens the
  pull request only when converge comes back clean.
- **Single merge authority.** **The coordinator is the only actor that merges to `main`.** Authors and reviewers never merge, and no one approves their own work.
- **CI is law.** A red `test` check blocks merge. A local pass is not evidence; the check on the
  pull request is.
- **Evidence over summary.** A phase is "done" only when verified against the remote: a branch
  pushed for that work, a real open pull request, CI green, a clean converge. Worker self-reports
  are claims, not proof.

## Governance

This constitution supersedes other practices, conventions, and instructions in this repository.
Where a conflict exists, this document wins and the other artefact is corrected.

- **Amendments.** Amendments **extend** the document; they never replace it. Full history stays
  present in every version, and every amendment records its **Why** so the reasoning travels with
  the rule.
- **Adoption.** There is no ratification hurdle in a one-human, many-agent shop: an amendment is
  adopted when the project owner approves it.
- **Versioning.** MAJOR: a principle is removed or redefined. MINOR: a principle or section is
  added, or guidance is materially expanded. PATCH: clarifications, wording, typos.
- **Compliance.** Every pull request verifies compliance with these principles; the plan's
  Constitution Check is the gate, and any violation is justified in Complexity Tracking or the
  change does not proceed. Complexity MUST be justified against a simpler alternative that was
  rejected and why.
- **Runtime guidance.** `docs/` holds the handoff package that seeded this constitution; `specs/`
  holds the feature specifications that refine it; `.specify/memory/constitution.md` is this
  document and the only authoritative copy.

**Version**: 1.1.0 | **Ratified**: 2026-10-03 | **Last Amended**: 2026-10-06

## Amendment 2026-10-06 — XI: Every Unit of Work Ships a Runnable Demo

**Why.** The owner asked for it directly, after slice 2 completed: they want, for every phase and
slice going forward, "a set of steps a human can follow to see the changes and verify" — "just a
cycle through the CLI steps and commands that will exercise each of the tasks", so that they can
(A) stay familiar with how the tool is actually used and (B) manually validate each unit before it
is accepted. The spec and the automated suite answer "is it correct?"; they do not let a person
*see* the behaviour or build a mental model of it. This makes the demo a first-class deliverable
rather than something a developer writes ad hoc.

**What changes.** Adds Principle XI and a workflow bullet ("Every unit ships a runnable demo"). New
documentation artefact per feature, `specs/<feature>/demo.md`, plus a `.specify/templates/
demo-template.md` so the Spec Kit tasks step carries it. Nothing existing is redefined: the demo is
**additive** to the human checkpoint that already gates each spec and plan, and it neither replaces
nor weakens the tests (VII) or the review gate.

**Scope note (governance).** The rule is adopted by the owner's approval, per "Governance →
Adoption". Applying it retroactively is deliberately bounded: slices 1 and 2 are backfilled with a
`demo.md` each, written **from a real run** of the merged revision, because they merged before the
rule existed. Every unit that starts after this amendment carries a `demo.md` as a normal task.

**Not a redefinition.** MINOR bump, not MAJOR: no principle is removed or redefined; a principle is
added and guidance expanded.
