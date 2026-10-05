# Contract: the `ustdy` command line — slice 2 extension

This file **extends** [`specs/001-slice-1-core/contracts/cli.md`](../../001-slice-1-core/contracts/cli.md)
(never forks it; slice 1's file stays in place as history). Everything in slice 1's contract still
holds, including the rule that makes the CLI a client of the control API (constitution II, FR-019) and
the connection behaviour: **with the control plane unreachable, every client command exits non-zero
with a clear connection error and does no work locally.**

This is the contract `tests/integration/cli-generate.test.ts` and `tests/integration/init.test.ts`
assert against. Every flag below ships with a runnable example (constitution IX).

## New commands

| Command | Control call | Renders | Notes |
|---|---|---|---|
| `ustdy generate [--recipe <name>] [--seed <n>] [--control-url <url>]` | `POST /generate` | what was created, **by collection and origin**, and the clock mode in force | A **client**, like every command except `up` and `init` (FR-021). `--recipe` names a file under `paths.dynamic` (omit it to use the mock's configured recipe). `--seed` overrides the recipe's and the configuration's seed for this run. Applied to a store that already holds the same recipe + seed + configuration it is a **no-op that says so**; a different recipe, seed or configuration is refused naming the mismatch and `ustdy reset --to wipe` (decision D7). |
| `ustdy init --spec <path-or-url> [--dir <path>] [--force]` | *(none — a local act)* | the **inferred collection report**, then the files written | The one command besides `up` that is not a client: it scaffolds files. It contains **no generation logic** — it runs the derivation the server runs and renders the same report (FR-020). Writes `understudy.yaml` (every optional key shown commented, with its meaning), the layer folders `static/{lookups,entities}`, `imports`, `dynamic`, `behavior`, a runnable `dynamic/starter.yaml` generated from the links the tool inferred, and `*.example` files for each layer (not loaded until renamed). Operations are selected by **tag** when every operation is tagged and the tags do not collapse ambiguously, else by `METHOD /path`. Refuses to overwrite existing files (naming them) unless `--force`. A URL `--spec` is the only network call it makes. |

## Changed command

| Command | Change |
|---|---|
| `ustdy up … [--recipe <name>] [--seed <n>]` | `--recipe` selects the recipe applied at start (overrides the config's `recipe`); `--seed` overrides the recipe's **and** the configuration's seed (precedence: `--seed`, then the recipe's `seed`, then the configuration's `seed`, default `0`). Generation at start runs through the same engine as `POST /generate`. A recipe that does not exist, an invalid configuration layer, or a generation that cannot succeed refuses to start naming the cause. |

## Examples

```bash
# scaffold from a specification, read the report, then start with the generated starter recipe
ustdy init --spec ./specs/pos-api.yaml --dir ./pos-mock
cd pos-mock && ustdy up --recipe starter --seed 42 &

# apply a different recipe to the running mock and see what it created, by collection and origin
ustdy reset --to wipe
ustdy generate --recipe ci-small --seed 7

# idempotent: running the same generate again says "already applied" and changes nothing
ustdy generate --recipe ci-small --seed 7
```

## Deliberately not in this slice

`import`, `export`, `snapshot` (slice 3), `webhooks …` (slice 4), `action run`, `sim …` (slice 5).
`ustdy reset --to baseline` named in the quickstart does not exist: slice 1's only reset mode is `wipe`.
