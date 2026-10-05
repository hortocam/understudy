/**
 * Shared plumbing for the configuration layers (FR-001): list a layer folder, parse a YAML/JSON
 * file, and validate it against the SAME contract the main config uses, refusing with one
 * message shape — `file: key — cause` — for every layer (FR-005).
 *
 * A missing folder is never an error: each layer is loadable without the others.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { ErrorObject } from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";
import { ConfigLayerInvalidError, ConfigUnparseableError } from "../../errors.js";
import { layerValidator, type LayerDef } from "../schema.js";

export interface LayerFile {
  /** Absolute path. */
  path: string;
  /** Path relative to the config directory, for messages. */
  rel: string;
  /** The file name without its extension (the recipe name, for recipes). */
  stem: string;
}

const LAYER_EXTENSIONS = [".yaml", ".yml", ".json"];

/** The layer files directly inside `dir` (and, when `recursive`, below it), sorted by path. */
export function listLayerFiles(dir: string, baseDir: string, recursive = false, suffix?: string): LayerFile[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const found: LayerFile[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (recursive) walk(full);
        continue;
      }
      const ext = LAYER_EXTENSIONS.find((e) => entry.name.endsWith(suffix ? `${suffix}${e}` : e));
      if (!ext) continue;
      found.push({ path: full, rel: relative(baseDir, full), stem: entry.name.slice(0, -ext.length) });
    }
  };
  walk(dir);
  return found;
}

/** Parse a YAML (or JSON — YAML's subset) layer file. */
export function readLayerFile(file: LayerFile): unknown {
  let text: string;
  try {
    text = readFileSync(file.path, "utf8");
  } catch (error) {
    throw new ConfigUnparseableError(file.rel, error instanceof Error ? error.message : String(error));
  }
  try {
    return parseYaml(text);
  } catch (error) {
    throw new ConfigUnparseableError(file.rel, error instanceof Error ? error.message : String(error));
  }
}

/** `/entities/Inventory/fields/0` -> `entities.Inventory.fields[0]` */
export function keyPath(instancePath: string): string {
  const parts = instancePath.split("/").slice(1).map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  let out = "";
  for (const part of parts) out += /^\d+$/.test(part) ? `[${part}]` : out === "" ? part : `.${part}`;
  return out === "" ? "(document)" : out;
}

function describeFirst(errors: ErrorObject[]): { key: string; detail: string } {
  // A oneOf failure's branch errors are noise; the useful fact is "no single rule kind matched here".
  const oneOf = errors.find((e) => e.keyword === "oneOf");
  if (oneOf) {
    return {
      key: keyPath(oneOf.instancePath),
      detail: "must match exactly one of the allowed forms (check for a missing, duplicated or unknown rule kind)",
    };
  }
  const first = errors[0];
  if (!first) return { key: "(document)", detail: "does not match the contract" };
  if (first.keyword === "additionalProperties") {
    const extra = (first.params as { additionalProperty?: string }).additionalProperty ?? "?";
    const base = keyPath(first.instancePath);
    return { key: base === "(document)" ? extra : `${base}.${extra}`, detail: `unknown key "${extra}" is not allowed` };
  }
  if (first.keyword === "required") {
    const missing = (first.params as { missingProperty?: string }).missingProperty ?? "?";
    const base = keyPath(first.instancePath);
    return { key: base === "(document)" ? missing : `${base}.${missing}`, detail: `missing required key "${missing}"` };
  }
  return { key: keyPath(first.instancePath), detail: first.message ?? "is invalid" };
}

/** Validate a parsed layer file against its contract definition, or refuse naming file and key. */
export function validateLayerFile(def: LayerDef, layer: string, file: LayerFile, value: unknown): void {
  const validate = layerValidator(def);
  if (validate(value)) return;
  const { key, detail } = describeFirst(validate.errors ?? []);
  throw new ConfigLayerInvalidError(layer, file.rel, key, detail);
}
