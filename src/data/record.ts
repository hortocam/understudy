/**
 * Generate ONE record: choose a value for every field by the precedence chain, evaluate `expr`
 * fields after the fields they read, enforce the stated invariants by redraw, and gate the result
 * on the document's own schema.
 *
 * Pure with respect to the store: it draws only from the collection's seeded stream (through
 * `env`), so the same stream state always yields the same record. A record that cannot be made to
 * hold its invariants within the redraw budget, or to conform to the specification, is never
 * returned — the run fails loudly naming the rule or the field (FR-013, FR-014).
 */
import { exprDependencies } from "../config/layers/recipes.js";
import { GenerationRefusedError, InvariantViolatedError } from "../errors.js";
import { conformanceErrors } from "../spec/conform.js";
import { propertiesOf } from "../spec/schema-util.js";
import type { Resource } from "../spec/types.js";
import { firstViolated } from "./invariants.js";
import { chooseValue, type DrawEnv, type FieldRule, type Provenance } from "./precedence.js";

export interface CollectionSpec {
  resource: Resource;
  /** The recipe's field rules for this collection. */
  fields?: Record<string, FieldRule>;
  constraints?: string[];
  /** The invariant redraw budget (FR-013); default 50. */
  redraws?: number;
  /** DECIDED links from this collection's fields to parents. */
  links?: Array<{ field: string; to: string; toField: string }>;
}

export interface GeneratedRecord {
  record: Record<string, unknown>;
  /** Which level and rule supplied each field of the record that was kept. */
  provenance: Record<string, Provenance>;
  /** Redraws spent on invariants and on conformance for this record. */
  redraws: number;
}

export const DEFAULT_REDRAWS = 50;
/** Heuristic values can rarely miss a format or a length; a handful of redraws is not a hidden loosening. */
const CONFORMANCE_REDRAWS = 20;

/** Property order, with `expr` fields moved after the fields they read (ties keep property order). */
function fieldOrder(names: string[], fields: Record<string, FieldRule>): string[] {
  const exprs = names.filter((n) => typeof fields[n]?.expr === "string");
  const plain = names.filter((n) => !exprs.includes(n));
  const deps = new Map(exprs.map((n) => [n, exprDependencies(fields[n]?.expr as string).filter((d) => exprs.includes(d) && d !== n)]));
  const placed = new Set<string>();
  const ordered: string[] = [];
  while (ordered.length < exprs.length) {
    const next = exprs.find((n) => !placed.has(n) && (deps.get(n) ?? []).every((d) => placed.has(d)));
    if (!next) break; // a cycle is refused at load; defensive
    placed.add(next);
    ordered.push(next);
  }
  return [...plain, ...ordered];
}

function offendingField(message: string): string {
  const missing = /required property '([^']+)'/.exec(message);
  if (missing) return missing[1] as string;
  const at = /^\/([^/\s]+)/.exec(message);
  return at ? (at[1] as string) : "(record)";
}

export async function generateRecord(
  spec: CollectionSpec,
  env: DrawEnv,
  id: string | number,
  supplied: Record<string, unknown> = {},
): Promise<GeneratedRecord> {
  const { resource } = spec;
  const fields = spec.fields ?? {};
  const properties = propertiesOf(resource);
  const declared = Object.keys(properties).filter((n) => n !== resource.idField);
  const extra = Object.keys(fields).filter((n) => !declared.includes(n) && n !== resource.idField);
  const order = fieldOrder([...declared, ...extra], fields);
  const budget = spec.redraws ?? DEFAULT_REDRAWS;
  const constraints = spec.constraints ?? [];

  let invariantRedraws = 0;
  let conformanceRedraws = 0;
  for (;;) {
    const record: Record<string, unknown> = { [resource.idField]: id };
    const provenance: Record<string, Provenance> = {};
    for (const field of order) {
      const link = spec.links?.find((l) => l.field === field);
      const chosen = await chooseValue(
        {
          collection: resource.name,
          field,
          schema: properties[field] ?? {},
          ...(fields[field] ? { rule: fields[field] as FieldRule } : {}),
          ...(Object.prototype.hasOwnProperty.call(supplied, field) ? { supplied: { value: supplied[field] } } : {}),
          ...(link ? { link: { to: link.to, toField: link.toField } } : {}),
        },
        env,
        record,
      );
      record[field] = chosen.value;
      provenance[field] = chosen.provenance;
    }

    const violated = await firstViolated(constraints, record, env.expr);
    if (violated !== undefined) {
      if (invariantRedraws >= budget) throw new InvariantViolatedError(resource.name, violated, budget);
      invariantRedraws += 1;
      continue;
    }

    const errors = conformanceErrors(resource, record);
    if (errors.length > 0) {
      if (conformanceRedraws >= CONFORMANCE_REDRAWS) {
        const first = errors[0] as string;
        throw new GenerationRefusedError(
          resource.name,
          offendingField(first),
          `cannot produce a value that conforms to the specification (${first}); the constraint is not loosened`,
        );
      }
      conformanceRedraws += 1;
      continue;
    }
    return { record, provenance, redraws: invariantRedraws + conformanceRedraws };
  }
}
