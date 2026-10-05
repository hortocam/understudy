/**
 * The generator namespace the configuration is checked against (FR-012): the built-in named
 * generators (plausible values by category — names, codes, amounts, dates, quantities) and the
 * faker method paths a `faker:` rule may use. Kept apart from the registry so the config
 * reconciler can ask "does this name exist?" without importing the generators themselves.
 */
import { Faker, en } from "@faker-js/faker";

/** The built-in named generators, usable in a `generator:` rule exactly like a custom one. */
export const BUILTIN_GENERATOR_NAMES: ReadonlySet<string> = new Set([
  "name",
  "firstName",
  "lastName",
  "email",
  "phone",
  "company",
  "city",
  "address",
  "code",
  "amount",
  "date",
  "pastDate",
  "futureDate",
  "quantity",
  "uuid",
  "word",
  "sentence",
]);

/** Faker helpers that interpret a template string as code/markup: never reachable from config. */
const DENIED = new Set(["helpers.fake", "helpers.mustache"]);

const probe = new Faker({ locale: [en] });

/** True when `path` ('module.method', e.g. 'string.alpha') names a callable faker method. */
export function isFakerPath(path: string): boolean {
  if (DENIED.has(path)) return false;
  const parts = path.split(".");
  if (parts.length !== 2) return false;
  const [moduleName, method] = parts as [string, string];
  if (moduleName.startsWith("_") || method.startsWith("_")) return false;
  const holder = (probe as unknown as Record<string, unknown>)[moduleName];
  if (typeof holder !== "object" || holder === null) return false;
  return typeof (holder as Record<string, unknown>)[method] === "function";
}
