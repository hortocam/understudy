# Live derivation against the real vendor document — outcome record

> Companion to `research.md` §0 (which is an approved artefact and is not edited). This file is
> where the **measured outcome** of the opt-in run is recorded, as `research.md` §0 and quickstart
> scenario 9 require.

## Status: NOT YET RUN — the egress policy of the environment that built slice 2 denied the host

The run needs the StubHub Point of Sale document, which is **not vendored** (redistribution terms
unsettled — `docs/05-target-apis.md`) and is fetched on demand:

```
https://pointofsaleapi.stubhub.net/swagger/v1/swagger.json   # 910,770 B, sha256 2209392493d38a6f2a401a69537df01795adc32609e272c62ccb0b78e1c0af90
```

When the slice was implemented, the build environment's network policy answered **403 to the
CONNECT** for `pointofsaleapi.stubhub.net:443` (an organisation policy denial, not a transient
failure). It was not retried or worked around. **No number below is therefore a vendor measurement**
— this file records what was and was not established, and how to complete it.

## What *was* established

- The harness exists and works: `tests/live/live-derivation.test.ts`, skipped unless
  `USTDY_LIVE_SPEC` is set, excluded from `npm test` (so CI can never depend on the document), run
  with `npm run test:live`.
- It was exercised against two **local stand-in documents** (not the vendor's) to prove the harness
  itself: tag selection on a document with no `operationId`, and a `METHOD /path` fallback on one
  with none tagged. Both ran to completion and printed the report below.
- The same derivation machinery is exercised by the CI suites on documents *shaped* after the
  measured facts (`externalId` ×N, `eventId`/`viagogoEventId`/`primaryEventId`, mixed identity
  spaces, `paginationToken` + `maxPageSize`), with hand-authored goldens
  (`tests/fixtures/golden/inference-*.json`).

## To complete this record

```bash
USTDY_LIVE_SPEC=https://pointofsaleapi.stubhub.net/swagger/v1/swagger.json \
USTDY_LIVE_REPORT=specs/002-data-layer/live-derivation-run.md \
  npm run test:live
```

The run verifies the downloaded document's sha256 against the value recorded in `docs/05` (and says
so plainly if the vendor has moved it), selects by **tag** (28 tags, `Market Orders` written
`Market_Orders`), and prints: collections derived; links decided by evidence rung; undetermined links
(sibling ties vs. known-ambiguous names); identity spaces by count (compare to 78 / 36 / 30 / 29);
paging styles by count (compare to 21 `paginationToken` / 18 `maxPageSize`); the generation order and
any cycles; and **how many pins the document needs** (an upper bound: one per sibling tie plus one per
known-ambiguous name that is really a link).

An owner with access to the host — or an environment whose network policy allows it — should run the
command above and commit `live-derivation-run.md`.
