# Phase 1 — Quickstart: Slice 2, Data Layer I

Runnable validation scenarios that prove slice 2 works end to end. Each is written to be executed
verbatim; expected outcomes are stated as **observable** facts, not as "it works". Prerequisites and
commands only — implementation details live in `tasks.md`.

## Prerequisites

- Slice 1 merged and green (`npm ci && npm run lint && npm run typecheck && npm run test`).
- A project directory with at least `understudy.yaml` and a specification (a fixture document is
  fine; the **live vendor document is optional** and never required by CI — research §0).

```bash
npm ci
npm run build
node dist/cli/index.js --help      # `ustdy` surface, including `init` and `generate`
```

## Scenario 1 — `init` scaffolds from the tool's own understanding (FR-020, US4)

```bash
mkdir scratch-pos && cd scratch-pos
ustdy init --spec ../tests/fixtures/inventory-api.yaml
```

**Expected**: the four layer folders exist (`static/{lookups,entities}`, `imports`, `dynamic`,
`behavior`), an `understudy.yaml` is written, and **stdout prints the inferred collection report** —
collections, links *with their evidence source*, and any **undetermined** link listed separately. A
developer should be able to decide what to pin without reading source.

## Scenario 2 — fixtures are byte-identical forever (FR-002, SC-003, US1)

```bash
ustdy up --port 8080 &                    # loads static/ only
curl -s localhost:8080/inventory | jq -S . > /tmp/a.json
for i in 1 2 3; do curl -s -X POST localhost:8080/inventory -H 'content-type: application/json' -d '{"quantity":3}' >/dev/null; done
curl -s localhost:8080/inventory | jq -S . > /tmp/b.json
diff /tmp/a.json /tmp/b.json && echo "FAIL: fixture rows moved"
```

**Expected**: the fixture rows are byte-identical before and after API writes; only the newly
created (runtime) rows differ. Killing and restarting the mock reproduces the same fixture rows.

## Scenario 3 — generation is deterministic, and independent per collection (FR-016, SC-002, SC-007, US3)

```bash
ustdy reset --to baseline                       # wipe
ustdy up --recipe ci-small --seed 42 &          # generate, port 8080
ustdy export --origin generated > /tmp/run1.json
# (export command ships in slice 3; until then the same comparison is asserted by the
#  integration test `tests/integration/determinism.test.ts` over the deterministic serialization)

ustdy reset --to baseline
ustdy up --recipe ci-small --seed 42 &
ustdy export --origin generated > /tmp/run2.json
diff /tmp/run1.json /tmp/run2.json && echo "OK: same seed, byte-identical"

# independence: add an UNRELATED collection to the recipe, regenerate, and diff the ORIGINAL collections
# -> every pre-existing collection's rows must be unchanged (this is what a shared RNG stream would break)
```

**Expected**: same seed ⇒ byte-identical exports; adding an unrelated collection leaves every
existing collection's generated records unchanged.

## Scenario 4 — fixtures and generated identities never collide (FR-017/018, SC-006)

```bash
ustdy up --recipe ci-small &     # recipe declares ids, e.g. Inventory from 100000
curl -s localhost:8080/inventory | jq -r '.[].id' | sort -n | uniq -d    # expect empty
# now declare two OVERLAPPING ranges and start again
```

**Expected**: no duplicate identity appears; and a configuration with overlapping ranges **refuses
to start**, naming the collection (not a stack trace).

## Scenario 5 — the report tells the truth about inference (FR-007, SC-005, US4)

```bash
ustdy up --spec <the live vendor document URL or a fixture with colliding names> 2>&1 | tee /tmp/report.txt
```

**Expected**: for a document with `externalId` on many collections (or the fixture that mimics it),
the report lists those links **as undetermined, with their candidates**, rather than picking one.
Each decided link names its evidence source (`configured` | `extension` | `convention` | `nesting`).
No link is resolved silently.

## Scenario 6 — a stated invariant is enforced or the run fails loudly (FR-013)

```bash
# recipe with constraints: ["price >= cost"] and a deliberately impossible draw
```

**Expected**: the tool re-draws up to the configured budget and then **fails, naming the rule** — it
never stores a record that violates a stated invariant, and never silently drops the invariant.

## Scenario 7 — the behaviour layer is validated but not run (spec boundary)

```bash
# introduce a typo into behavior/webhooks.yaml (an unknown key)
ustdy up ...
```

**Expected**: refuses to start naming the offending key (`FR-005`), with the same message shape as a
bad `understudy.yaml` key — i.e. the behaviour layer is *parsed and validated* in this slice even
though nothing acts on it until slices 4–5.

## Scenario 8 — performance (SC-008)

```bash
# recipe generating a few thousand rows across several collections
time (ustdy reset --to baseline && ustdy up --recipe load-test --port 8080 & \
      until curl -sf localhost:8080/__understudy/health >/dev/null; do sleep 0.1; done)
```

**Expected**: generated and serving in **well under a minute** on a developer machine.

## Scenario 9 — the live derivation, opt-in and non-blocking (research §0)

```bash
USTDY_LIVE_SPEC=https://pointofsaleapi.stubhub.net/swagger/v1/swagger.json npm run test -- live-derivation
```

**Expected**: the derivation runs against the **real** document (165 paths / 224 operations) and
records how many collections, links and **undetermined links** it finds, and how much pinning the
document actually needs. This test is **opt-in and never CI-blocking** (the document is not
vendored). Its measured outcome appends to `research.md` §0.
