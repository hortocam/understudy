/**
 * DDL for the stored model (`specs/001-slice-1-core/data-model.md` §2).
 *
 * Kept in one place so the store implementation and its test read the same shape,
 * and so the column names and the `origin` CHECK constraint are assertable.
 */

export const META_TABLE = "_understudy_meta";
export const REQUESTS_TABLE = "_requests";
export const SCHEMA_VERSION = "1";

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

/** The origin CHECK constraint, verbatim from data-model.md §2. */
export const ORIGIN_CHECK = "origin IN ('static','imported','generated','runtime')";

/** DDL for one derived resource's table, plus its origin index. */
export function resourceDdl(resource: string): string {
  const table = quoteIdent(resource);
  return `CREATE TABLE IF NOT EXISTS ${table} (
  id         TEXT PRIMARY KEY,
  origin     TEXT NOT NULL CHECK (${ORIGIN_CHECK}),
  doc        TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ${quoteIdent(`${resource}_origin_idx`)} ON ${table} (origin);`;
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