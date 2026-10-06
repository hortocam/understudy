---
description: "Runnable demo template for a phase or slice (constitution XI)"
---

# Demo: [UNIT NAME] — [phase / slice]

<!--
  ============================================================================
  One file per unit at `specs/<feature>/demo.md`. Constitution principle XI.

  A demo is NOT a QA checklist and NOT a copy of the tests. It is a cycle through
  the real CLI/API that a person runs on their own machine, against a built
  checkout, to see the unit's behaviour and build their own mental model of it.

  Rules (XI):
  - Every command must be verbatim and executable as written.
  - Every step states an OBSERVABLE expected outcome (a status code, a printed
    line, an exit status) — never "it works".
  - Cover EVERY phase of the unit, so a reader can trace each task to something
    they saw happen.
  - Carry a NEGATIVE CONTROL wherever the behaviour is a refusal, a guard or an
    invariant: show the wrong input being rejected. A green run must not be
    mistakable for a mock that fails open.
  - Quote only the COMMITTED surface: fields the API actually serves, messages
    the code actually prints. Check, do not assume.
  - Run it as written before the unit is called done, and paste the real output
    under "Recorded run" (or link the recorded file).
  ============================================================================
-->

Runnable walkthrough of **[unit]**: verbatim commands and their observable results. Run it from a
built checkout; a fresh scratch directory keeps it repeatable. Implementation detail lives in
`tasks.md`; why it is built this way lives in `plan.md`/`research.md`.

## Prerequisites

- Node.js 22+ and a checkout of this repository.
- Built once: `npm ci && npm run build` (the CLI is `node dist/cli/index.js`, aliased `ustdy`).

```bash
# from the repository root
npm ci
npm run build
node dist/cli/index.js --help
```

## Scenario 1 — [short name] ([FR/SC ids], [US])

```bash
# verbatim commands
```

**Expected**: [the observable outcome — a status code, a printed line, an exit status].

**Negative control**: [the wrong input that MUST be rejected, and how the rejection shows].

## Scenario 2 — …

<!-- one scenario per phase of the unit; add as many as the unit needs -->

---

## Recorded run

Executed as written against the merged revision, in a throwaway directory.

- revision: `<sha>` · node: `<version>` · date: `<YYYY-MM-DD>`
- full output: `[path/to/recorded-output.txt]` (if kept)

## What this unit does not yet do

[the honest boundary — what a reader might expect and will not find yet]
