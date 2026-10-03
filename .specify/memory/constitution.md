<!--
SYNC IMPACT REPORT — temporary review material, removed before commit.
Initial ratification (no prior version).
- Version change: none → 1.0.0
- Principles: 10 established (I–X). Mapping to the handoff's constitution suggestions
  (docs/04 §Constitution suggestions): I←2, II←1, III←3, IV←4, V←7, VI←6, VII←8,
  VIII←5, IX←9, X←10.
- Added sections: Additional Constraints; Development Workflow & Quality Gates; Governance.
- Removed sections: none.
- Deferred TODOs: none (ratification date known: 2026-10-03).
-->

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
  and `tasks.md` exist. The **spec** and **plan** are human checkpoints: Cameron approves each
  before the next phase runs.
- **GitHub Flow.** One feature per branch (`NNN-feature-name` from Spec Kit numbering, or
  `wt/<description>` for agent tasks). `main` is protected: PR required, **1 approving review**,
  the `test` status check required and strict, `enforce_admins` on, force pushes and deletions
  off. Every change to `main` arrives as a merged pull request.
- **TDD.** Red before green, per Principle VII. Test and implementation land in the same change.
- **Independent review.** The reviewer MUST come from a **different model lineage** than the
  author. The reviewer runs a Spec Kit converge cycle against the delivered branch and opens the
  pull request only when converge comes back clean.
- **Single merge authority.** **Jarvis (the coordinator) is the only actor that merges to
  `main`.** Authors and reviewers never merge, and no one approves their own work.
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
  adopted when Cameron approves it.
- **Versioning.** MAJOR: a principle is removed or redefined. MINOR: a principle or section is
  added, or guidance is materially expanded. PATCH: clarifications, wording, typos.
- **Compliance.** Every pull request verifies compliance with these principles; the plan's
  Constitution Check is the gate, and any violation is justified in Complexity Tracking or the
  change does not proceed. Complexity MUST be justified against a simpler alternative that was
  rejected and why.
- **Runtime guidance.** `docs/` holds the handoff package that seeded this constitution; `specs/`
  holds the feature specifications that refine it; `.specify/memory/constitution.md` is this
  document and the only authoritative copy.

**Version**: 1.0.0 | **Ratified**: 2026-10-03 | **Last Amended**: 2026-10-03
