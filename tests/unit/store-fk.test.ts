import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createSqliteStore } from "../../src/store/sqlite.js";
import type { Store } from "../../src/store/index.js";

function open(): { store: Store; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "understudy-fk-"));
  const path = join(dir, "state.db");
  const store = createSqliteStore({ path });
  store.open();
  return { store, path };
}

function withPolicy(onDelete: "restrict" | "cascade" | "setNull"): Store {
  const { store } = open();
  store.ensureResource("Event");
  store.ensureResource("Inventory", { foreignKeys: [{ field: "eventId", references: "Event", onDelete }] });
  store.insert("Event", "1", { id: 1 }, "static");
  store.insert("Inventory", "10", { id: 10, eventId: 1 }, "generated");
  return store;
}

describe("foreign keys from decided relationships (data-model.md §3)", () => {
  it("a decided relationship produces a REAL references constraint", () => {
    const { store, path } = open();
    store.ensureResource("Event");
    store.ensureResource("Inventory", { foreignKeys: [{ field: "eventId", references: "Event", onDelete: "restrict" }] });
    store.close();
    const db = new Database(path, { readonly: true });
    const list = db.prepare('PRAGMA foreign_key_list("Inventory")').all() as Array<{ table: string; on_delete: string }>;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ table: "Event", on_delete: "RESTRICT" });
    db.close();
  });

  it("restrict refuses deleting a referenced parent; the child survives", () => {
    const store = withPolicy("restrict");
    expect(() => store.delete("Event", "1")).toThrow(/FOREIGN KEY/);
    expect(store.readOne("Event", "1")).toBeDefined();
    expect(store.readOne("Inventory", "10")).toBeDefined();
    store.close();
  });

  it("cascade removes the children", () => {
    const store = withPolicy("cascade");
    expect(store.delete("Event", "1")).toBe(true);
    expect(store.readOne("Inventory", "10")).toBeUndefined();
    store.close();
  });

  it("setNull nulls the child's link field IN THE RECORD BODY, not only in a hidden column", () => {
    const store = withPolicy("setNull");
    store.delete("Event", "1");
    expect(store.readOne("Inventory", "10")?.data).toEqual({ id: 10, eventId: null });
    store.close();
  });

  it("an orphan insert is refused; a null link is not an orphan", () => {
    const store = withPolicy("restrict");
    expect(() => store.insert("Inventory", "11", { id: 11, eventId: 999 })).toThrow(/FOREIGN KEY/);
    expect(() => store.insert("Inventory", "12", { id: 12, eventId: null })).not.toThrow();
    expect(() => store.insert("Inventory", "13", { id: 13 })).not.toThrow();
    store.close();
  });

  it("an update re-checks the link", () => {
    const store = withPolicy("restrict");
    expect(() => store.update("Inventory", "10", { id: 10, eventId: 999 })).toThrow(/FOREIGN KEY/);
    store.insert("Event", "2", { id: 2 }, "static");
    expect(store.update("Inventory", "10", { id: 10, eventId: 2 })?.data).toEqual({ id: 10, eventId: 2 });
    store.close();
  });

  it("an UNDETERMINED link produces NO constraint: the table carries no reference at all", () => {
    const { store, path } = open();
    store.ensureResource("Event");
    store.ensureResource("Inventory", { foreignKeys: [] });
    store.insert("Inventory", "1", { id: 1, eventId: 12345 }); // would be an orphan if enforced
    store.close();
    const db = new Database(path, { readonly: true });
    expect(db.prepare('PRAGMA foreign_key_list("Inventory")').all()).toEqual([]);
    db.close();
  });

  it("enforcement is on for every connection (reopen)", () => {
    const { store, path } = open();
    store.ensureResource("Event");
    store.ensureResource("Inventory", { foreignKeys: [{ field: "eventId", references: "Event", onDelete: "restrict" }] });
    store.close();
    const again = createSqliteStore({ path });
    again.open();
    again.ensureResource("Event");
    again.ensureResource("Inventory", { foreignKeys: [{ field: "eventId", references: "Event", onDelete: "restrict" }] });
    expect(() => again.insert("Inventory", "1", { id: 1, eventId: 5 })).toThrow(/FOREIGN KEY/);
    again.close();
  });

  it("changing a pinned relation later migrates the existing table, or refuses naming it if rows would orphan", () => {
    const { store } = open();
    store.ensureResource("Event");
    store.ensureResource("Inventory", { foreignKeys: [] });
    store.insert("Event", "1", { id: 1 });
    store.insert("Inventory", "10", { id: 10, eventId: 1 });
    store.ensureResource("Inventory", { foreignKeys: [{ field: "eventId", references: "Event", onDelete: "restrict" }] });
    expect(() => store.delete("Event", "1")).toThrow(/FOREIGN KEY/); // now enforced, data kept
    expect(store.readOne("Inventory", "10")).toBeDefined();
    store.close();

    const { store: s2 } = open();
    s2.ensureResource("Event");
    s2.ensureResource("Inventory", { foreignKeys: [] });
    s2.insert("Inventory", "10", { id: 10, eventId: 777 }); // an orphan under the new pin
    expect(() =>
      s2.ensureResource("Inventory", { foreignKeys: [{ field: "eventId", references: "Event", onDelete: "restrict" }] }),
    ).toThrow(/Inventory/);
    s2.close();
  });

  it("wipe and removeByOrigin work across a restrict FK (children and parents go together)", () => {
    const store = withPolicy("restrict");
    store.insert("Event", "2", { id: 2 }, "generated");
    store.insert("Inventory", "11", { id: 11, eventId: 2 }, "generated");
    // Event 2 plus Inventory 10 and 11 — every generated row, parents and children together.
    expect(store.removeByOrigin("generated")).toBe(3);
    expect(store.list("Event").map((r) => r.identity)).toEqual(["1"]);
    store.wipe();
    expect(store.list("Event")).toHaveLength(0);
    store.close();
  });
});
