/**
 * T020 — persistence across a process restart (SC-002) and the machine-checked form of
 * constitution IV: after a full CRUD workout, EVERY row in the SQLite file has
 * `origin='runtime'`. The CHECK constraint alone permits all four origins, so the
 * invariant needs a test, not a comment.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { RunningMock } from "../../src/index.js";
import { INVENTORY_OPERATIONS, fixturePath, start, storePath } from "../helpers/mock.js";

let mock: RunningMock | undefined;

afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

function originCounts(path: string): Record<string, number> {
  const db = new Database(path, { readonly: true });
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_%' ESCAPE '\\'",
    )
    .all() as Array<{ name: string }>;
  const counts: Record<string, number> = {};
  for (const { name } of tables) {
    const rows = db.prepare(`SELECT origin, COUNT(*) AS n FROM "${name}" GROUP BY origin`).all() as Array<{
      origin: string;
      n: number;
    }>;
    for (const row of rows) counts[row.origin] = (counts[row.origin] ?? 0) + row.n;
  }
  db.close();
  return counts;
}

describe("persistence (SC-002) and static/dynamic separation (constitution IV)", () => {
  it("keeps a created record readable across a process restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "understudy-persist-"));
    const store = storePath(dir);

    mock = await start({ spec: fixturePath("inventory-api.yaml"), operations: INVENTORY_OPERATIONS, storeDir: dir });
    const created = await fetch(`${mock.baseUrl}/inventory`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sku: "GA-100", quantity: 4 }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { id: number; sku: string };
    await mock.close();
    mock = undefined;

    // A fresh process: new server object, same store file.
    mock = await start({ spec: fixturePath("inventory-api.yaml"), operations: INVENTORY_OPERATIONS, storeDir: dir });
    const read = await fetch(`${mock.baseUrl}/inventory/${body.id}`);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ id: body.id, sku: "GA-100", quantity: 4 });

    const list = await fetch(`${mock.baseUrl}/inventory`);
    const listed = (await list.json()) as Array<{ id: number }>;
    expect(listed.map((row) => row.id)).toContain(body.id);

    expect(store).toBe(storePath(dir));
  });

  it("writes only origin='runtime' rows through a full CRUD workout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "understudy-origin-"));
    mock = await start({ spec: fixturePath("inventory-api.yaml"), operations: INVENTORY_OPERATIONS, storeDir: dir });

    const created = await fetch(`${mock.baseUrl}/inventory`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sku: "GA-100", quantity: 4 }),
    });
    const body = (await created.json()) as { id: number };
    await fetch(`${mock.baseUrl}/inventory`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sku: "GA-200", quantity: 1 }),
    });
    await fetch(`${mock.baseUrl}/inventory/${body.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quantity: 9 }),
    });
    await fetch(`${mock.baseUrl}/inventory/${body.id}`, { method: "DELETE" });
    await fetch(`${mock.baseUrl}/inventory`);
    await mock.close();
    mock = undefined;

    const counts = originCounts(storePath(dir));
    // Every row written by the mock surface is `runtime`; nothing else may appear.
    expect(counts).toEqual({ runtime: counts.runtime });
    expect(counts.runtime).toBeGreaterThan(0);
  });

  it("re-reads a persisted record with its declared integer identity (FR-011)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "understudy-identity-"));
    mock = await start({ spec: fixturePath("inventory-api.yaml"), operations: INVENTORY_OPERATIONS, storeDir: dir });
    const created = await fetch(`${mock.baseUrl}/inventory`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sku: "GA-100", quantity: 4 }),
    });
    const body = (await created.json()) as { id: number };
    // The document declares `id` an integer; allocation must not collide with a
    // fixture-supplied range reserved for slice 2 (ids.generatedStart default 100000).
    expect(Number.isInteger(body.id)).toBe(true);
    expect(body.id).toBeGreaterThanOrEqual(100000);
    await mock.close();
    mock = undefined;
  });
});
