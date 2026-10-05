/**
 * SQLite implementation of the `Store` seam, over `better-sqlite3`.
 *
 * Synchronous by design: the CRUD engine's per-operation work is one indexed row
 * read/write, and blocking on it is what keeps "one transaction per mutation"
 * straightforward (constitution V, research.md §4).
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { StoreUnwritableError } from "../errors.js";
import type { ListQuery, Origin, RequestLogEntry, Store, StoreOptions, StoredRecord } from "./index.js";
import {
  META_DDL,
  META_TABLE,
  META_TABLES,
  ORIGIN_CHECK,
  REQUESTS_DDL,
  REQUESTS_TABLE,
  RESOURCE_COLUMNS,
  SCHEMA_VERSION,
  quoteIdent,
  resourceDdl,
} from "./schema.js";

export { ORIGIN_CHECK, RESOURCE_COLUMNS };

interface RecordRow {
  id: string;
  origin: string;
  doc: string;
  created_at: string;
  updated_at: string;
}

interface RequestRow {
  id: number;
  at: string;
  method: string;
  path: string;
  status: number;
  live: number;
  duration_ms: number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nowIso(): string {
  return new Date().toISOString();
}

export class SqliteStore implements Store {
  readonly path: string;
  #db: Database.Database | undefined;

  constructor(options: StoreOptions) {
    this.path = options.path;
  }

  #require(): Database.Database {
    if (!this.#db) throw new Error("store is not open; call open() first");
    return this.#db;
  }

  open(): void {
    if (this.#db) return;
    if (this.path !== ":memory:") {
      try {
        mkdirSync(dirname(this.path), { recursive: true });
      } catch (error) {
        throw new StoreUnwritableError(this.path, messageOf(error));
      }
    }
    try {
      this.#db = new Database(this.path);
    } catch (error) {
      throw new StoreUnwritableError(this.path, messageOf(error));
    }
    try {
      this.ensureSchema();
    } catch (error) {
      throw new StoreUnwritableError(this.path, messageOf(error));
    }
    if (this.getMeta("schema_version") === undefined) {
      this.setMeta("schema_version", SCHEMA_VERSION);
    }
  }

  close(): void {
    if (!this.#db) return;
    this.#db.close();
    this.#db = undefined;
  }

  ensureSchema(): void {
    const db = this.#require();
    db.exec(META_DDL);
    db.exec(REQUESTS_DDL);
  }

  ensureResource(resource: string): void {
    this.#require().exec(resourceDdl(resource));
  }

  insert(resource: string, identity: string, data: unknown, origin: Origin = "runtime"): StoredRecord {
    this.ensureResource(resource);
    const at = nowIso();
    this.#require()
      .prepare(
        `INSERT INTO ${quoteIdent(resource)} (id, origin, doc, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(identity, origin, JSON.stringify(data), at, at);
    return { resource, identity, data, origin, createdAt: at, updatedAt: at };
  }

  readOne(resource: string, identity: string): StoredRecord | undefined {
    this.ensureResource(resource);
    const row = this.#require()
      .prepare(`SELECT id, origin, doc, created_at, updated_at FROM ${quoteIdent(resource)} WHERE id = ?`)
      .get(identity) as RecordRow | undefined;
    return row ? toRecord(resource, row) : undefined;
  }

  list(resource: string): StoredRecord[] {
    this.ensureResource(resource);
    const rows = this.#require()
      .prepare(`SELECT id, origin, doc, created_at, updated_at FROM ${quoteIdent(resource)} ORDER BY rowid`)
      .all() as RecordRow[];
    return rows.map((row) => toRecord(resource, row));
  }

  listPaged(resource: string, query: ListQuery = {}): StoredRecord[] {
    this.ensureResource(resource);
    const table = quoteIdent(resource);
    const columns = "id, origin, doc, created_at, updated_at";

    const clauses: string[] = [];
    const filterBindings: Array<string | number | boolean> = [];
    // Filter and sort name the document's own properties, extracted from the JSON body
    // with SQLite's JSON1 functions — the page is assembled by the database, so the
    // collection never has to be materialised in JS to answer one page (FR-007, T025).
    for (const filter of query.filters ?? []) {
      clauses.push(`json_extract(doc, ?) = ?`);
      filterBindings.push(`$.${filter.field}`, filter.value);
    }

    const order: string[] = [];
    const orderBindings: string[] = [];
    for (const sort of query.sort ?? []) {
      order.push(`json_extract(doc, ?) ${sort.direction === "desc" ? "DESC" : "ASC"}`);
      orderBindings.push(`$.${sort.field}`);
    }
    order.push("rowid ASC");
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const orderSql = order.join(", ");

    if (typeof query.after === "string") {
      // Cursor paging (FR-007): the token is the identity of the last record the caller saw;
      // the page is the rows that *follow* it in the collection's declared order. A window
      // function gives the token's position under that order (any direction), so the window
      // moves and the collection is never loaded into JS to answer one page.
      let sql =
        `WITH ordered AS (SELECT ${columns}, ROW_NUMBER() OVER (ORDER BY ${orderSql}) AS __rn FROM ${table}${where}),` +
        ` cursor AS (SELECT __rn FROM ordered WHERE id = ?)` +
        ` SELECT ${columns} FROM ordered WHERE __rn > (SELECT __rn FROM cursor) ORDER BY __rn`;
      // Bindings follow the SQL text order exactly: the window's ORDER BY sorts (inside
      // `OVER (...)`), then the WHERE filters, then the cursor id (`WHERE id = ?`). Mixing the
      // groups or repeating one makes SQLite bind a filter value to a `json_extract` path
      // argument — an undeclared 500 for any cursor request that also sorts (F-D).
      const bindings: Array<string | number | boolean> = [...orderBindings, ...filterBindings, query.after];
      if (typeof query.limit === "number") {
        sql += " LIMIT ?";
        bindings.push(query.limit);
        if (typeof query.offset === "number" && query.offset > 0) {
          sql += " OFFSET ?";
          bindings.push(query.offset);
        }
      }
      const rows = this.#require().prepare(sql).all(...bindings) as RecordRow[];
      return rows.map((row) => toRecord(resource, row));
    }

    let sql = `SELECT ${columns} FROM ${table}${where} ORDER BY ${orderSql}`;
    const bindings: Array<string | number | boolean> = [...filterBindings, ...orderBindings];
    if (typeof query.limit === "number") {
      sql += " LIMIT ?";
      bindings.push(query.limit);
      if (typeof query.offset === "number" && query.offset > 0) {
        sql += " OFFSET ?";
        bindings.push(query.offset);
      }
    }

    const rows = this.#require().prepare(sql).all(...bindings) as RecordRow[];
    return rows.map((row) => toRecord(resource, row));
  }

  update(resource: string, identity: string, data: unknown): StoredRecord | undefined {
    this.ensureResource(resource);
    const at = nowIso();
    const result = this.#require()
      .prepare(`UPDATE ${quoteIdent(resource)} SET doc = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(data), at, identity);
    if (result.changes === 0) return undefined;
    return this.readOne(resource, identity);
  }

  delete(resource: string, identity: string): boolean {
    this.ensureResource(resource);
    const result = this.#require()
      .prepare(`DELETE FROM ${quoteIdent(resource)} WHERE id = ?`)
      .run(identity);
    return result.changes > 0;
  }

  wipe(): void {
    for (const table of this.#resourceTables()) {
      this.#require().prepare(`DELETE FROM ${quoteIdent(table)}`).run();
    }
  }

  removeByOrigin(origin: Origin): number {
    let removed = 0;
    for (const table of this.#resourceTables()) {
      const result = this.#require()
        .prepare(`DELETE FROM ${quoteIdent(table)} WHERE origin = ?`)
        .run(origin);
      removed += result.changes;
    }
    return removed;
  }

  appendRequest(entry: RequestLogEntry): void {
    this.#require()
      .prepare(
        `INSERT INTO ${quoteIdent(REQUESTS_TABLE)} (at, method, path, status, live, duration_ms) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(entry.at, entry.method, entry.path, entry.status, entry.live ? 1 : 0, entry.durationMs);
  }

  listRequests(): RequestLogEntry[] {
    const rows = this.#require()
      .prepare(`SELECT id, at, method, path, status, live, duration_ms FROM ${quoteIdent(REQUESTS_TABLE)} ORDER BY id`)
      .all() as RequestRow[];
    return rows.map((row) => ({
      method: row.method,
      path: row.path,
      status: row.status,
      live: row.live === 1,
      durationMs: row.duration_ms,
      at: row.at,
    }));
  }

  getMeta(key: string): string | undefined {
    const row = this.#require()
      .prepare(`SELECT value FROM ${quoteIdent(META_TABLE)} WHERE key = ?`)
      .get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.#require()
      .prepare(
        `INSERT INTO ${quoteIdent(META_TABLE)} (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  nextIdentity(resource: string, start: number): number {
    // Key name frozen by data-model.md §2/§3 (`id_seq:<resource>`): slice 2/3 and
    // Phase 4's wipe (T032) read this exact key to reset the counter.
    const key = `id_seq:${resource}`;
    const current = this.getMeta(key);
    const value = current === undefined ? start : Number.parseInt(current, 10);
    this.setMeta(key, String(value + 1));
    return value;
  }

  /**
   * Tables that hold resource records.
   *
   * The tool's own metadata tables are excluded by *exact name* (`META_TABLES`), never by a
   * `_`-prefix: a derived resource's table name comes from a collection path segment that may
   * legitimately begin with `_`, and excluding by prefix silently dropped such a table out of
   * the unscoped wipe and `removeByOrigin` (HANDOFF-p5-p7 §5 item 4, SC-002). A table created
   * by a future schema version is still a resource table, so it is wiped too rather than
   * leaked.
   */
  #resourceTables(): string[] {
    const rows = this.#require()
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'`)
      .all() as { name: string }[];
    return rows.map((row) => row.name).filter((name) => !META_TABLES.has(name));
  }
}

function toRecord(resource: string, row: RecordRow): StoredRecord {
  return {
    resource,
    identity: row.id,
    data: JSON.parse(row.doc) as unknown,
    origin: row.origin as Origin,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createSqliteStore(options: StoreOptions): Store {
  return new SqliteStore(options);
}