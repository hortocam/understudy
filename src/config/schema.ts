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
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsDefault from "ajv-formats";
import { configSchema } from "./schema.generated.js";

export { configSchema };

export const CONFIG_SCHEMA_ID = "https://understudy.dev/schemas/config.schema.json";

const addFormats = addFormatsDefault as unknown as (ajv: unknown) => void;

/** The layer-file definitions of the contract (`#/$defs/*`), each compiled once. */
export type LayerDef = "LookupFile" | "EntitiesFile" | "Recipe" | "BehaviorFile" | "ImportMapping";

let layerAjv: Ajv2020 | undefined;
const compiled = new Map<LayerDef, ValidateFunction>();

/** A validator for one layer-file shape, compiled from the SAME contract as the main config. */
export function layerValidator(def: LayerDef): ValidateFunction {
  const cached = compiled.get(def);
  if (cached) return cached;
  if (!layerAjv) {
    layerAjv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(layerAjv);
    layerAjv.addSchema(configSchema, "config");
  }
  const validate = layerAjv.getSchema(`config#/$defs/${def}`);
  if (!validate) throw new Error(`the config contract has no definition ${def}`);
  compiled.set(def, validate);
  return validate;
}
