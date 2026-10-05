/**
 * T043 — a large collection is answered without loading it into memory (FR-007).
 *
 * The seam is `Store.listPaged`: a page must be assembled by the store (SQL LIMIT/OFFSET)
 * and handed back as O(page) records, never by materialising the whole collection in JS.
 * The proof is behavioural, not a source-text grep: a counting `Store` decorator wraps the
 * real SQLite store, records every record and byte that crosses the boundary, and the test
 * drives a real HTTP list request against a collection seeded far past the page size.
 *
 * The assertions are therefore about observable work: the page carries `limit` records, the
 * store materialised O(page) rows and a tiny fraction of the collection's bytes, and the
 * whole-collection `Store.list` was never touched while serving a page.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createMock, type RunningMock } from "../../src/index.js";
import { createLogger } from "../../src/logging.js";
import { parseConfig } from "../../src/config/load.js";
import { SqliteStore } from "../../src/store/sqlite.js";
import type { ListQuery, Origin, RequestLogEntry, Store, StoreOptions, StoredRecord } from "../../src/store/index.js";
import { fixturePath } from "../helpers/mock.js";

let mock: RunningMock | undefined;

afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

/** Bytes a record's stored representation occupies, as materialised in JS. */
function bytesOf(record: StoredRecord): number {
  return JSON.stringify(record.data).length;
}

interface Counts {
  /** Records returned by any read that materialises rows. */
  records: number;
  /** Total bytes of those records' representations. */
  bytes: number;
  /** Every `listPaged` query the engine asked for. */
  queries: ListQuery[];
  /** How many times the whole-collection read was called. */
  listCalls: number;
}

/**
 * A `Store` decorator that delegates every call to the real store and records how much a
 * read materialised. It is the only observer in the test — no source inspection.
 */
class CountingStore implements Store {
  readonly inner: Store;
  readonly counts: Counts = { records: 0, bytes: 0, queries: [], listCalls: 0 };

  constructor(options: StoreOptions) {
    this.inner = new SqliteStore(options);
  }

  get path(): string {
    return this.inner.path;
  }

  #account(records: StoredRecord[]): StoredRecord[] {
    for (const record of records) {
      this.counts.records += 1;
      this.counts.bytes += bytesOf(record);
    }
    return records;
  }

  open(): void {
    this.inner.open();
  }
  close(): void {
    this.inner.close();
  }
  ensureSchema(): void {
    this.inner.ensureSchema();
  }
  ensureResource(resource: string): void {
    this.inner.ensureResource(resource);
  }

  insert(resource: string, identity: string, data: unknown, origin?: Origin): StoredRecord {
    return this.inner.insert(resource, identity, data, origin);
  }
  readOne(resource: string, identity: string): StoredRecord | undefined {
    const record = this.inner.readOne(resource, identity);
    return record ? this.#account([record])[0] : undefined;
  }
  list(resource: string): StoredRecord[] {
    this.counts.listCalls += 1;
    return this.#account(this.inner.list(resource));
  }
  listPaged(resource: string, query?: ListQuery): StoredRecord[] {
    if (query) this.counts.queries.push(query);
    return this.#account(this.inner.listPaged(resource, query));
  }
  update(resource: string, identity: string, data: unknown): StoredRecord | undefined {
    return this.inner.update(resource, identity, data);
  }
  delete(resource: string, identity: string): boolean {
    return this.inner.delete(resource, identity);
  }
  wipe(): void {
    this.inner.wipe();
  }
  removeByOrigin(origin: Origin): number {
    return this.inner.removeByOrigin(origin);
  }
  appendRequest(entry: RequestLogEntry): void {
    this.inner.appendRequest(entry);
  }
  listRequests(): RequestLogEntry[] {
    return this.inner.listRequests();
  }
  getMeta(key: string): string | undefined {
    return this.inner.getMeta(key);
  }
  setMeta(key: string, value: string): void {
    this.inner.setMeta(key, value);
  }
  nextIdentity(resource: string, start: number): number {
    return this.inner.nextIdentity(resource, start);
  }
}

const TOTAL = 21_000;
const PAGE = 10;

describe("a large collection is paged without loading it into memory (FR-007, T043)", () => {
  it("materialises O(page) records and a tiny fraction of the collection's bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "understudy-large-"));
    const store = new CountingStore({ path: join(dir, "state.db") });
    store.open();

    const config = parseConfig(
      [
        `spec: ${fixturePath("inventory-api.yaml")}`,
        "operations:",
        "  - GET /inventory",
        `storage: { driver: sqlite, path: ${JSON.stringify(join(dir, "state.db"))} }`,
      ].join("\n"),
      join(dir, "understudy.yaml"),
    );

    mock = await createMock(config, {
      port: 0,
      out: () => {},
      logger: createLogger({ write: () => {} }),
      store,
    });

    // Seed far past the page size in one SQLite transaction on a second connection to the
    // same file (a per-row HTTP create, or a per-row autocommit insert, would dominate the
    // run). Each row carries a ~1 KB payload so the collection's footprint is large enough
    // that materialising it would be unmistakable.
    const payload = "x".repeat(1024);
    const db = new Database(join(dir, "state.db"));
    const insert = db.prepare('INSERT INTO "Inventory" (id, origin, doc, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
    const at = new Date().toISOString();
    let totalBytes = 0;
    db.transaction(() => {
      for (let index = 0; index < TOTAL; index += 1) {
        const data = { id: 100000 + index, sku: `SKU-${index}`, quantity: index, notes: payload };
        insert.run(String(100000 + index), "runtime", JSON.stringify(data), at, at);
        totalBytes += JSON.stringify(data).length;
      }
    })();
    db.close();
    expect(totalBytes).toBeGreaterThan(10 * 1024 * 1024); // > 10 MB of collection

    // Reset the counters so only the page request under test is measured.
    store.counts.records = 0;
    store.counts.bytes = 0;
    store.counts.listCalls = 0;
    store.counts.queries.length = 0;

    const response = await fetch(`${mock.baseUrl}/inventory?offset=5000&limit=${PAGE}`);
    expect(response.status).toBe(200);
    const page = (await response.json()) as Array<{ id: number; sku: string }>;

    // The page is the declared window, in order — real paging, not a full read sliced in JS.
    expect(page).toHaveLength(PAGE);
    expect(page.map((row) => row.sku)).toEqual(
      Array.from({ length: PAGE }, (_unused, index) => `SKU-${5000 + index}`),
    );

    // The engine asked the store for a bounded page: a limit was pushed down.
    expect(store.counts.queries).toHaveLength(1);
    expect(store.counts.queries[0]?.limit).toBe(PAGE);
    expect(store.counts.queries[0]?.offset).toBe(5000);

    // O(page) records materialised — independent of the 21,000-row collection.
    expect(store.counts.records).toBeLessThanOrEqual(PAGE);
    // ...and the whole-collection read was never used to answer a page.
    expect(store.counts.listCalls).toBe(0);
    // The bytes read are a rounding error against the collection: memory does not scale
    // with the collection size.
    expect(store.counts.bytes).toBeLessThan(totalBytes / 100);

    store.close();
  });
});
