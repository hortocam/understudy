/**
 * The `Store` interface — the principle-X seam.
 *
 * It exists before the feature that needs it: slice 6 adds a Postgres adapter and
 * slice 3 adds snapshot/restore, both over this interface. SQL must not leak past
 * `sqlite.ts`; callers only ever see records, request-log rows and metadata.
 *
 * The stored shape is fixed by `specs/001-slice-1-core/data-model.md` §2: one table
 * per derived resource, `_understudy_meta`, and `_requests`.
 */

/** Where a stored record came from. Slice 1 only ever writes `runtime`. */
export type Origin = "runtime" | "static" | "imported" | "generated";

export const ORIGINS: readonly Origin[] = ["static", "imported", "generated", "runtime"];

export interface StoredRecord {
  /** The derived resource (entity) name. */
  resource: string;
  /** The record's identity, as text (typed back to the document's declared type on read). */
  identity: string;
  /** The record body, using the consumer's own field names. */
  data: unknown;
  origin: Origin;
  createdAt: string;
  updatedAt: string;
}

export interface RequestLogEntry {
  method: string;
  path: string;
  status: number;
  /** 1 if the operation was selected (live), 0 if it answered 501. */
  live: boolean;
  durationMs: number;
  at: string;
}

export interface StoreOptions {
  /** SQLite file path, or `:memory:` for an ephemeral store. */
  path: string;
}

/**
 * A list read the CRUD engine asks the store for: filter, sort and page in one step.
 *
 * `after` is a cursor token — the identity of the last record a caller saw — and the read
 * returns the records that follow it in the collection's order (FR-007). Resolving the token
 * to a position is the store's job: it owns the row order, so a cursor page is never
 * assembled by loading the collection into JS.
 */
export interface ListQuery {
  filters?: Array<{ field: string; value: string | number | boolean }>;
  sort?: Array<{ field: string; direction: "asc" | "desc" }>;
  offset?: number;
  limit?: number;
  after?: string;
}

/**
 * A write broke a foreign key: the record names a parent that does not exist
 * (`missing-parent`), or a parent was deleted while children still reference it (`referenced`).
 * The store translates its driver's constraint failure into this so no caller depends on SQL.
 */
export class ReferenceViolationError extends Error {
  readonly kind: "missing-parent" | "referenced";
  readonly resource: string;
  constructor(kind: "missing-parent" | "referenced", resource: string, detail: string) {
    super(`FOREIGN KEY constraint failed: ${detail}`);
    this.name = "ReferenceViolationError";
    this.kind = kind;
    this.resource = resource;
  }
}

/** A foreign key from a `decided` relationship (data-model.md §3). An undetermined link gets none. */
export interface ForeignKeySpec {
  /** The child record's link property. */
  field: string;
  /** The parent resource (its identity is what the link resolves to). */
  references: string;
  onDelete: "restrict" | "cascade" | "setNull";
}

/** Options a resource's table is created with (slice 2; omitted = slice 1's plain table). */
export interface ResourceOptions {
  foreignKeys?: ForeignKeySpec[];
  /** Properties to index because the document declares them filterable/sortable. */
  indexes?: string[];
}

/** One record for `insertMany`, carrying explicit timestamps so a seeded run is reproducible. */
export interface NewRecord {
  resource: string;
  identity: string;
  data: unknown;
  origin: Origin;
  createdAt: string;
  updatedAt: string;
}

export type IdSpace = "integer" | "uuid" | "formatted" | "opaque";

/** A collection's reserved identity span and allocation cursor (`_id_ranges`, D3). */
export interface IdRange {
  resource: string;
  idSpace: IdSpace;
  /** The configured/derived range or format, as written. */
  declared: string;
  /** The span generation allocates within, `<from>..<to>` (an open end is empty). */
  reserved: string;
  /** The next value to allocate (text: uuid/formatted identities are not integers). */
  next?: string;
}

export interface Store {
  readonly path: string;

  /** Open the database and ensure the metadata tables exist. */
  open(): void;
  /** Close the database. Idempotent. */
  close(): void;
  /** Create the metadata tables if absent. */
  ensureSchema(): void;
  /**
   * Create the table for one resource if absent. With `options` (slice 2) the table also carries
   * real foreign keys and the indexes; a table whose shape differs is rebuilt in place, or the
   * call refuses naming the resource when existing rows would violate the new constraint.
   */
  ensureResource(resource: string, options?: ResourceOptions): void;

  insert(resource: string, identity: string, data: unknown, origin?: Origin): StoredRecord;
  /**
   * Run `fn` as one transaction: everything it does commits together or not at all. Foreign-key
   * checks are deferred to the commit, so a restrict link passes when parent and children change
   * together and still refuses if a referencing row would remain.
   */
  transaction<T>(fn: () => T): T;
  /** Insert many records in ONE transaction: all of them or none (principle V, narrow form). */
  insertMany(records: NewRecord[]): void;
  readOne(resource: string, identity: string): StoredRecord | undefined;
  /** Record counts per resource, then per origin (FR-004). */
  countByOrigin(): Record<string, Partial<Record<Origin, number>>>;
  /** A resource's identities in insertion order, without loading any record body. */
  listIdentities(resource: string): string[];
  reserveRange(range: IdRange): void;
  readRange(resource: string): IdRange | undefined;
  advanceRange(resource: string, next: string): void;
  listRanges(): IdRange[];
  /** Rewind one collection's cursor to the start of its reserved span (a scoped reset, FR-014). */
  rewindRange(resource: string): void;
  list(resource: string): StoredRecord[];
  /**
   * A filtered, sorted and paged read, executed by the store so a page never loads the
   * whole collection into memory (FR-007, T025). `sort`/`filters` name the document's own
   * properties.
   */
  listPaged(resource: string, query?: ListQuery): StoredRecord[];
  /** `at` sets `updated_at` explicitly (the clock seam's instant); omitted, the real time is used. */
  update(resource: string, identity: string, data: unknown, at?: string): StoredRecord | undefined;
  delete(resource: string, identity: string): boolean;

  /** Delete every stored record, leaving the schema in place. */
  wipe(): void;
  /** Delete every stored record with the given origin; returns how many were removed. */
  removeByOrigin(origin: Origin): number;

  appendRequest(entry: RequestLogEntry): void;
  listRequests(): RequestLogEntry[];

  getMeta(key: string): string | undefined;
  setMeta(key: string, value: string): void;

  /** Allocate the next identity for a resource, starting at `start` on first use. */
  nextIdentity(resource: string, start: number): number;
}