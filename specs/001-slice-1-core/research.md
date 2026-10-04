# Phase 0 — Research: Slice 1, Core CRUD Mock

Decisions are recorded as: **Decision → Rationale → Alternatives considered**. Every option below
was checked against the live package registry and current upstream documentation on 2026-10-03,
not recalled.

## 1. OpenAPI document parsing and `$ref` resolution

**Decision**: `@scalar/openapi-parser` (`dereference`, `bundle`) with `@scalar/openapi-upgrader`
for 3.0 → 3.1 normalisation.

**Rationale**: The tool must accept OpenAPI **3.0 and 3.1** (FR-001) and operate on a single
normalised dialect internally, or every downstream validator and generator has to branch on the
source version. Scalar's parser is TypeScript-native, resolves external file and URL references via
plugins, handles circular references, and — critically — the ecosystem standardises on **OpenAPI
3.1.0 internally** with an explicit upgrader for 3.0 and Swagger 2.0. That gives one dialect at the
seam, which is what makes Ajv's draft-2020-12 mode usable (§3). It also accepts a **string or an
object**, so the same call handles a file, a URL, and a test fixture.

**Alternatives considered**:

- `@apidevtools/swagger-parser` — the incumbent, and it does support 3.1 and circular refs. Rejected
  as the primary: it does not normalise dialects (3.0 and 3.1 documents stay different in memory),
  and its own maintainers' ecosystem successor is Scalar's, which is tested against it for
  result-equivalence where intended. Kept as the documented fallback if Scalar's upgrade path
  proves lossy on a real vendor document — the risk mitigation named in `docs/02` §13.
- Hand-rolled `$ref` walking — rejected outright. External refs, circular refs and sibling keywords
  are exactly where a hand-rolled resolver is wrong in ways that surface as a wrong mock rather
  than an error.

## 2. HTTP framework

**Decision**: Fastify 5, with the mock surface and the control surface as separate plugin
instances (optionally separate ports).

**Rationale**: `docs/02` §1 nominates it and it earns the nomination: first-class JSON Schema
validation hooks (which matters because this project validates against JSON Schema continuously),
a mature plugin/encapsulation model that lets the mocked surface and the control surface be
genuinely separate instances in one process, and a route-matching layer that does not fight a
spec-derived router. It is also the mainstream choice, which matters for a public tool whose users
will want to read the code.

**Alternatives considered**: Express (no built-in schema validation, slower, and its middleware
model is what this project is explicitly *not* building); raw `node:http` (would mean writing
routing, validation hooks and content negotiation from scratch — all of it undifferentiated work);
Hono (excellent, but its strength is edge runtimes the tool does not target).

## 3. Schema validation

**Decision**: Ajv 8 with `ajv-formats`, instantiated in **draft 2020-12** mode
(`ajv/dist/2020`), plus a documented 3.0 fallback path.

**Rationale**: OpenAPI 3.1 adopts JSON Schema **draft 2020-12 unmodified**, so a 3.1 document's
schemas validate with no translation layer at all. Ajv also implements the OpenAPI-specific
`nullable` and `discriminator` keywords, which covers the 3.0 documents the upgrader may leave with
3.0-isms. One validator instance validates (a) incoming requests, (b) outgoing responses in tests,
and (c) the project's own config file (§5) — three uses, one dependency, which is why it is worth
the extra care over a hand-rolled validator.

**Alternatives considered**: `jsonschema` (slower, less complete on 2020-12); hand-rolled (the same
argument as §1 — validation is the product's contract claim, and a wrong validator makes the tool
lie about conformance); Zod (excellent for the *config* shapes but it does not consume a document's
existing JSON Schemas, which is the actual requirement).

## 4. Storage

**Decision**: `better-sqlite3` behind a `Store` interface.

**Rationale**: The handoff nominates it and the tradeoff is narrow: `better-sqlite3` and Node's
built-in `node:sqlite` are both **synchronous** and benchmark comparably, both avoiding the
promise/worker-thread overhead that makes `node-sqlite3` ~12–24× slower on read paths. The decision
between them comes down to maturity and surface area: `better-sqlite3` is the mature, widely used
option with user-defined functions, virtual tables and a backup API, while `node:sqlite` was still
marked *Active development* at Node 22.5 and only reached release-candidate status on a later LTS.
For a tool whose job is to persist state a consumer can rely on, the mature driver wins — and the
`Store` interface means swapping to `node:sqlite` later costs one file.

**Consequences to design for**: `better-sqlite3` is a native module, so the tool needs prebuilt
binaries across platforms (it has them) and the Docker image (slice 7) must be built for its target
arch. Its synchronous API is fine here: the CRUD engine's per-operation work is a single indexed
row read/write, and blocking on it is what makes the "one transaction per mutation" shape
(constitution V) straightforward.

**Alternatives considered**: `node:sqlite` (above — right call, wrong moment); Postgres (explicitly
slice 6, and the interface keeps the door open); an in-memory store as the v1 default (rejected:
FR-010 requires persistence across restart, and that is the acceptance scenario consumers care
about most).

## 5. Config file format and validation

**Decision**: YAML, parsed with `yaml`, validated against a JSON Schema with the same Ajv instance.

**Rationale**: `docs/03` specifies YAML with JSON accepted; YAML with comments is the right shape
for a file humans edit and commit, and the handoff's own examples are YAML. Validating it against a
JSON Schema rather than ad-hoc checks keeps one validation mechanism in the codebase and lets the
schema file *be* the documentation (`contracts/config.schema.yaml`), which is how principle IX
("every key documented with an example") is satisfied checkably rather than by good intentions.

**Alternatives considered**: Zod (better ergonomics, second validation library); TOML (no nested
structure story as clean as YAML for the fixtures/recipes layering in slice 2); JSON-only (no
comments — unusable for a file full of operation selections and, later, field rules).

## 6. CLI framework

**Decision**: commander.

**Rationale**: The handoff offers commander or oclif. oclif is a framework for building a plugin-
based CLI suite — its value is plugin discovery, multi-command packaging and update machinery, none
of which this tool needs. commander is a single dependency whose command/argument model maps
directly onto the slice-1 surface (`up`, `down`, `reset`, `ops`) and, crucially, makes it obvious
that each command does nothing but call the control API.

**Alternatives considered**: oclif (above); `yargs` (heavier, and its middleware encourages the
logic-in-the-CLI pattern the constitution bans); hand-rolled `process.argv` parsing (fine until
the first subcommand, then it is a framework with worse debugging).

## 7. Identity allocation for API-created records

**Decision**: for integer identities, allocate from a per-collection range that starts at
`100000` by default and is configurable; for declared string or formatted identities, generate a
value that satisfies the declared pattern and is tagged so it cannot collide with a slice-2
fixture value.

**Rationale**: FR-011 and the handoff's C8 require that generated identities never collide with
fixture-supplied ones, and slice 2 cannot be implemented without that property already holding.
Settling it in slice 1 (when the only writer is the API) is what makes slice 2 additive. `100000`
is the handoff's own default; the exact base matters far less than the *reservation being
explicit and reported*.

**Alternatives considered**: autoincrement from 1 (collides with the fixture IDs that slice 2's
`static/` layer will declare, and the collision would be silent); UUIDs everywhere (violates the
document's declared type — the tool must produce what the spec says, not what is convenient).

## 8. Conformance verification

**Decision**: slice 1 ships its own contract-conformance suite driven by the fixture document. The
handoff's nominated external verifier, **Specmatic**, is reviewed now and wired in slice 7.

**Rationale**: Specmatic does support stateful mocking, but its stateful mode is an **Enterprise**
feature requiring a licence, and its documented state is **in-memory and lost when the process
stops** — which is precisely the property this product exists to provide. That confirms the
handoff's own conclusion (`docs/README`): Specmatic is a **conformance verifier for this tool, not
a foundation**, and its licensing is a real constraint for a public MIT project's CI. Slice 1
therefore proves conformance with a suite that drives the running mock over HTTP and asserts every
response against the same document the mock was built from. Slice 7 evaluates Specmatic and
Schemathesis as the *external* check, in CI, where a missing licence is a CI-configuration problem
rather than a product dependency.

**Alternatives considered**: adopt Specmatic as the foundation (rejected — Enterprise licence and
in-memory state); skip contract testing in slice 1 (rejected — SC-003 is a slice-1 success
criterion, and "we will test the contract later" is how a mock stops matching its spec).

## 9. What slice 1 deliberately does not resolve

Carried forward, each with a home:

- **Q2, runtime-only reset semantics** — slice 3. Slice 1 implements wipe only.
- **Q4, pagination/filter conventions in the real vendor specs** — needs the real document; the
  fixture documents exercise all three styles named in `docs/04`.
- **Q5, vendor-prefixed identity formats** — answered conservatively here (§7); revisited if a real
  document contradicts it.
- **Q6, relationship-naming consistency in the real POS spec** — the spike belongs to slice 2,
  where inference is the subject. Slice 1 derives only enough to report.
- **Q12, authentication on the mocked surface** — deferred; the mocked surface is open in slice 1.
