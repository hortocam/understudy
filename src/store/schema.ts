/**
 * DDL for the stored model (`specs/001-slice-1-core/data-model.md` §2).
 *
 * Kept in one place so the store implementation and its test read the same shape,
 * and so the column names and the `origin` CHECK constraint are assertable.
 */

export const META_TABLE = "_understudy_meta";
export const REQUESTS_TABLE = "_requests";
export const SCHEMA_VERSION = "1";

/**
 * The tool's own tables, by exact name — never a prefix.
 *
 * A derived resource's table is named after the resource, which is named after a
 * response-schema `title` or a collection path segment; a segment may legitimately begin
 * with `_` (a vendor's `/_events`, `/__admin`). Excluding metadata by a `'_%'` prefix would
 * therefore swallow such a resource's rows out of the unscoped wipe and `removeByOrigin`
 * (HANDOFF-p5-p7 §5 item 4). An explicit set removes the whole collision class.
 */
export const ID_RANGES_TABLE = "_id_ranges";
export const META_TABLES: ReadonlySet<string> = new Set([META_TABLE, REQUESTS_TABLE, ID_RANGES_TABLE]);

/**
 * ASCII-only lowercasing — the case fold SQLite applies to identifiers.
 *
 * SQLite compares table names with a binary equality that ignores ASCII case (`"_Requests"`
 * and `_requests` name the same physical table) and leaves every other character untouched.
 * JavaScript's Unicode `toLowerCase` would fold some non-ASCII code points that SQLite does
 * not, so the fold here is deliberately restricted to `[A-Z]`.
 */
function asciiFold(value: string): string {
  return value.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
}

/**
 * The tool table a resource name would collide with under SQLite's identifier identity, if any.
 *
 * A derived resource's name becomes its table name, and SQLite table identity is
 * case-insensitive for ASCII. An exact-name test (`META_TABLES.has`) therefore misses a title
 * like `_Requests`: `CREATE TABLE IF NOT EXISTS "_Requests"` silently no-ops onto the tool's
 * already-existing `_requests` table, and the index DDL then dies on a missing column. Matching
 * by folded name closes the case-variant of that collision. Returns the canonical reserved table
 * name the resource folds onto, or `undefined` when the name is free. Still never a `_`-prefix
 * test: `_event` does not fold onto any reserved table and stays allowed.
 */
export function reservedTableFor(resource: string): string | undefined {
  const folded = asciiFold(resource);
  for (const table of META_TABLES) {
    if (asciiFold(table) === folded) return table;
  }
  return undefined;
}

/** Quote an SQL identifier, escaping embedded quotes. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export const META_DDL = `CREATE TABLE IF NOT EXISTS ${quoteIdent(META_TABLE)} (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);`;

export const REQUESTS_DDL = `CREATE TABLE IF NOT EXISTS ${quoteIdent(REQUESTS_TABLE)} (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  method      TEXT NOT NULL,
  path        TEXT NOT NULL,
  status      INTEGER NOT NULL,
  live        INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ${quoteIdent("_requests_at_idx")} ON ${quoteIdent(REQUESTS_TABLE)} (at);`;

/**
 * Per-collection identity reservations (data-model.md §3, D3): the space, the declared and
 * reserved spans and the allocation cursor. `next` is TEXT because uuid and formatted
 * identities are not integers. The runtime counter `id_seq:<resource>` stays in the meta table.
 */
export const ID_RANGES_DDL = `CREATE TABLE IF NOT EXISTS ${quoteIdent(ID_RANGES_TABLE)} (
  resource   TEXT PRIMARY KEY,
  id_space   TEXT NOT NULL,
  declared   TEXT NOT NULL,
  reserved   TEXT NOT NULL,
  next       TEXT,
  updated_at TEXT NOT NULL
);`;

/** The origin CHECK constraint, verbatim from data-model.md §2. */
export const ORIGIN_CHECK = "origin IN ('static','imported','generated','runtime')";

export interface ForeignKeyDdl {
  field: string;
  references: string;
  onDelete: "restrict" | "cascade" | "setNull";
}

/** The real column that carries a link property, maintained by the store from the record body. */
export function fkColumn(field: string): string {
  return `fk_${field}`;
}

const ON_DELETE: Record<ForeignKeyDdl["onDelete"], string> = {
  restrict: "RESTRICT",
  cascade: "CASCADE",
  setNull: "SET NULL",
};

/** `'$.<field>'` as an SQL string literal, quote-escaped (a document property name is untrusted text). */
export function jsonPathLiteral(field: string): string {
  return `'$.${field.replace(/'/g, "''")}'`;
}

/** The table-only DDL (no indexes/triggers), under `table`'s name. */
export function resourceTableDdl(table: string, foreignKeys: ForeignKeyDdl[] = []): string {
  const fkColumns = foreignKeys.map(
    (fk) =>
      `,\n  ${quoteIdent(fkColumn(fk.field))} TEXT REFERENCES ${quoteIdent(fk.references)}(id) ON DELETE ${ON_DELETE[fk.onDelete]}`,
  );
  return `CREATE TABLE IF NOT EXISTS ${quoteIdent(table)} (
  id         TEXT PRIMARY KEY,
  origin     TEXT NOT NULL CHECK (${ORIGIN_CHECK}),
  doc        TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL${fkColumns.join("")}
);`;
}

/**
 * Indexes and triggers for a resource table. `setNull` needs a trigger: SQLite's own SET NULL
 * action nulls the hidden link column, and the record body must say the same thing.
 */
export function resourceAuxDdl(resource: string, foreignKeys: ForeignKeyDdl[] = [], indexes: string[] = []): string {
  const table = quoteIdent(resource);
  const out: string[] = [`CREATE INDEX IF NOT EXISTS ${quoteIdent(`${resource}_origin_idx`)} ON ${table} (origin);`];
  for (const field of indexes) {
    out.push(
      `CREATE INDEX IF NOT EXISTS ${quoteIdent(`${resource}_${field}_idx`)} ON ${table} (json_extract(doc, ${jsonPathLiteral(field)}));`,
    );
  }
  for (const fk of foreignKeys) {
    out.push(`CREATE INDEX IF NOT EXISTS ${quoteIdent(`${resource}_${fkColumn(fk.field)}_idx`)} ON ${table} (${quoteIdent(fkColumn(fk.field))});`);
    if (fk.onDelete === "setNull") {
      const column = quoteIdent(fkColumn(fk.field));
      out.push(
        `CREATE TRIGGER IF NOT EXISTS ${quoteIdent(`${resource}_${fkColumn(fk.field)}_null`)} AFTER UPDATE OF ${column} ON ${table} ` +
          `WHEN NEW.${column} IS NULL AND OLD.${column} IS NOT NULL ` +
          `BEGIN UPDATE ${table} SET doc = json_set(doc, ${jsonPathLiteral(fk.field)}, json('null')) WHERE id = NEW.id; END;`,
      );
    }
  }
  return out.join("\n");
}

/** DDL for one derived resource's table, plus its origin index (slice 1's shape when no options). */
export function resourceDdl(resource: string, foreignKeys: ForeignKeyDdl[] = [], indexes: string[] = []): string {
  return `${resourceTableDdl(resource, foreignKeys)}\n${resourceAuxDdl(resource, foreignKeys, indexes)}`;
}

/** Columns of a resource table, in declaration order (asserted against data-model.md). */
export const RESOURCE_COLUMNS = ["id", "origin", "doc", "created_at", "updated_at"] as const;

/** Columns of the request-log table, in declaration order. */
export const REQUEST_COLUMNS = [
  "id",
  "at",
  "method",
  "path",
  "status",
  "live",
  "duration_ms",
] as const;