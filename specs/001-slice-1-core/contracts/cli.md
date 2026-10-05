# Contract: the `ustdy` command line

The CLI is a **client of the control API** (constitution II, FR-019). Every command below is
"issue one control request, render the answer". A command whose behaviour cannot be expressed that
way does not belong in the CLI — it belongs in the control API, where the library and the API
consumer get it too.

This is the contract `tests/integration/cli.test.ts` asserts against.

| Command | Control call | Renders | Notes |
|---|---|---|---|
| `ustdy up [--config <path>] [--port <n>] [--control-port <n>] [--control-url <url>] [--operation <entry>]…` | `GET /health` (polled until ready) | the startup report, then a ready line | **The one command that is not purely a client.** Something has to construct and start the server; `up` builds it from the config and then polls `/health`. It performs no engine work of its own. The operation selection may be given at start **as arguments or environment** (FR-020): repeat `--operation` with the same `METHOD /path` / `operationId` entries the config's `operations` accepts, or set `USTDY_OPERATIONS` (comma- or newline-separated). An explicit selection overrides the config file's `operations`; when neither is given, the config file's selection is used. |
| `ustdy down [--control-url <url>]` | `POST /teardown` | success once the port is released | must not exit 0 before the port is actually free |
| `ustdy ops list` | `GET /operations` | live and not-implemented operations | |
| `ustdy reset [--to <mode>] [--entity <name>]…` | `POST /reset` | rows removed per entity | slice 1 implements `--to wipe` only; any other mode is refused by the control plane |
| `ustdy logs requests [--method] [--status] [--live] [--limit <n>]` | `GET /requests` | the request log, newest first | slice 1's only log type |

Deliberately **not** in slice 1 (each arrives with its control counterpart): `ops enable/disable`,
`generate`, `import`, `export`, `snapshot`, `action run`, `webhooks …`, `sim …`, `init`.

## Connection behaviour

`--control-url` defaults to `http://<control.host>:<control.port|server.port><control.prefix>`,
or the environment equivalent. It may also be given as an explicit URL.

**With the control plane unreachable, every command MUST fail with a non-zero exit and a clear
connection error.** It must not fall back to reading the store or performing the work locally.
That fallback is precisely what would make the CLI a second implementation, and it is what the
integration test checks by stopping the control plane first.
