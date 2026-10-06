/**
 * The fixtures layer (FR-001, FR-002): `static/lookups/*.yaml` and `static/entities/*.yaml`.
 *
 * Fixtures are versioned and applied identically every run. This module only *reads and
 * validates* them into a stable, ordered set — it never touches the store or the document; the
 * one code path that writes `static` rows is `src/data/fixtures.ts`.
 *
 * Order is deterministic: files by name, rows by file order.
 */
import { join } from "node:path";
import { ConfigLayerInvalidError } from "../../errors.js";
import { listLayerFiles, readLayerFile, validateLayerFile, type LayerFile } from "./files.js";

export interface FixtureTable {
  /** Config-directory-relative file the rows came from, for messages. */
  file: string;
  entity: string;
  /** As written in the file; the effective identity field is `idField ?? "id"` until reconcile resolves it. */
  idField?: string;
  rows: Array<Record<string, unknown>>;
}

export interface FixtureSet {
  lookups: FixtureTable[];
  entities: FixtureTable[];
}

function loadDir(dir: string, baseDir: string, def: "LookupFile" | "EntitiesFile", layer: string): FixtureTable[] {
  const tables: FixtureTable[] = [];
  for (const file of listLayerFiles(dir, baseDir)) {
    const value = readLayerFile(file);
    validateLayerFile(def, layer, file, value);
    tables.push(toTable(file, value as Record<string, unknown>));
  }
  return tables;
}

function toTable(file: LayerFile, value: Record<string, unknown>): FixtureTable {
  const table: FixtureTable = {
    file: file.rel,
    entity: value.entity as string,
    rows: value.rows as Array<Record<string, unknown>>,
  };
  if (typeof value.idField === "string") table.idField = value.idField;
  return table;
}

/** Load and validate the fixtures layer. A missing `static/` (or either subfolder) is not an error. */
export function loadFixtures(staticDir: string, baseDir: string): FixtureSet {
  const set: FixtureSet = {
    lookups: loadDir(join(staticDir, "lookups"), baseDir, "LookupFile", "fixtures"),
    entities: loadDir(join(staticDir, "entities"), baseDir, "EntitiesFile", "fixtures"),
  };

  // Every row declares its identity, and no (entity, id) is declared twice across files.
  const seen = new Map<string, string>();
  for (const table of [...set.lookups, ...set.entities]) {
    const idField = table.idField ?? "id";
    table.rows.forEach((row, index) => {
      const id = row[idField];
      if (id === undefined || id === null) {
        throw new ConfigLayerInvalidError(
          "fixtures",
          table.file,
          `rows[${index}].${idField}`,
          `the row has no identity: every fixture declares an explicit "${idField}"`,
        );
      }
      const key = `${table.entity}\u0000${String(id)}`;
      const earlier = seen.get(key);
      if (earlier !== undefined) {
        throw new ConfigLayerInvalidError(
          "fixtures",
          table.file,
          `rows[${index}].${idField}`,
          `${table.entity} ${String(id)} is already declared in ${earlier}`,
        );
      }
      seen.set(key, table.file);
    });
  }
  return set;
}
