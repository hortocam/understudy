/**
 * Config loading: read `understudy.yaml`, validate it against the contract in
 * `schema.ts`, apply the documented defaults, refuse unknown keys, and refuse the
 * reserved keys when they are selected (FR-021, principle IX).
 *
 * The loader never reaches the network and never touches the store; it only turns
 * a file into a validated, defaulted config object.
 */
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import addFormatsDefault from "ajv-formats";
import { parse as parseYaml } from "yaml";
import { ConfigInvalidError, ConfigUnparseableError, ReservedConfigError } from "../errors.js";
import { configSchema } from "./schema.js";

// ajv-formats ships as CommonJS with `export default formatsPlugin`, but NodeNext
// types the module namespace rather than the callable. The runtime default is the
// plugin, so narrow it explicitly.
const addFormats = addFormatsDefault as unknown as (ajv: unknown) => void;

export type StorageDriver = "sqlite" | "postgres";

export interface ServerConfig {
  port: number;
  host: string;
  basePath: string;
}

export interface ControlConfig {
  prefix: string;
  port?: number;
  host?: string;
}

export interface StorageConfig {
  driver: StorageDriver;
  path: string;
}

export interface IdsConfig {
  generatedStart: number;
}

export interface SigningConfig {
  alg: string;
  header: string;
}

export interface ClockConfig {
  mode: "real" | "virtual";
  start?: string;
}

/** The four layer folders, resolved to absolute paths against the config file's directory (FR-001). */
export interface PathsConfig {
  static: string;
  imports: string;
  dynamic: string;
  behavior: string;
}

export interface InferenceConfig {
  idSuffixes: string[];
  ambiguousNames: string[];
}

export interface RelationConfig {
  to: string;
  onDelete: "restrict" | "cascade" | "setNull";
}

export interface EntityConfig {
  idField?: string;
  writes?: "api" | "actions-only";
  ids?: { generatedStart?: number; reserved?: string };
  relations?: Record<string, RelationConfig>;
}

export interface UnderstudyConfig {
  /** Absolute path or URL of the OpenAPI document. */
  spec: string;
  operations: string[];
  server: ServerConfig;
  control: ControlConfig;
  storage: StorageConfig;
  ids: IdsConfig;
  signing?: SigningConfig;
  clock?: ClockConfig;
  /** The directory the config file lives in; layer paths and plugin files resolve against it. */
  baseDir: string;
  paths: PathsConfig;
  /** The recipe to apply (a file under `paths.dynamic`, without extension); absent means fixtures only. */
  recipe?: string;
  /** The global seed; 0 when absent (D9 — no hidden entropy). */
  seed: number;
  entities: Record<string, EntityConfig>;
  inference: InferenceConfig;
  /** `ustdy up --seed`: overrides the recipe's and the configuration's seed. Not a file key. */
  seedOverride?: number;
}

/** The seed in force: `--seed`, else the recipe's, else the configuration's (default 0). */
export function effectiveSeed(config: Pick<UnderstudyConfig, "seed" | "seedOverride">, recipe?: { seed?: number }): number {
  return config.seedOverride ?? recipe?.seed ?? config.seed;
}

const DEFAULT_SERVER: ServerConfig = { port: 8080, host: "127.0.0.1", basePath: "" };
const DEFAULT_CONTROL: ControlConfig = { prefix: "/__understudy" };
const DEFAULT_STORAGE: StorageConfig = { driver: "sqlite", path: "./.understudy/state.db" };
const DEFAULT_IDS: IdsConfig = { generatedStart: 100000 };
const DEFAULT_PATHS = { static: "./static", imports: "./imports", dynamic: "./dynamic", behavior: "./behavior" };
const DEFAULT_INFERENCE: InferenceConfig = {
  idSuffixes: ["Id", "_id"],
  ambiguousNames: ["externalId", "referenceId", "refId", "parentId"],
};

const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(configSchema);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeError(error: ErrorObject): { value: unknown; detail: string } {
  if (error.keyword === "additionalProperties") {
    const key = (error.params as { additionalProperty?: string }).additionalProperty ?? error.instancePath;
    return { value: key, detail: `unknown key "${key}" is not allowed` };
  }
  if (error.keyword === "required") {
    const key = (error.params as { missingProperty?: string }).missingProperty ?? error.instancePath;
    return { value: key, detail: `missing required key "${key}"` };
  }
  const at = error.instancePath.length > 0 ? ` at ${error.instancePath}` : "";
  return { value: error.instancePath.length > 0 ? error.instancePath : error.keyword, detail: `${error.message ?? "is invalid"}${at}` };
}

/**
 * Fill defaults for ABSENT sections only. A section that is present but the wrong shape is passed
 * through untouched so validation refuses it (FR-005) — defaulting it would hide the mistake.
 */
function withDefaults(value: unknown, defaults: object): unknown {
  if (value === undefined) return { ...defaults };
  return isPlainObject(value) ? { ...defaults, ...value } : value;
}

function applyDefaults(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    ...raw,
    paths: withDefaults(raw.paths, DEFAULT_PATHS),
    inference: withDefaults(raw.inference, DEFAULT_INFERENCE),
    seed: raw.seed === undefined ? 0 : raw.seed,
    entities: raw.entities === undefined ? {} : raw.entities,
    server: withDefaults(raw.server, DEFAULT_SERVER),
    control: withDefaults(raw.control, DEFAULT_CONTROL),
    storage: withDefaults(raw.storage, DEFAULT_STORAGE),
    ids: withDefaults(raw.ids, DEFAULT_IDS),
  };
}

function checkReserved(raw: Record<string, unknown>, config: UnderstudyConfig): void {
  if (Object.prototype.hasOwnProperty.call(raw, "signing")) {
    throw new ReservedConfigError(
      "signing",
      "webhook HMAC signing is a later slice; remove the key or wait for that feature",
    );
  }
  if (config.clock?.mode === "virtual") {
    throw new ReservedConfigError(
      "clock.mode",
      'the virtual clock is a later slice (6); only "real" is implemented — omit the key or use "real"',
    );
  }
  for (const [name, entity] of Object.entries(config.entities)) {
    if (entity.writes === "actions-only") {
      throw new ReservedConfigError(
        `entities.${name}.writes`,
        'refusing API writes is a later slice (5); only "api" is implemented — omit the key or use "api"',
      );
    }
  }
  if (config.storage.driver === "postgres") {
    throw new ReservedConfigError(
      "storage.driver",
      "the postgres adapter is a later slice; only \"sqlite\" is implemented",
    );
  }
}

/** Resolve a relative `spec` path against the config file's directory, not the cwd. */
function resolveSpec(spec: string, configDir: string): string {
  if (URL_LIKE.test(spec) || isAbsolute(spec)) return spec;
  return resolve(configDir, spec);
}

/** Fill the documented `onDelete: restrict` default on every pinned relation. */
function normaliseEntities(entities: Record<string, EntityConfig>): Record<string, EntityConfig> {
  const out: Record<string, EntityConfig> = {};
  for (const [name, entity] of Object.entries(entities)) {
    const relations = entity.relations
      ? Object.fromEntries(
          Object.entries(entity.relations).map(([field, relation]) => [
            field,
            { to: relation.to, onDelete: relation.onDelete ?? "restrict" },
          ]),
        )
      : undefined;
    out[name] = { ...entity, ...(relations ? { relations } : {}) };
  }
  return out;
}

/** Parse config text that came from `source` (a path, used only for messages and resolution). */
export function parseConfig(text: string, source: string): UnderstudyConfig {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new ConfigUnparseableError(source, messageOf(error));
  }
  if (!isPlainObject(raw)) {
    throw new ConfigInvalidError(raw, "the config must be a mapping of keys to values");
  }

  const merged = applyDefaults(raw);
  if (!validate(merged)) {
    const first = validate.errors?.[0];
    if (first) {
      const { value, detail } = describeError(first);
      throw new ConfigInvalidError(value, detail);
    }
    throw new ConfigInvalidError(source, "the config does not match the contract");
  }

  const config = merged as unknown as UnderstudyConfig;
  checkReserved(raw, config);

  const baseDir = dirname(resolve(source));
  const rawPaths = config.paths as unknown as PathsConfig;
  return {
    ...config,
    spec: resolveSpec(config.spec, baseDir),
    baseDir,
    paths: {
      static: resolve(baseDir, rawPaths.static),
      imports: resolve(baseDir, rawPaths.imports),
      dynamic: resolve(baseDir, rawPaths.dynamic),
      behavior: resolve(baseDir, rawPaths.behavior),
    },
    entities: normaliseEntities(config.entities),
  };
}

/** Read and validate a config file. */
export function loadConfig(path: string): UnderstudyConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new ConfigUnparseableError(path, messageOf(error));
  }
  return parseConfig(text, path);
}