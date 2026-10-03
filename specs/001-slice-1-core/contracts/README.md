# Contracts — slice 1

Three interfaces, one file each:

| File | What it fixes | Enforced by |
|---|---|---|
| `control-api.openapi.yaml` | the control plane's operations, payloads and error semantics | the integration suite drives the running control plane and asserts against this document |
| `config.schema.yaml` | the project configuration file's keys | the config loader validates against it; a key not in it is a startup refusal |
| `cli.md` | the `ustdy` command surface and its mapping onto control operations | a test asserts each CLI command issues exactly one control request and formats its reply without adding logic |

## Why the control API contract is checked in as a document

The control plane serves its own description (FR-018). If that served document were generated from
the code, the contract could never disagree with the implementation — which sounds like a feature
and is not: a consumer reading the description to write a client would be reading a description of
whatever the code happens to do, including a bug. Keeping the contract as a reviewed artifact and
asserting the implementation *against* it is what makes conformance a claim rather than a
tautology. The same argument is why the spec is the source of truth for behaviour (constitution I)
and is not regenerated from the tests.

## Error semantics

Every control operation answers a JSON body. A malformed control request is `400` with a body
naming the offending field. A request under the reserved prefix that is **not** a control operation
is `404` with `unknown control operation` — never routed into the mocked surface (spec edge case).

## The mocked surface's not-implemented answer

Where the control plane's 404 distinguishes "no such control operation", the *mocked* surface's 501
distinguishes "this operation exists in your document but is not enabled in this mock". The two
must never be the same status (FR-003, SC-004) — which is why the mocked surface's
not-implemented answer is **501**, not a 404.

## The CLI's mapping (FR-019)

| Command | Control call | Notes |
|---|---|---|
| `ustdy up [--config] [--port] [--control-port]` | none (starts the mock in-process, then polls `/health`) | the only command that is not purely a client: something has to start the server. It performs no engine work — it constructs the server from the config and hands off |
| `ustdy ops list` | `GET /operations` | formats both sets |
| `ustdy ops enable/disable <op…>` | `PATCH /operations` | **slice 2+**; not in slice 1 |
| `ustdy reset [--to wipe] [--entity <name>]` | `POST /reset` | slice 1 implements `wipe` only |
| `ustdy logs requests [--method] [--status] [--limit]` | `GET /requests` | slice 1's only log type |
| `ustdy down` | `POST /teardown` | reports success once the port is released |

Any command whose behaviour cannot be expressed as "call this control operation, format the
answer" is out of scope for the CLI by definition and belongs in the control API instead.
