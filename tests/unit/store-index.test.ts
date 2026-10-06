import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { SqliteStore } from "../../src/store/sqlite.js";

describe("indexes for declared filterable/sortable fields (data-model.md §3)", () => {
  function setup(): { path: string; close: () => void; store: SqliteStore } {
    const dir = mkdtempSync(join(tmpdir(), "understudy-idx-"));
    const path = join(dir, "state.db");
    const store = new SqliteStore({ path });
    store.open();
    store.ensureResource("Inventory", { indexes: ["eventId", "price"] });
    store.insertMany(
      Array.from({ length: 200 }, (_, i) => ({
        resource: "Inventory",
        identity: String(i + 1),
        data: { id: i + 1, eventId: (i % 7) + 1, price: 100 - i },
        origin: "generated" as const,
        createdAt: "t",
        updatedAt: "t",
      })),
    );
    return { path, store, close: () => store.close() };
  }

  it("each declared field gets an index named <resource>_<field>_idx", () => {
    const { path, close } = setup();
    close();
    const db = new Database(path, { readonly: true });
    const names = (db.prepare('PRAGMA index_list("Inventory")').all() as Array<{ name: string }>).map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(["Inventory_origin_idx", "Inventory_eventId_idx", "Inventory_price_idx"]));
    db.close();
  });

  it("a filtered, sorted paged list is answered by an INDEX, not a full scan", () => {
    const { path, store, close } = setup();
    const page = store.listPaged("Inventory", {
      filters: [{ field: "eventId", value: 3 }],
      sort: [{ field: "price", direction: "asc" }],
      limit: 5,
    });
    expect(page.length).toBe(5);
    expect(page.every((r) => (r.data as { eventId: number }).eventId === 3)).toBe(true);
    expect(store.explainList("Inventory", { filters: [{ field: "eventId", value: 3 }], limit: 5 }).join("\n")).toMatch(
      /USING (COVERING )?INDEX "?Inventory_eventId_idx/,
    );
    expect(store.explainList("Inventory", { sort: [{ field: "price", direction: "asc" }], limit: 5 }).join("\n")).toMatch(
      /Inventory_price_idx/,
    );
    close();
    void path;
  });

  it("a field with NO declared index is still answered correctly (just scanned)", () => {
    const { store, close } = setup();
    const page = store.listPaged("Inventory", { filters: [{ field: "id", value: 7 }] });
    expect(page).toHaveLength(1);
    expect(store.explainList("Inventory", { filters: [{ field: "id", value: 7 }] }).join("\n")).not.toMatch(/Inventory_id_idx/);
    close();
  });

  it("a hostile field name cannot break out of the SQL", () => {
    const { store, close } = setup();
    expect(() => store.listPaged("Inventory", { filters: [{ field: "x') OR 1=1 --", value: 1 }] })).not.toThrow();
    expect(store.listPaged("Inventory", { filters: [{ field: "x') OR 1=1 --", value: 1 }] })).toHaveLength(0);
    close();
  });
});
