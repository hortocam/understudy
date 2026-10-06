/**
 * The six-level value-precedence chain (FR-010) and the provenance of every value.
 *
 *   1. an explicit rule in the generation configuration (whatever its kind — `rule` records which)
 *   2. a supplied value (the seam imports and actions use; per-parent generation supplies the link)
 *   3. a reference — an existing record of the parent a DECIDED link points at
 *   4. the specification's own constraints and declared values: const, enum, examples, default
 *   5. a plausible-value heuristic from the field's declared format, pattern, name and type
 *   6. the type's default value
 *
 * ONE function decides which source applies (`resolveSource`); `planField` (the report's "which
 * level will supply this field") and `chooseValue` (the draw) both run it, so the plan can never
 * disagree with the data (research §5: no second implementation of the chain). Every value comes
 * back with its provenance so a golden file can assert it and the report can state it (VI).
 *
 * Level 4 inner order is const, enum, examples, default: a declared fixed set varies, a lone
 * default does not. An enum NEVER falls through to the heuristic (FR-014).
 */
import { GenerationRefusedError } from "../errors.js";
import type { Schema } from "../spec/schema-util.js";
import type { FixtureRows } from "./fixtures.js";
import { drawChoice } from "./generators/choice.js";
import type { ExprEvaluator } from "./generators/expr.js";
import { runFaker } from "./generators/faker.js";
import { drawLookup, type LookupRule } from "./generators/lookup.js";
import { drawReference } from "./generators/reference.js";
import type { GeneratorRegistry } from "./generators/registry.js";
import type { GenContext, ReferencePool, SequenceLike } from "./generators/types.js";
import type { Stream } from "./seed.js";

export type Level = 1 | 2 | 3 | 4 | 5 | 6;
export interface Provenance {
  level: Level;
  rule: string;
}
/** A value chosen by a heuristic or a type default is a fallback: the report says so (US7.4). */
export const isFallback = (p: Provenance): boolean => p.level >= 5;

export type FieldRule = Record<string, unknown>;

export interface FieldInput {
  collection: string;
  field: string;
  /** The property's own schema in the document. */
  schema: Schema;
  rule?: FieldRule;
  supplied?: { value: unknown };
  /** A DECIDED link from this field to a parent collection's `toField`. */
  link?: { to: string; toField: string };
}

export interface DrawEnv {
  stream: Stream;
  instant: Date;
  registry: GeneratorRegistry;
  sequences: SequenceLike;
  lookups: Map<string, FixtureRows>;
  refs: ReferencePool;
  expr: ExprEvaluator;
}

type Source =
  | { kind: "rule"; rule: FieldRule }
  | { kind: "supplied"; value: unknown }
  | { kind: "reference"; to: string; toField: string }
  | { kind: "const"; value: unknown }
  | { kind: "enum"; values: unknown[] }
  | { kind: "example"; values: unknown[] }
  | { kind: "default"; value: unknown }
  | { kind: "heuristic" }
  | { kind: "type-default" };

const RULE_KINDS = ["generator", "faker", "lookup", "ref", "seq", "choice", "expr"] as const;

function ruleLabel(rule: FieldRule): string {
  for (const kind of RULE_KINDS) {
    const value = rule[kind];
    if (value === undefined) continue;
    // The expression text / choice set is not a name; the others name what they used.
    return typeof value === "string" && kind !== "expr" ? `${kind}:${value}` : kind;
  }
  return "rule";
}

const DAY_MS = 24 * 3600 * 1000;
const MAX_DEPTH = 4;

// --------------------------------------------------------------------------------------------
// Schema reading
// --------------------------------------------------------------------------------------------

const isSchema = (v: unknown): v is Schema => typeof v === "object" && v !== null && !Array.isArray(v);

/** allOf is merged; oneOf/anyOf take their first branch (deterministic). */
function normalise(schema: Schema): Schema {
  let out: Schema = { ...schema };
  if (Array.isArray(schema.allOf)) {
    for (const part of schema.allOf) {
      if (!isSchema(part)) continue;
      const merged = normalise(part);
      out = {
        ...out,
        ...merged,
        properties: { ...(isSchema(out.properties) ? out.properties : {}), ...(isSchema(merged.properties) ? merged.properties : {}) },
        required: [...new Set([...(Array.isArray(out.required) ? out.required : []), ...(Array.isArray(merged.required) ? merged.required : [])])],
      };
    }
    delete out.allOf;
  }
  for (const key of ["oneOf", "anyOf"] as const) {
    const branches = schema[key];
    if (Array.isArray(branches) && isSchema(branches[0])) {
      const { [key]: _drop, ...rest } = out;
      void _drop;
      out = { ...normalise(branches[0]), ...rest };
    }
  }
  return out;
}

function typeOf(schema: Schema): string | undefined {
  const t = schema.type;
  if (typeof t === "string") return t;
  if (Array.isArray(t)) return t.find((x): x is string => typeof x === "string" && x !== "null");
  if (isSchema(schema.properties)) return "object";
  if (isSchema(schema.items)) return "array";
  return undefined;
}

// --------------------------------------------------------------------------------------------
// Name hints (precedence level 5)
// --------------------------------------------------------------------------------------------

const STRING_HINTS: Array<[RegExp, string]> = [
  [/e-?mail/i, "email"],
  [/phone|mobile|^tel$/i, "phone"],
  [/first.?name|given.?name|forename/i, "firstName"],
  [/last.?name|family.?name|surname/i, "lastName"],
  [/company|organi[sz]ation|employer/i, "company"],
  [/^city$|town/i, "city"],
  [/^state$|province|region/i, "state"],
  [/country/i, "country"],
  [/zip|postal/i, "zip"],
  [/address|street/i, "address"],
  [/time.?zone|^tz$/i, "timezone"],
  [/currency/i, "currency"],
  [/url|website|link/i, "url"],
  [/(at|date|time|timestamp)$/i, "timestamp"],
  [/desc|summary|note|comment|text|body|message/i, "text"],
  [/title|heading|label/i, "title"],
  [/code|sku|ref$|reference/i, "code"],
  [/name$/i, "name"],
];

const NUMBER_HINTS: Array<[RegExp, string, number, number, boolean]> = [
  [/quantity|qty|count|seats|size$/i, "quantity", 1, 10, false],
  [/^age$/i, "age", 18, 90, false],
  [/year/i, "year", 2000, 2030, false],
  [/price|amount|cost|total|fee|rate|balance|tax/i, "money", 1, 1000, true],
];

function stringHint(field: string): string | undefined {
  return STRING_HINTS.find(([re]) => re.test(field))?.[1];
}
function numberHint(field: string): { name: string; lo: number; hi: number; money: boolean } | undefined {
  const hit = NUMBER_HINTS.find(([re]) => re.test(field));
  return hit ? { name: hit[1], lo: hit[2], hi: hit[3], money: hit[4] } : undefined;
}

const KNOWN_FORMATS = new Set(["date-time", "date", "time", "uuid", "email", "uri", "url", "hostname", "ipv4", "ipv6", "byte", "password"]);

function heuristicLabel(schema: Schema, field: string): string {
  const type = typeOf(schema);
  if (type === "string") {
    if (typeof schema.format === "string" && KNOWN_FORMATS.has(schema.format)) return `heuristic:format=${schema.format}`;
    if (typeof schema.pattern === "string") return "heuristic:pattern";
    const hint = stringHint(field);
    return hint ? `heuristic:name=${hint}` : "heuristic:type=string";
  }
  if (type === "integer" || type === "number") {
    const hint = numberHint(field);
    return hint ? `heuristic:name=${hint.name}` : `heuristic:type=${type}`;
  }
  return `heuristic:type=${type ?? "unknown"}`;
}

// --------------------------------------------------------------------------------------------
// The decision
// --------------------------------------------------------------------------------------------

function resolveSource(input: FieldInput): Source {
  if (input.rule) return { kind: "rule", rule: input.rule };
  if (input.supplied) return { kind: "supplied", value: input.supplied.value };
  if (input.link) return { kind: "reference", to: input.link.to, toField: input.link.toField };
  const schema = normalise(input.schema);
  if ("const" in schema) return { kind: "const", value: schema.const };
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return { kind: "enum", values: schema.enum };
  if (Array.isArray(schema.examples) && schema.examples.length > 0) return { kind: "example", values: schema.examples };
  if ("example" in schema) return { kind: "example", values: [schema.example] };
  if ("default" in schema) return { kind: "default", value: schema.default };
  const type = typeOf(schema);
  if (type === "object" && !isSchema(schema.properties)) return { kind: "type-default" };
  if (type === "array" && !isSchema(schema.items)) return { kind: "type-default" };
  if (type === undefined || !["string", "integer", "number", "boolean", "array", "object"].includes(type)) return { kind: "type-default" };
  return { kind: "heuristic" };
}

function describe(source: Source, input: FieldInput): Provenance {
  switch (source.kind) {
    case "rule":
      return { level: 1, rule: ruleLabel(source.rule) };
    case "supplied":
      return { level: 2, rule: "supplied" };
    case "reference":
      return { level: 3, rule: `reference:${source.to}` };
    case "const":
      return { level: 4, rule: "const" };
    case "enum":
      return { level: 4, rule: "enum" };
    case "example":
      return { level: 4, rule: "example" };
    case "default":
      return { level: 4, rule: "default" };
    case "heuristic":
      return { level: 5, rule: heuristicLabel(normalise(input.schema), input.field) };
    case "type-default":
      return { level: 6, rule: "type-default" };
  }
}

/** The level and rule that WILL supply this field (the report's static view; same decision as the draw). */
export function planField(input: FieldInput): Provenance {
  return describe(resolveSource(input), input);
}

// --------------------------------------------------------------------------------------------
// Drawing
// --------------------------------------------------------------------------------------------

function genContext(input: FieldInput, env: DrawEnv, record: Record<string, unknown>): GenContext {
  return {
    collection: input.collection,
    field: input.field,
    schema: input.schema,
    record,
    rng: env.stream.rng,
    faker: env.stream.faker,
    instant: env.instant,
    sequences: env.sequences,
  };
}

/** A rule's raw value, coerced to the type the document declares for the field. */
function coerce(schema: Schema, value: unknown): unknown {
  const type = typeOf(normalise(schema));
  if ((type === "integer" || type === "number") && typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) {
    return Number(value);
  }
  if (type === "string" && (typeof value === "number" || typeof value === "boolean")) return String(value);
  if (type === "boolean" && (value === "true" || value === "false")) return value === "true";
  return value;
}

async function drawRule(rule: FieldRule, input: FieldInput, env: DrawEnv, record: Record<string, unknown>): Promise<unknown> {
  const { rng } = env.stream;
  const fail = (detail: string): never => {
    throw new GenerationRefusedError(input.collection, input.field, detail);
  };
  if (typeof rule.generator === "string") return env.registry.run(rule.generator, genContext(input, env, record));
  if (typeof rule.faker === "string") return runFaker(env.stream.faker, rule.faker, rule);
  if (typeof rule.lookup === "string") {
    const table = env.lookups.get(rule.lookup);
    if (!table) return fail(`no lookup table named ${rule.lookup}`);
    return drawLookup(table, rule as unknown as LookupRule, rng);
  }
  if (typeof rule.ref === "string") return drawReference(env.refs, rule.ref, rng);
  if (typeof rule.seq === "string") {
    return env.sequences.next(input.collection, rule.seq, rule.start as number | undefined, rule.step as number | undefined);
  }
  if (Array.isArray(rule.choice)) {
    return drawChoice(rule.choice, Array.isArray(rule.weights) ? (rule.weights as number[]) : undefined, rng);
  }
  if (typeof rule.expr === "string") {
    try {
      return await env.expr.evaluate(rule.expr, record);
    } catch (error) {
      return fail(`the expression "${rule.expr}" failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return fail("the field rule names no known rule kind");
}

function decimals(step: number): number {
  const text = String(step);
  const dot = text.indexOf(".");
  return dot === -1 ? 0 : text.length - dot - 1;
}

function drawInteger(schema: Schema, field: string, env: DrawEnv): number {
  const { rng } = env.stream;
  const hint = numberHint(field);
  const hintLo = hint?.lo ?? 0;
  const hintHi = hint?.hi ?? 1000;
  const min = typeof schema.minimum === "number" ? schema.minimum : typeof schema.exclusiveMinimum === "number" ? schema.exclusiveMinimum + 1 : undefined;
  const max = typeof schema.maximum === "number" ? schema.maximum : typeof schema.exclusiveMaximum === "number" ? schema.exclusiveMaximum - 1 : undefined;
  let lo = min ?? (max !== undefined ? Math.min(hintLo, max) : hintLo);
  let hi = max ?? (min !== undefined ? Math.max(hintHi, min + (hintHi - hintLo)) : hintHi);
  lo = Math.ceil(lo);
  hi = Math.floor(hi);
  const step = typeof schema.multipleOf === "number" && schema.multipleOf > 0 ? schema.multipleOf : undefined;
  if (step) return rng.int(Math.ceil(lo / step), Math.floor(hi / step)) * step;
  return rng.int(lo, hi);
}

function drawNumber(schema: Schema, field: string, env: DrawEnv): number {
  const { rng } = env.stream;
  const hint = numberHint(field);
  const hintLo = hint?.lo ?? 0;
  const hintHi = hint?.hi ?? 1000;
  const min = typeof schema.minimum === "number" ? schema.minimum : undefined;
  const max = typeof schema.maximum === "number" ? schema.maximum : undefined;
  const lo = min ?? (max !== undefined ? Math.min(hintLo, max) : hintLo);
  const hi = max ?? (min !== undefined ? Math.max(hintHi, min + (hintHi - hintLo)) : hintHi);
  const step = typeof schema.multipleOf === "number" && schema.multipleOf > 0 ? schema.multipleOf : undefined;
  if (step) {
    const k = rng.int(Math.ceil(lo / step), Math.floor(hi / step));
    return Number((k * step).toFixed(decimals(step)));
  }
  const value = Number(rng.float(lo, hi).toFixed(2));
  return Math.min(hi, Math.max(lo, value));
}

/** Normalise a declared pattern for the regex generator: strip anchors, spell shorthand classes out. */
function patternSource(pattern: string): string {
  return pattern
    .replace(/^\^/, "")
    .replace(/\$$/, "")
    .replace(/\\d/g, "[0-9]")
    .replace(/\\w/g, "[A-Za-z0-9_]");
}

function drawString(schema: Schema, field: string, env: DrawEnv): string {
  const { faker, rng } = env.stream;
  const format = typeof schema.format === "string" ? schema.format : undefined;
  let value: string;
  if (format === "date-time") {
    value = faker.date.between({ from: new Date(env.instant.getTime() - 365 * DAY_MS), to: new Date(env.instant.getTime() + 365 * DAY_MS) }).toISOString();
  } else if (format === "date") {
    value = faker.date.between({ from: new Date(env.instant.getTime() - 365 * DAY_MS), to: new Date(env.instant.getTime() + 365 * DAY_MS) }).toISOString().slice(0, 10);
  } else if (format === "time") {
    const two = (n: number): string => String(n).padStart(2, "0");
    value = `${two(rng.int(0, 23))}:${two(rng.int(0, 59))}:${two(rng.int(0, 59))}Z`; // RFC 3339 full-time
  } else if (format === "uuid") {
    value = faker.string.uuid();
  } else if (format === "email") {
    value = faker.internet.email();
  } else if (format === "uri" || format === "url") {
    value = faker.internet.url();
  } else if (format === "hostname") {
    value = faker.internet.domainName();
  } else if (format === "ipv4") {
    value = faker.internet.ipv4();
  } else if (format === "ipv6") {
    value = faker.internet.ipv6();
  } else if (format === "byte") {
    value = Buffer.from(faker.string.alphanumeric({ length: 9 })).toString("base64");
  } else if (format === "password") {
    value = faker.internet.password();
  } else if (typeof schema.pattern === "string") {
    const source = patternSource(schema.pattern);
    try {
      value = faker.helpers.fromRegExp(source);
    } catch {
      throw new Error(`the pattern ${schema.pattern} is outside what the generator can satisfy`);
    }
    if (!new RegExp(schema.pattern).test(value)) {
      throw new Error(`the pattern ${schema.pattern} is outside what the generator can satisfy`);
    }
    return value;
  } else {
    switch (stringHint(field)) {
      case "email":
        value = faker.internet.email();
        break;
      case "phone":
        value = faker.phone.number();
        break;
      case "firstName":
        value = faker.person.firstName();
        break;
      case "lastName":
        value = faker.person.lastName();
        break;
      case "company":
        value = faker.company.name();
        break;
      case "city":
        value = faker.location.city();
        break;
      case "state":
        value = faker.location.state({ abbreviated: true });
        break;
      case "country":
        value = faker.location.country();
        break;
      case "zip":
        value = faker.location.zipCode();
        break;
      case "address":
        value = faker.location.streetAddress();
        break;
      case "timezone":
        value = faker.location.timeZone();
        break;
      case "currency":
        value = faker.finance.currencyCode();
        break;
      case "url":
        value = faker.internet.url();
        break;
      case "timestamp":
        value = faker.date.between({ from: new Date(env.instant.getTime() - 365 * DAY_MS), to: new Date(env.instant.getTime() + 365 * DAY_MS) }).toISOString();
        break;
      case "text":
        value = faker.lorem.sentence();
        break;
      case "title":
        value = faker.lorem.words(3);
        break;
      case "code":
        value = faker.string.alphanumeric({ length: 6, casing: "upper" });
        break;
      case "name":
        value = /customer|user|person|contact|buyer|seller|owner/i.test(field) ? faker.person.fullName() : faker.company.name();
        break;
      default:
        value = faker.lorem.word();
    }
  }
  return fitLength(value, schema, env);
}

/**
 * Honour minLength/maxLength without ever loosening them. A format that truncation would break
 * (an email, a URL, a hostname) is regenerated compactly instead; one that cannot fit is left to
 * the conformance gate to refuse by name.
 */
function fitLength(value: string, schema: Schema, env: DrawEnv): string {
  let out = value;
  const max = typeof schema.maxLength === "number" ? schema.maxLength : undefined;
  if (max !== undefined && out.length > max) {
    const word = (n: number): string => env.stream.faker.string.alpha({ length: Math.max(1, n), casing: "lower" });
    if (schema.format === "email" && max >= 7) out = `${word(max - 6)}@${word(2)}.io`;
    else if ((schema.format === "uri" || schema.format === "url") && max >= 12) out = `http://${word(max - 10)}.io`;
    else if (schema.format === "hostname" && max >= 5) out = `${word(max - 3)}.io`;
  }
  if (typeof schema.maxLength === "number" && out.length > schema.maxLength) out = out.slice(0, Math.max(0, schema.maxLength));
  if (typeof schema.minLength === "number" && out.length < schema.minLength) {
    out += env.stream.faker.string.alphanumeric({ length: schema.minLength - out.length });
  }
  return out;
}

/** A value from the schema alone: the level-4 declared values, else the heuristic (nested use). */
function fromSchema(rawSchema: Schema, field: string, env: DrawEnv, depth: number): unknown {
  const schema = normalise(rawSchema);
  const { rng } = env.stream;
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return rng.pick(schema.enum);
  const type = typeOf(schema);
  switch (type) {
    case "string":
      return drawString(schema, field, env);
    case "integer":
      return drawInteger(schema, field, env);
    case "number":
      return drawNumber(schema, field, env);
    case "boolean":
      return rng.bool();
    case "array": {
      if (!isSchema(schema.items) || depth >= MAX_DEPTH) return [];
      const min = typeof schema.minItems === "number" ? schema.minItems : 1;
      const max = typeof schema.maxItems === "number" ? schema.maxItems : Math.max(min, 3);
      const count = rng.int(min, max);
      return Array.from({ length: count }, () => fromSchema(schema.items as Schema, field, env, depth + 1));
    }
    case "object": {
      if (!isSchema(schema.properties) || depth >= MAX_DEPTH) return {};
      const out: Record<string, unknown> = {};
      for (const [name, prop] of Object.entries(schema.properties)) {
        if (!isSchema(prop) || prop.writeOnly === true) continue;
        out[name] = fromSchema(prop, name, env, depth + 1);
      }
      return out;
    }
    default:
      return null;
  }
}

function typeDefault(schema: Schema): unknown {
  switch (typeOf(normalise(schema))) {
    case "object":
      return {};
    case "array":
      return [];
    case "string":
      return "";
    case "integer":
    case "number":
      return 0;
    case "boolean":
      return false;
    default:
      return null;
  }
}

/** Choose a value for one field and say which rule produced it. */
export async function chooseValue(
  input: FieldInput,
  env: DrawEnv,
  record: Record<string, unknown>,
): Promise<{ value: unknown; provenance: Provenance }> {
  const source = resolveSource(input);
  const provenance = describe(source, input);
  const { rng } = env.stream;
  let value: unknown;
  switch (source.kind) {
    case "rule":
      value = coerce(input.schema, await drawRule(source.rule, input, env, record));
      break;
    case "supplied":
      value = source.value;
      break;
    case "reference":
      value = drawReference(env.refs, `${source.to}.${source.toField}`, rng);
      break;
    case "const":
      value = source.value;
      break;
    case "enum":
    case "example":
      value = rng.pick(source.values);
      break;
    case "default":
      value = source.value;
      break;
    case "heuristic":
      try {
        value = fromSchema(input.schema, input.field, env, 0);
      } catch (error) {
        throw new GenerationRefusedError(input.collection, input.field, error instanceof Error ? error.message : String(error));
      }
      break;
    case "type-default":
      value = typeDefault(input.schema);
      break;
  }
  return { value, provenance };
}
