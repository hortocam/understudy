import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { StoreUnwritableError } from "../../src/errors.js";
import { ORIGIN_CHECK, RESOURCE_COLUMNS } from "../../src/store/schema.js";
import { createSqliteStore } from "../../src/store/sqlite.js";
import type { Store } from "../../src/store/index.js";

function tempStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "understudy-store-"));
  const store = createSqliteStore({ path: join(dir, "state.db") });
  store.open();
  return store;
}

describe("sqlite store", () => {
  it("round-trips a record through insert, read, list, update and delete", () => {
    const store = tempStore();
    store.insert("Inventory", "1", { id: 1, name: "widget" });

    expect(store.readOne("Inventory", "1")).toMatchObject({
      resource: "Inventory",
      identity: "1",
      data: { id: 1, name: "widget" },
      origin: "runtime",
    });
    expect(store.list("Inventory")).toHaveLength(1);

    const updated = store.update("Inventory", "1", { id: 1, name: "gadget" });
    expect(updated?.data).toEqual({ id: 1, name: "gadget" });
    expect(updated?.createdAt).toBe(store.readOne("Inventory", "1")?.createdAt);

    expect(store.delete("Inventory", "1")).toBe(true);
    expect(store.readOne("Inventory", "1")).toBeUndefined();
    expect(store.delete("Inventory", "1")).toBe(false);
    store.close();
  });

  it("stores and reads metadata", () => {
    const store = tempStore();
    expect(store.getMeta("spec_hash")).toBeUndefined();
    store.setMeta("spec_hash", "abc");
    store.setMeta("spec_hash", "def");
    expect(store.getMeta("spec_hash")).toBe("def");
    expect(store.getMeta("schema_version")).toBe("1");
    store.close();
  });

  it("allocates identities from a per-resource counter", () => {
    const store = tempStore();
    expect(store.nextIdentity("Inventory", 100000)).toBe(100000);
    expect(store.nextIdentity("Inventory", 100000)).toBe(100001);
    expect(store.nextIdentity("Order", 100000)).toBe(100000);
    store.close();
  });

  it("stores the identity counter under the documented `id_seq:<resource>` key", () => {
    const store = tempStore();
    store.nextIdentity("Inventory", 100000);
    // data-model.md §2/§3: "The counter lives in `_understudy_meta` (`id_seq:<resource>`)".
    // The stored format is frozen at merge and read by slice 2/3 and T032's wipe-reset.
    expect(store.getMeta("id_seq:Inventory")).toBe("100001");
    store.close();
  });

  it("appends and reads the request log", () => {
    const store = tempStore();
    store.appendRequest({ method: "GET", path: "/inventory", status: 200, live: true, durationMs: 3, at: "2026-10-03T00:00:00.000Z" });
    store.appendRequest({ method: "GET", path: "/nope", status: 501, live: false, durationMs: 1, at: "2026-10-03T00:00:01.000Z" });
    const log = store.listRequests();
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ method: "GET", path: "/inventory", status: 200, live: true, durationMs: 3 });
    expect(log[1]?.live).toBe(false);
    store.close();
  });

  it("persists across close and reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "understudy-store-"));
    const path = join(dir, "state.db");
    const first = createSqliteStore({ path });
    first.open();
    first.insert("Inventory", "1", { id: 1, name: "widget" });
    first.close();

    const second = createSqliteStore({ path });
    second.open();
    expect(second.readOne("Inventory", "1")?.data).toEqual({ id: 1, name: "widget" });
    second.close();
  });

  it("wipes every record and removes by origin", () => {
    const store = tempStore();
    store.insert("Inventory", "1", { id: 1 }, "runtime");
    store.insert("Inventory", "2", { id: 2 }, "static");
    store.insert("Order", "1", { id: 1 }, "static");

    expect(store.removeByOrigin("static")).toBe(2);
    expect(store.list("Inventory")).toHaveLength(1);
    expect(store.list("Order")).toHaveLength(0);

    store.wipe();
    expect(store.list("Inventory")).toHaveLength(0);
    store.close();
  });

  it("refuses an unwritable store location", () => {
    const dir = mkdtempSync(join(tmpdir(), "understudy-store-"));
    const blocker = join(dir, "not-a-directory");
    writeFileSync(blocker, "x");
    const store = createSqliteStore({ path: join(blocker, "state.db") });
    expect(() => store.open()).toThrow(StoreUnwritableError);
  });
});

describe("sqlite DDL matches data-model.md", () => {
  it("declares the documented columns and origin CHECK constraint", () => {
    const dir = mkdtempSync(join(tmpdir(), "understudy-store-"));
    const path = join(dir, "state.db");
    const store = createSqliteStore({ path });
    store.open();
    store.insert("Inventory", "1", { id: 1 });
    store.close();

    const db = new Database(path, { readonly: true });
    const columns = db.prepare('PRAGMA table_info("Inventory")').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual([...RESOURCE_COLUMNS]);

    const master = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'Inventory'")
      .get() as { sql: string };
    expect(master.sql).toContain(ORIGIN_CHECK);

    const requestColumns = db.prepare('PRAGMA table_info("_requests")').all() as Array<{ name: string }>;
    expect(requestColumns.map((column) => column.name)).toEqual([
      "id",
      "at",
      "method",
      "path",
      "status",
      "live",
      "duration_ms",
    ]);

    expect(() =>
      db
        .prepare('INSERT INTO "Inventory" (id, origin, doc, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run("9", "bogus", "{}", "t", "t"),
    ).toThrow();
    db.close();
  });
});