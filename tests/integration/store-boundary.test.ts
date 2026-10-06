/**
 * T083 — seals slice 1's T043 blind spot. The existing counting-decorator suite
 * (`large-collection.test.ts`) proves the ENGINE asks the store for O(page) records. It cannot see
 * INSIDE the store: a store that materialises the whole collection through the driver and slices it
 * in JS passes that suite. This suite asserts at the DRIVER boundary instead: a paged list's SQL
 * binds a LIMIT equal to the page size, and no more than a page (plus a point read) of rows ever
 * crosses from SQLite into JavaScript — for offset/limit, page/size AND cursor paging.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMock, type RunningMock } from "../../src/index.js";
import { createLogger } from "../../src/logging.js";
import type { ListQuery, NewRecord, StoredRecord } from "../../src/store/index.js";
import { SqliteStore } from "../../src/store/sqlite.js";
import { fixturePath } from "../helpers/mock.js";
import { allOperations, projectConfig } from "../helpers/project.js";
import { installSqlProbe, readsOf, type ProbedStatement } from "../helpers/sql-probe.js";

const TOTAL = 20_000;
const mocks: RunningMock[] = [];
afterEach(async () => {
  await Promise.all(mocks.splice(0).map((m) => m.close()));
});

/** The store of the double: materialises the WHOLE collection, then slices it in JS. */
class MaterialisingStore extends SqliteStore {
  override listPaged(resource: string, query: ListQuery = {}): StoredRecord[] {
    const all = this.list(resource); // SELECT everything — 20 000 rows cross the driver boundary
    const offset = query.offset ?? 0;
    return all.slice(offset, offset + (query.limit ?? all.length));
  }
}

function rowsFor(resource: string, n: number): NewRecord[] {
  return Array.from({ length: n }, (_, i) => ({
    resource,
    identity: String(100000 + i),
    data: { id: 100000 + i, name: `row ${i}` },
    origin: "generated" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }));
}

async function seeded(StoreClass: typeof SqliteStore): Promise<RunningMock> {
  const spec = fixturePath("cursor-schema-api.yaml");
  const dir = mkdtempSync(join(tmpdir(), "understudy-boundary-"));
  const store = new StoreClass({ path: join(dir, "state.db") });
  const mock = await createMock(projectConfig(dir, { spec, operations: await allOperations(spec) }), {
    port: 0,
    store,
    out: () => {},
    logger: createLogger({ write: () => {} }),
  });
  mocks.push(mock);
  for (const resource of ["CursorThing", "OffsetThing", "PageThing"]) store.insertMany(rowsFor(resource, TOTAL));
  return mock;
}

interface Verdict {
  ok: boolean;
  reasons: string[];
  reads: ProbedStatement[];
}

/** Judge the driver traffic of ONE list request against the page it asked for. */
function judge(statements: ProbedStatement[], resource: string, page: number): Verdict {
  const reads = readsOf(statements, resource);
  const reasons: string[] = [];
  const lists = reads.filter((s) => s.method === "all");
  if (lists.length === 0) reasons.push("no list statement was observed");
  for (const s of lists) {
    if (!/\bLIMIT \?/.test(s.sql)) reasons.push(`list SQL carries no bound LIMIT: ${s.sql.slice(0, 90)}…`);
    else if (!s.params.includes(page)) reasons.push(`LIMIT is not bound to the page size ${page}: params ${JSON.stringify(s.params)}`);
    if (s.rows > page) reasons.push(`${s.rows} rows crossed the driver boundary for a page of ${page}`);
  }
  const total = reads.reduce((n, s) => n + s.rows, 0);
  if (total > page + 2) reasons.push(`${total} rows were materialised in total (a page plus at most a point read)`);
  return { ok: reasons.length === 0, reasons, reads };
}

async function observe(mock: RunningMock, path: string): Promise<ProbedStatement[]> {
  const probe = installSqlProbe();
  try {
    probe.clear();
    const response = await fetch(`${mock.baseUrl}${path}`);
    expect(response.status).toBe(200);
    await response.json();
    return [...probe.statements];
  } finally {
    probe.restore();
  }
}

describe("a paged list over 20 000 rows binds a LIMIT and materialises O(page) rows at the DRIVER (T083)", () => {
  it("offset/limit", async () => {
    const mock = await seeded(SqliteStore);
    const verdict = judge(await observe(mock, "/offset-things?limit=10&offset=500"), "OffsetThing", 10);
    expect(verdict.reasons).toEqual([]);
  });

  it("page/size", async () => {
    const mock = await seeded(SqliteStore);
    const verdict = judge(await observe(mock, "/page-things?page=3&size=10"), "PageThing", 10);
    expect(verdict.reasons).toEqual([]);
  });

  it("cursor (paginationToken + maxPageSize)", async () => {
    const mock = await seeded(SqliteStore);
    const verdict = judge(await observe(mock, "/cursor-things?maxPageSize=25&paginationToken=105000"), "CursorThing", 25);
    expect(verdict.reasons).toEqual([]);
    expect(verdict.reads.some((s) => s.method === "get" && s.rows === 1)).toBe(true); // the token's point read
  });
});

describe("the blind spot is real, and the probe closes it", () => {
  it("a store that materialises the whole collection returns a perfectly small page — and the probe catches it", async () => {
    const mock = await seeded(MaterialisingStore);
    const statements = await observe(mock, "/offset-things?limit=10&offset=500");

    // What the OLD suite could see: the Store interface handed back O(page) records. (Counted the same way
    // large-collection.test.ts counts: the records `listPaged` returned to the engine.)
    const body = mock.store.listPaged("OffsetThing", { limit: 10, offset: 500 });
    expect(body).toHaveLength(10);

    // What only the driver-level probe can see: the whole collection crossed into JavaScript.
    const verdict = judge(statements, "OffsetThing", 10);
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(" | ")).toMatch(/20000 rows/);
    expect(verdict.reasons.join(" | ")).toMatch(/no bound LIMIT/);
  });
});
