/**
 * Apply the fixtures layer to the store (FR-001, FR-002, principle IV).
 *
 * This is the ONLY code path that writes `origin = 'static'` rows. It makes the store's static
 * rows equal the files, in one transaction: new rows are inserted, a row whose body differs is
 * updated, a row whose body is unchanged is left byte-for-byte alone (so a restart keeps its
 * timestamps), and a static row the files no longer declare is removed. Generation, import and
 * API activity never call it and never write `static`.
 *
 * A fixture never silently overwrites a record of another origin: that is a refusal naming the
 * collection, because the reviewed artefact and the running state would disagree.
 */
import type { FixtureSet, FixtureTable } from "../config/layers/fixtures.js";
import { FixtureConformanceError, IdentityRangeOverlapError } from "../errors.js";
import type { Store } from "../store/index.js";
import type { Resource } from "../spec/types.js";
import type { PlanLink } from "./plan.js";

export interface FixtureRows {
  idField: string;
  rows: Array<{ row: Record<string, unknown>; file: string }>;
}

export interface FixtureSummary {
  inserted: number;
  updated: number;
  removed: number;
  unchanged: number;
  /** Lookup tables that name no collection: held in memory, never stored (D10). */
  lookupOnly: string[];
  /** Every fixture table by entity (stored or lookup-only), for `lookup:` rules. */
  tables: Map<string, FixtureRows>;
}

export interface ApplyFixturesInput {
  store: Store;
  fixtures: FixtureSet;
  resources: Resource[];
  /** Collections parents-first (the plan's order). */
  order: string[];
  links: Record<string, PlanLink[]>;
  /** The clock seam's instant for this run (ISO). */
  instant: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function groupByEntity(tables: FixtureTable[], resources: Map<string, Resource>, into: Map<string, FixtureRows>): void {
  for (const table of tables) {
    const idField = table.idField ?? resources.get(table.entity)?.idField ?? "id";
    const group = into.get(table.entity) ?? { idField, rows: [] };
    for (const row of table.rows) group.rows.push({ row, file: table.file });
    into.set(table.entity, group);
  }
}

export function applyFixtures(input: ApplyFixturesInput): FixtureSummary {
  const { store } = input;
  const resources = new Map(input.resources.map((r) => [r.name, r]));
  const tables = new Map<string, FixtureRows>();
  groupByEntity([...input.fixtures.lookups, ...input.fixtures.entities], resources, tables);

  const lookupOnly = [...tables.keys()].filter((entity) => !resources.has(entity)).sort();
  const summary: FixtureSummary = { inserted: 0, updated: 0, removed: 0, unchanged: 0, lookupOnly, tables };

  const declared = new Map<string, Set<string>>();
  for (const [entity, group] of tables) declared.set(entity, new Set(group.rows.map(({ row }) => String(row[group.idField]))));

  // A link must resolve before anything is written, so the refusal can name the row.
  for (const entity of input.order) {
    const group = tables.get(entity);
    if (!group || !resources.has(entity)) continue;
    for (const link of input.links[entity] ?? []) {
      group.rows.forEach(({ row, file }, index) => {
        const value = row[link.field];
        if (value === undefined || value === null) return;
        const id = String(value);
        const known = declared.get(link.to)?.has(id) === true || store.readOne(link.to, id) !== undefined;
        if (!known) {
          throw new FixtureConformanceError(
            file,
            entity,
            String(row[group.idField]),
            `rows[${index}].${link.field}`,
            `references ${link.to} ${id}, which no fixture declares and the store does not hold`,
          );
        }
      });
    }
  }

  store.transaction(() => {
    for (const entity of input.order) {
      const resource = resources.get(entity);
      if (!resource) continue;
      const group = tables.get(entity);
      const wanted = declared.get(entity) ?? new Set<string>();

      for (const { row } of group?.rows ?? []) {
        const identity = String(row[group?.idField ?? resource.idField]);
        const existing = store.readOne(entity, identity);
        if (!existing) {
          store.insertMany([{ resource: entity, identity, data: row, origin: "static", createdAt: input.instant, updatedAt: input.instant }]);
          summary.inserted += 1;
        } else if (existing.origin !== "static") {
          throw new IdentityRangeOverlapError(
            entity,
            `fixture identity ${identity} is already held by a ${existing.origin} record; reset the mock (ustdy reset --to wipe) or change the fixture`,
          );
        } else if (canonical(existing.data) !== canonical(row)) {
          store.update(entity, identity, row, input.instant);
          summary.updated += 1;
        } else {
          summary.unchanged += 1;
        }
      }

      // A static row the files no longer declare goes away: the store follows the reviewed files.
      for (const record of store.list(entity)) {
        if (record.origin === "static" && !wanted.has(record.identity)) {
          store.delete(entity, record.identity);
          summary.removed += 1;
        }
      }
    }
  });
  return summary;
}
