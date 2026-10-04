/**
 * The config contract, as a JSON Schema.
 *
 * The single source of truth is `specs/001-slice-1-core/contracts/config.schema.yaml`.
 * Because the published package does not ship the `specs/` tree, the contract is
 * inlined into `schema.generated.ts` by `scripts/generate-config-schema.mjs` and
 * re-exported here. `tests/unit/config.test.ts` asserts the inlined copy still
 * matches the contract byte-for-byte, so the copy cannot drift silently.
 *
 * Decision recorded here (T006): inline by generated copy, not runtime file read —
 * a runtime read would make the loader depend on the source tree layout, which a
 * published `ustdy` binary does not have.
 */
import { configSchema } from "./schema.generated.js";

export { configSchema };

export const CONFIG_SCHEMA_ID = "https://understudy.dev/schemas/config.schema.json";