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

export interface Store {
  readonly path: string;

  /** Open the database and ensure the metadata tables exist. */
  open(): void;
  /** Close the database. Idempotent. */
  close(): void;
  /** Create the metadata tables if absent. */
  ensureSchema(): void;
  /** Create the table for one resource if absent. */
  ensureResource(resource: string): void;

  insert(resource: string, identity: string, data: unknown, origin?: Origin): StoredRecord;
  readOne(resource: string, identity: string): StoredRecord | undefined;
  list(resource: string): StoredRecord[];
  update(resource: string, identity: string, data: unknown): StoredRecord | undefined;
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