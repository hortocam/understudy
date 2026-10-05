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
ustdy up --port 8080 &                    # loads static/ only (no recipe)
curl -s localhost:8080/venues | jq -S '[.[]|select(.id<100000)]' > /tmp/a.json     # the fixture identities
for i in 1 2 3; do curl -s -X POST localhost:8080/venues -H 'content-type: application/json' -d '{"name":"Runtime Hall"}' >/dev/null; done
curl -s localhost:8080/venues | jq -S '[.[]|select(.id<100000)]' > /tmp/b.json
diff /tmp/a.json /tmp/b.json && echo "OK: the fixture rows are byte-identical"
```

**Expected**: the fixture rows (identities below `ids.generatedStart`) are byte-identical before and
after API writes — the `diff` is empty; only the newly created (runtime) rows are new. Stopping and
restarting the mock reproduces the same fixture rows. (An API `PATCH`/`DELETE` addressed to a fixture
identity is a mutation, and the next start restores the row from the file — spec amendment A4.)

## Scenario 3 — generation is deterministic, and independent per collection (FR-016, SC-002, SC-007, US3)

```bash
snapshot() { for c in venues events inventory; do echo "== $c"; curl -s "localhost:8080/$c" | jq -S .; done; }

rm -rf .understudy                                  # a wiped store (or: ustdy reset --to wipe)
ustdy up --recipe ci-small --seed 42 --port 8080 &  ;  snapshot > /tmp/run1.json ; ustdy down
rm -rf .understudy
ustdy up --recipe ci-small --seed 42 --port 8080 &  ;  snapshot > /tmp/run2.json ; ustdy down
diff /tmp/run1.json /tmp/run2.json && echo "OK: same seed, byte-identical"

# independence: the same seed with a recipe that ADDS an unrelated collection (AuditNote)
rm -rf .understudy
ustdy up --recipe ci-small-plus --seed 42 --port 8080 & ; snapshot > /tmp/run4.json ; ustdy down
diff /tmp/run1.json /tmp/run4.json && echo "OK: every existing collection is unchanged"
```

**Expected**: same seed ⇒ byte-identical output; a different `--seed` ⇒ different output; adding an
unrelated collection leaves every existing collection's records unchanged. The shipped `export`
command is slice 3's; until then the byte-identical comparison over the *stored* state (timestamps
included, clock pinned) is asserted by `tests/integration/determinism.test.ts` and
`tests/integration/independence.test.ts`, and the API listing above is the user-visible form of it.

## Scenario 4 — fixtures and generated identities never collide (FR-017/018, SC-006)

```bash
ustdy up --recipe ci-small --port 8080 &
for c in venues events inventory; do curl -s localhost:8080/$c | jq -r '.[].id' | sort -n | uniq -d; done   # expect empty
ustdy down
# now declare a generated range that overlaps a fixture identity (Venue fixtures are 1 and 2):
#   entities: { Venue: { ids: { generatedStart: 1 } } }
ustdy up --config overlap.yaml      # refuses to start
```

**Expected**: no duplicate identity appears; and a configuration with overlapping ranges **refuses
to start**, naming the collection (not a stack trace).

## Scenario 5 — the report tells the truth about inference (FR-007, SC-005, US4)

```bash
ustdy init --spec tests/fixtures/collisions-api.yaml --dir /tmp/collide | tee /tmp/report.txt
# (or `ustdy up --config <a project on the live vendor document>`: the same report is printed at start)
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
rm -rf .understudy
time ( ustdy up --recipe load-test --port 8080 > /dev/null & \
       until curl -sf localhost:8080/__understudy/health >/dev/null; do sleep 0.1; done )
```

**Expected**: generated and serving in **well under a minute** on a developer machine.

## Scenario 9 — the live derivation, opt-in and non-blocking (research §0)

```bash
USTDY_LIVE_SPEC=https://pointofsaleapi.stubhub.net/swagger/v1/swagger.json npm run test:live
```

**Expected**: the derivation runs against the **real** document (165 paths / 224 operations) and
records how many collections, links and **undetermined links** it finds, and how much pinning the
document actually needs. This test is **opt-in and never CI-blocking** (the document is not
vendored). Its measured outcome is recorded in `live-derivation.md` (the approved `research.md` is not edited).

## Scenario 10 — apply a recipe to a RUNNING mock (FR-021)

```bash
ustdy up --port 8080 &                 # fixtures only
ustdy generate --recipe ci-small       # created, by collection and origin
ustdy generate --recipe ci-small       # "already applied": nothing regenerated
ustdy generate --recipe ci-small --seed 1   # refused: the store holds seed 42; reset first
ustdy reset --to wipe && ustdy generate --recipe ci-small --seed 1
```

---

## Corrections made when this quickstart was first run (T088; recorded in `quickstart-run.txt`)

Each is a defect in **this quickstart**, not in the code, and was fixed here:

1. `ustdy reset --to baseline` does not exist — slice 1's only reset mode is `wipe` (a fresh store, `rm -rf .understudy`, is the other way to start clean).
2. `ustdy export` is slice 3's; the byte-identical comparison is asserted in the integration tests and shown through the API listing.
3. `ustdy up --spec <…>` is not a flag — a project's spec is its `understudy.yaml`; the report is also printed by `ustdy init --spec`.
4. Scenario 2's `diff … && echo "FAIL"` read backwards (an identical diff is the *success*), and compared the whole list, which legitimately gains the runtime rows; it now compares the fixture identities only.
5. Scenario 9: `npm run test -- live-derivation` finds nothing, because the live test is deliberately excluded from `npm test` (so CI can never depend on the vendor document); it is `npm run test:live`.
6. Scenario 4's "recipe declares ids" — identity ranges are configured under `entities.<X>.ids`, not in a recipe.
