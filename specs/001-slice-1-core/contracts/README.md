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

Every control operation answers a JSON body. A malformed control request is `400` with a
`ControlError` body naming the offending field. A request under the reserved prefix that is **not**
a control operation is `404` with `error: unknown_control_operation` — never routed into the
mocked surface. Both are declared in `control-api.openapi.yaml`, so a consumer generating a client
from the served document knows they exist.

## Reserved keys in the config schema

`signing`, `clock` and `storage.driver: postgres` are present in `config.schema.yaml` and
explicitly documented there as **reserved** — accepted so the config's shape is stable before the
features land (constitution IX and X). Selecting an unimplemented value is a startup refusal with
a message naming it, not a silent no-op: a config key that quietly does nothing is worse than one
that does not exist.
