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
import { createHash } from "node:crypto";
import { StoreSchemaConflictError, StoreUnwritableError, ReservedTableNameError } from "../errors.js";
import {
  ReferenceViolationError,
  type IdRange,
  type ListQuery,
  type NewRecord,
  type Origin,
  type RequestLogEntry,
  type ResourceOptions,
  type Store,
  type StoreOptions,
  type StoredRecord,
} from "./index.js";
import {
  ID_RANGES_DDL,
  ID_RANGES_TABLE,
  META_DDL,
  META_TABLE,
  META_TABLES,
  ORIGIN_CHECK,
  REQUESTS_DDL,
  REQUESTS_TABLE,
  RESOURCE_COLUMNS,
  SCHEMA_VERSION,
  fkColumn,
  jsonPathLiteral,
  quoteIdent,
  resourceAuxDdl,
  resourceTableDdl,
  type ForeignKeyDdl,
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

/** Re-throw a driver foreign-key failure as the seam's `ReferenceViolationError`. */
function translate(error: unknown, resource: string, operation: "write" | "delete"): never {
  // SQLite reports a missing parent as SQLITE_CONSTRAINT_FOREIGNKEY but a RESTRICT/deferred
  // violation as SQLITE_CONSTRAINT_TRIGGER; the message is the same for both.
  const code = (error as { code?: string } | undefined)?.code ?? "";
  if (code.startsWith("SQLITE_CONSTRAINT") && /FOREIGN KEY constraint failed/.test(messageOf(error))) {
    throw new ReferenceViolationError(
      operation === "delete" ? "referenced" : "missing-parent",
      resource,
      operation === "delete"
        ? `${resource} is referenced by other records`
        : `${resource} references a record that does not exist`,
    );
  }
  throw error;
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
  /** Per-resource shape the store was told about (foreign keys, indexed properties). */
  readonly #specs = new Map<string, { foreignKeys: ForeignKeyDdl[]; indexes: string[] }>();
  /** Resources whose table this connection has already ensured (slice 1 re-ran the DDL on every call). */
  readonly #ensured = new Set<string>();
  readonly #insertSql = new Map<string, string>();
  readonly #updateSql = new Map<string, string>();

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
    this.#db.pragma("foreign_keys = ON");
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
    db.exec(ID_RANGES_DDL);
  }

  ensureResource(resource: string, options?: ResourceOptions): void {
    // A resource's table is named after it; the tool's own tables (`_understudy_meta`,
    // `_requests`, `_id_ranges`) are reserved by EXACT name. Reaching the DDL with one of those
    // names would `CREATE TABLE IF NOT EXISTS` past the existing tool table and die later on a
    // missing column — an opaque driver error. Refuse here, naming the collision (VI).
    if (META_TABLES.has(resource)) throw new ReservedTableNameError(resource, resource, [...META_TABLES]);
    if (options === undefined && this.#ensured.has(resource)) return;
    const db = this.#require();
    if (options !== undefined) {
      this.#specs.set(resource, {
        foreignKeys: (options.foreignKeys ?? []).map((fk) => ({ ...fk })),
        indexes: [...(options.indexes ?? [])],
      });
      this.#insertSql.delete(resource);
      this.#updateSql.delete(resource);
    }
    const spec = this.#specs.get(resource) ?? { foreignKeys: [], indexes: [] };
    const exists =
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(resource) !== undefined;
    const fingerprint = shapeFingerprint(spec.foreignKeys);
    if (!exists) {
      db.exec(resourceTableDdl(resource, spec.foreignKeys));
      this.setMeta(`ddl:${resource}`, fingerprint);
    } else if (options !== undefined) {
      const stored = this.getMeta(`ddl:${resource}`) ?? shapeFingerprint([]);
      if (stored !== fingerprint) {
        this.#rebuild(resource, spec.foreignKeys);
        this.setMeta(`ddl:${resource}`, fingerprint);
      }
    }
    db.exec(resourceAuxDdl(resource, spec.foreignKeys, spec.indexes));
    this.#ensured.add(resource);
  }

  /**
   * Rebuild a resource's table in place under a changed shape (a relation pinned after data
   * exists). Enforcement is off for the copy and checked afterwards: rows that would violate the
   * new constraint refuse the change naming the resource, never silently dropping the link.
   */
  #rebuild(resource: string, foreignKeys: ForeignKeyDdl[]): void {
    const db = this.#require();
    const temp = `${resource}__rebuild`;
    db.pragma("foreign_keys = OFF");
    try {
      db.transaction(() => {
        db.exec(`DROP TABLE IF EXISTS ${quoteIdent(temp)}`);
        db.exec(resourceTableDdl(temp, foreignKeys));
        const columns = foreignKeys.map((fk) => `, ${quoteIdent(fkColumn(fk.field))}`).join("");
        const values = foreignKeys.map((fk) => `, CAST(json_extract(doc, ${jsonPathLiteral(fk.field)}) AS TEXT)`).join("");
        db.exec(
          `INSERT INTO ${quoteIdent(temp)} (id, origin, doc, created_at, updated_at${columns}) ` +
            `SELECT id, origin, doc, created_at, updated_at${values} FROM ${quoteIdent(resource)} ORDER BY rowid`,
        );
        db.exec(`DROP TABLE ${quoteIdent(resource)}`);
        db.exec(`ALTER TABLE ${quoteIdent(temp)} RENAME TO ${quoteIdent(resource)}`);
        const violations = db.prepare(`PRAGMA foreign_key_check(${quoteIdent(resource)})`).all() as Array<{ parent: string }>;
        if (violations.length > 0) {
          const parents = [...new Set(violations.map((v) => v.parent))].join(", ");
          throw new StoreSchemaConflictError(
            resource,
            `${violations.length} existing ${resource} row(s) reference a missing ${parents} record, so the newly decided link cannot be enforced; reset the mock or fix the data`,
          );
        }
      })();
    } finally {
      db.pragma("foreign_keys = ON");
    }
  }

  insert(resource: string, identity: string, data: unknown, origin: Origin = "runtime"): StoredRecord {
    const at = nowIso();
    return this.#insertRow({ resource, identity, data, origin, createdAt: at, updatedAt: at });
  }

  #insertRow(record: NewRecord): StoredRecord {
    this.ensureResource(record.resource);
    const spec = this.#specs.get(record.resource);
    const body = JSON.stringify(record.data);
    const params: unknown[] = [record.identity, record.origin, body, record.createdAt, record.updatedAt];
    let sql = this.#insertSql.get(record.resource);
    if (sql === undefined) {
      const fks = spec?.foreignKeys ?? [];
      const columns = fks.map((fk) => `, ${quoteIdent(fkColumn(fk.field))}`).join("");
      const values = fks.map((fk) => `, CAST(json_extract(?, ${jsonPathLiteral(fk.field)}) AS TEXT)`).join("");
      sql = `INSERT INTO ${quoteIdent(record.resource)} (id, origin, doc, created_at, updated_at${columns}) VALUES (?, ?, ?, ?, ?${values})`;
      this.#insertSql.set(record.resource, sql);
    }
    for (let i = 0; i < (spec?.foreignKeys.length ?? 0); i += 1) params.push(body);
    try {
      this.#require().prepare(sql).run(...params);
    } catch (error) {
      translate(error, record.resource, "write");
    }
    return { ...record };
  }

  transaction<T>(fn: () => T): T {
    const db = this.#require();
    try {
      return db.transaction(() => {
        db.pragma("defer_foreign_keys = ON");
        return fn();
      })();
    } catch (error) {
      return translate(error, "(transaction)", "write");
    }
  }

  insertMany(records: NewRecord[]): void {
    const db = this.#require();
    db.transaction(() => {
      for (const record of records) this.#insertRow(record);
    })();
  }

  countByOrigin(): Record<string, Partial<Record<Origin, number>>> {
    const out: Record<string, Partial<Record<Origin, number>>> = {};
    for (const table of this.#resourceTables().sort()) {
      const rows = this.#require()
        .prepare(`SELECT origin, COUNT(*) AS n FROM ${quoteIdent(table)} GROUP BY origin`)
        .all() as Array<{ origin: Origin; n: number }>;
      if (rows.length === 0) continue;
      out[table] = Object.fromEntries(rows.map((row) => [row.origin, row.n]));
    }
    return out;
  }

  listIdentities(resource: string): string[] {
    this.ensureResource(resource);
    const rows = this.#require().prepare(`SELECT id FROM ${quoteIdent(resource)} ORDER BY rowid`).all() as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  reserveRange(range: IdRange): void {
    this.#require()
      .prepare(
        `INSERT INTO ${quoteIdent(ID_RANGES_TABLE)} (resource, id_space, declared, reserved, next, updated_at) VALUES (?, ?, ?, ?, ?, ?) ` +
          `ON CONFLICT(resource) DO UPDATE SET id_space = excluded.id_space, declared = excluded.declared, reserved = excluded.reserved, next = excluded.next, updated_at = excluded.updated_at`,
      )
      .run(range.resource, range.idSpace, range.declared, range.reserved, range.next ?? null, nowIso());
  }

  readRange(resource: string): IdRange | undefined {
    const row = this.#require()
      .prepare(`SELECT resource, id_space, declared, reserved, next FROM ${quoteIdent(ID_RANGES_TABLE)} WHERE resource = ?`)
      .get(resource) as RangeRow | undefined;
    return row ? toRange(row) : undefined;
  }

  advanceRange(resource: string, next: string): void {
    this.#require()
      .prepare(`UPDATE ${quoteIdent(ID_RANGES_TABLE)} SET next = ?, updated_at = ? WHERE resource = ?`)
      .run(next, nowIso(), resource);
  }

  listRanges(): IdRange[] {
    const rows = this.#require()
      .prepare(`SELECT resource, id_space, declared, reserved, next FROM ${quoteIdent(ID_RANGES_TABLE)} ORDER BY resource`)
      .all() as RangeRow[];
    return rows.map(toRange);
  }

  rewindRange(resource: string): void {
    const range = this.readRange(resource);
    if (range) this.advanceRange(resource, range.reserved.split("..")[0] ?? "");
  }

  /** Rewind every cursor to its reserved start, so wipe + regenerate allocates the same identities. */
  #rewindRanges(): void {
    for (const range of this.listRanges()) {
      const start = range.reserved.split("..")[0] ?? "";
      this.advanceRange(range.resource, start);
    }
  }

  /** The query plan of a paged list, for tests and the report's "why is this indexed" (T026). */
  explainList(resource: string, query: ListQuery): string[] {
    this.ensureResource(resource);
    const { sql, bindings } = this.#buildList(resource, query);
    const rows = this.#require().prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings) as Array<{ detail: string }>;
    return rows.map((row) => row.detail);
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
    const { sql, bindings } = this.#buildList(resource, query);
    const rows = this.#require().prepare(sql).all(...bindings) as RecordRow[];
    return rows.map((row) => toRecord(resource, row));
  }

  /**
   * The SQL for one filtered/sorted/paged read. A property the document declares filterable or
   * sortable has an expression index (data-model.md §3); SQLite uses an expression index only
   * when the query repeats the expression, so for those properties the path is inlined as an
   * escaped literal. Any other property keeps the bound-path form (the path is untrusted text).
   */
  #buildList(resource: string, query: ListQuery): { sql: string; bindings: Array<string | number | boolean> } {
    const table = quoteIdent(resource);
    const columns = "id, origin, doc, created_at, updated_at";
    const indexed = new Set(this.#specs.get(resource)?.indexes ?? []);

    const clauses: string[] = [];
    const filterBindings: Array<string | number | boolean> = [];
    // Filter and sort name the document's own properties, extracted from the JSON body
    // with SQLite's JSON1 functions — the page is assembled by the database, so the
    // collection never has to be materialised in JS to answer one page (FR-007, T025).
    for (const filter of query.filters ?? []) {
      if (indexed.has(filter.field)) {
        clauses.push(`json_extract(doc, ${jsonPathLiteral(filter.field)}) = ?`);
        filterBindings.push(filter.value);
      } else {
        clauses.push(`json_extract(doc, ?) = ?`);
        filterBindings.push(`$.${filter.field}`, filter.value);
      }
    }

    const order: string[] = [];
    const orderBindings: string[] = [];
    for (const sort of query.sort ?? []) {
      const direction = sort.direction === "desc" ? "DESC" : "ASC";
      if (indexed.has(sort.field)) {
        order.push(`json_extract(doc, ${jsonPathLiteral(sort.field)}) ${direction}`);
      } else {
        order.push(`json_extract(doc, ?) ${direction}`);
        orderBindings.push(`$.${sort.field}`);
      }
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
      return { sql, bindings };
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
    return { sql, bindings };
  }

  update(resource: string, identity: string, data: unknown, atInstant?: string): StoredRecord | undefined {
    this.ensureResource(resource);
    const at = atInstant ?? nowIso();
    const body = JSON.stringify(data);
    const foreignKeys = this.#specs.get(resource)?.foreignKeys ?? [];
    let sql = this.#updateSql.get(resource);
    if (sql === undefined) {
      const links = foreignKeys
        .map((fk) => `, ${quoteIdent(fkColumn(fk.field))} = CAST(json_extract(?, ${jsonPathLiteral(fk.field)}) AS TEXT)`)
        .join("");
      sql = `UPDATE ${quoteIdent(resource)} SET doc = ?, updated_at = ?${links} WHERE id = ?`;
      this.#updateSql.set(resource, sql);
    }
    let result: Database.RunResult;
    try {
      result = this.#require()
        .prepare(sql)
        .run(body, at, ...foreignKeys.map(() => body), identity);
    } catch (error) {
      translate(error, resource, "write");
    }
    if (result.changes === 0) return undefined;
    return this.readOne(resource, identity);
  }

  delete(resource: string, identity: string): boolean {
    this.ensureResource(resource);
    try {
      const result = this.#require()
        .prepare(`DELETE FROM ${quoteIdent(resource)} WHERE id = ?`)
        .run(identity);
      return result.changes > 0;
    } catch (error) {
      return translate(error, resource, "delete");
    }
  }

  wipe(): void {
    const db = this.#require();
    db.transaction(() => {
      // Children and parents go together: deferring the check to commit lets a restrict link
      // pass when both ends are removed, and still refuses if a referencing row would remain.
      db.pragma("defer_foreign_keys = ON");
      for (const table of this.#resourceTables()) db.prepare(`DELETE FROM ${quoteIdent(table)}`).run();
      this.#rewindRanges();
    })();
  }

  removeByOrigin(origin: Origin): number {
    const db = this.#require();
    let removed = 0;
    db.transaction(() => {
      db.pragma("defer_foreign_keys = ON");
      for (const table of this.#resourceTables()) {
        removed += db.prepare(`DELETE FROM ${quoteIdent(table)} WHERE origin = ?`).run(origin).changes;
      }
      if (origin === "generated") this.#rewindRanges();
    })();
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

interface RangeRow {
  resource: string;
  id_space: string;
  declared: string;
  reserved: string;
  next: string | null;
}

function toRange(row: RangeRow): IdRange {
  return {
    resource: row.resource,
    idSpace: row.id_space as IdRange["idSpace"],
    declared: row.declared,
    reserved: row.reserved,
    ...(row.next === null ? {} : { next: row.next }),
  };
}

/** A stable fingerprint of the parts of a table's shape that need a rebuild when they change. */
function shapeFingerprint(foreignKeys: ForeignKeyDdl[]): string {
  const canonical = [...foreignKeys].sort((a, b) => a.field.localeCompare(b.field)).map((fk) => `${fk.field}>${fk.references}:${fk.onDelete}`);
  return createHash("sha256").update(canonical.join("|")).digest("hex").slice(0, 16);
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