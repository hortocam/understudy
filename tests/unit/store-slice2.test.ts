import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { META_TABLES, RESOURCE_COLUMNS, resourceDdl } from "../../src/store/schema.js";
import { createSqliteStore } from "../../src/store/sqlite.js";
import type { Store } from "../../src/store/index.js";

function tempStore(): { store: Store; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "understudy-store2-"));
  const path = join(dir, "state.db");
  const store = createSqliteStore({ path });
  store.open();
  return { store, path };
}

describe("stored model additions (data-model.md §3, D3, D5)", () => {
  it("_id_ranges has the documented columns and is a metadata table by EXACT name", () => {
    const { store, path } = tempStore();
    store.close();
    const db = new Database(path, { readonly: true });
    const columns = db.prepare('PRAGMA table_info("_id_ranges")').all() as Array<{ name: string }>;
    expect(columns.map((c) => c.name)).toEqual(["resource", "id_space", "declared", "reserved", "next", "updated_at"]);
    db.close();
    expect(META_TABLES.has("_id_ranges")).toBe(true);
  });

  it("a derived resource whose table begins with an underscore is still wiped, and _id_ranges survives a wipe", () => {
    const { store } = tempStore();
    store.reserveRange({ resource: "_id_range", idSpace: "integer", declared: "100000..", reserved: "100000..", next: "100005" });
    store.insert("_id_range", "1", { id: 1 }, "generated");
    store.wipe();
    expect(store.list("_id_range")).toHaveLength(0);
    expect(store.readRange("_id_range")).toBeDefined(); // the metadata table was not swallowed...
    expect(store.readRange("_id_range")?.next).toBe("100000"); // ...and the wipe rewound the cursor
    store.close();
  });

  it("_understudy_meta accepts the recipe, seed, config_hash and clock_mode keys", () => {
    const { store } = tempStore();
    for (const key of ["recipe", "seed", "config_hash", "clock_mode"]) {
      store.setMeta(key, `v-${key}`);
      expect(store.getMeta(key)).toBe(`v-${key}`);
    }
    store.close();
  });

  it("a resource created without options keeps slice 1's DDL: five columns, no fk columns", () => {
    expect(resourceDdl("Plain")).not.toContain("fk_");
    const { store, path } = tempStore();
    store.ensureResource("Plain");
    store.close();
    const db = new Database(path, { readonly: true });
    const columns = db.prepare('PRAGMA table_info("Plain")').all() as Array<{ name: string }>;
    expect(columns.map((c) => c.name)).toEqual([...RESOURCE_COLUMNS]);
    db.close();
  });

  it("reserve / read / advance a range; advancing is durable across reopen", () => {
    const { store, path } = tempStore();
    expect(store.readRange("Event")).toBeUndefined();
    store.reserveRange({ resource: "Event", idSpace: "integer", declared: "start=500000", reserved: "500000..", next: "500000" });
    store.advanceRange("Event", "500010");
    store.close();
    const again = createSqliteStore({ path });
    again.open();
    expect(again.readRange("Event")).toMatchObject({ resource: "Event", idSpace: "integer", next: "500010", reserved: "500000.." });
    again.close();
  });

  it("removeByOrigin('generated') rewinds the cursor to the reserved start, in the same call (wipe + regenerate reproduces)", () => {
    const { store } = tempStore();
    store.reserveRange({ resource: "Event", idSpace: "integer", declared: "100000..", reserved: "100000..", next: "100000" });
    store.insert("Event", "100000", { id: 100000 }, "generated");
    store.advanceRange("Event", "100001");
    store.insert("Event", "1", { id: 1 }, "static");
    expect(store.removeByOrigin("generated")).toBe(1);
    expect(store.readRange("Event")?.next).toBe("100000");
    expect(store.readOne("Event", "1")?.origin).toBe("static");
    store.close();
  });
});

describe("bulk insert, counts and identities (D5, principle V narrow form)", () => {
  const row = (identity: string, origin: "generated" | "static" = "generated") => ({
    resource: "Event",
    identity,
    data: { id: Number(identity) },
    origin,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

  it("insertMany writes every row with the GIVEN timestamps in one transaction", () => {
    const { store } = tempStore();
    store.insertMany([row("1"), row("2"), row("3", "static")]);
    expect(store.list("Event")).toHaveLength(3);
    expect(store.readOne("Event", "2")?.createdAt).toBe("2026-01-01T00:00:00.000Z");
    store.close();
  });

  it("is atomic: a failure mid-batch leaves ZERO rows", () => {
    const { store } = tempStore();
    store.insert("Event", "2", { id: 2 }, "static");
    expect(() => store.insertMany([row("1"), row("2"), row("3")])).toThrow(); // "2" collides
    expect(store.list("Event").map((r) => r.identity)).toEqual(["2"]);
    store.close();
  });

  it("countByOrigin reports per resource and per origin", () => {
    const { store } = tempStore();
    store.insertMany([row("1"), row("2"), row("3", "static")]);
    store.insert("Venue", "1", { id: 1 }, "runtime");
    expect(store.countByOrigin()).toEqual({ Event: { generated: 2, static: 1 }, Venue: { runtime: 1 } });
    store.close();
  });

  it("listIdentities returns identities only, in insertion order", () => {
    const { store } = tempStore();
    store.insertMany([row("10"), row("2"), row("33")]);
    expect(store.listIdentities("Event")).toEqual(["10", "2", "33"]);
    store.close();
  });
});
