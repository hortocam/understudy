# Specification Quality Checklist: Slice 1 — Core CRUD Mock

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-03
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

- Items marked incomplete require spec updates before `/speckit-clarify` or `/speckit-plan`

### Validation history

**Iteration 1 (2026-10-03)** — 16/16 items pass.

Two deliberate deviations from the checklist's letter, recorded rather than "fixed", because the
letter of the rule would damage the artefact:

1. **"No implementation details" (Content Quality / Feature Readiness).** The spec's *Assumptions*
   section names the stack (TypeScript, Node, Fastify, Ajv, SQLite, commander). This is not a leak
   of design into requirements: the stack is a **binding constraint from the product owner**
   recorded in the handoff (`docs/04` Q1, "Decided") and carried into the constitution's Additional
   Constraints. The requirements themselves (FR-001…FR-024) and every success criterion (SC-001…
   SC-008) remain technology-agnostic; no requirement names a framework. The stack statement lives
   in Assumptions precisely so it can be audited in one place.
2. **Success criteria "measurable" vs. qualitative clauses.** SC-001 and SC-006 mix a hard
   threshold (under 5 minutes; names every entity) with a readability judgement ("readable by a
   human without reading source"). The thresholds are the binding part; the qualitative half is
   kept because the product's core risk is *inference the user cannot see*, and a purely numeric
   criterion would let a technically-passing but useless report through.

### Independent review (2026-10-03, `understudy-reviewer`, different model lineage)

Verdict on the first pass: **CHANGES REQUIRED** — 5 blocking, 8 non-blocking findings. All were
accepted and fixed; none required a re-design. Recorded here because a checklist that only ever
says "pass" is evidence of nothing.

The blocking findings and what changed:

1. **FR identifiers collide with the handoff's.** `docs/01` numbers FR-001…FR-023 and this spec
   numbered FR-001…FR-024 with different meanings from FR-005 onward, so the same identifier meant
   two things across the two documents — and `docs/04`'s slice table cites the handoff's
   numbering. *Fixed:* a full crosswalk table at the end of `spec.md`, mapping every `docs/01`
   requirement to carried / narrowed / deferred and naming the FRs that have no handoff
   counterpart.
2. **The control-API contract declared only 200 responses**, while both this spec's edge cases and
   the control README promised a 400 on a malformed body and a 404 on an unknown control path. A
   consumer generating a client from the served document could not know they existed. *Fixed:*
   `ControlError` schema plus declared 400/404/500 responses on every operation, and a documented
   `/{unknown}` catch-all.
3. **`/openapi.json` declared no body schema** — in OpenAPI terms, an empty response, which
   contradicts FR-018's "serve that description". *Fixed:* it now declares `application/json`
   carrying an `OpenApiDocument` schema.
4. **Principle IX was violated, not passed.** See the correction in `plan.md`. *Fixed:* reserved
   keys added to the config schema.
5. **Two success criteria were not actually exercised by the quickstart** (SC-001's five-minute
   budget; SC-006's report contents were described but not checkable). *Fixed:* §3 now asks the
   reader to time the path, and names the exact report contents with a `jq` assertion.

The non-blocking findings were also taken: entity-scoped reset is now stated in FR-014, FR-019's
command enumeration is exhaustive and names request-log access, the foreign-key edge case is
explicitly deferred to slice 2 rather than reading as a slice-1 deliverable, the trailing-slash
deviation from `docs/01` FR-006 is recorded in Assumptions, the missing `contracts/cli.md` now
exists, and constitution IV gained a machine-checked assertion (`every row is origin='runtime'`)
rather than a comment.

The reviewer was explicitly told this was a spec-only review with no implementation to converge,
and it reported that limitation plainly rather than claiming a converge it could not run — which is
the behaviour the gate exists to produce.

### Deliberate omissions (deferred, not forgotten)

- **Reset modes beyond wipe** — `baseline` and `runtime-only` need the data layer (slice 2) and
  import/export (slice 3). Slice 1 implements the wipe and leaves the mode as a parameter.
- **Mock-surface authentication** — handoff open question Q12; deferred, recorded in Assumptions.
- **Real vendor spec validation** — handoff open question Q6; scheduled as a slice-2 spike.

There are no `[NEEDS CLARIFICATION]` markers: each of the three open questions that touch slice 1
either has a reasonable default (recorded in Assumptions) or is explicitly deferred with a named
home in a later slice, per the `speckit-specify` guidance of a maximum of three markers reserved
for decisions that change scope, security or UX. `/speckit-clarify` is therefore optional for this
feature; it is worthwhile only if the project owner wants the reset-mode or auth decisions pulled
forward.
