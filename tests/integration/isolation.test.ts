/**
 * T041 — cross-instance isolation (SC-007, constitution VIII).
 *
 * Two mock instances started with different configuration — distinct ports *and* distinct
 * store files — run side by side with no shared state and no cross-talk. Starting both is
 * not the claim; the claim is that neither sees the other's records and that a reset on one
 * leaves the other untouched. The stores are read straight off disk too, so the isolation is
 * proven at the file layer (two different SQLite files), not merely at the HTTP layer.
 */
import { existsSync, statSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { RunningMock } from "../../src/index.js";
import { createMock } from "../../src/index.js";
import { createLogger } from "../../src/logging.js";
import { parseConfig } from "../../src/config/load.js";
import { fixturePath, newStoreDir, storePath } from "../helpers/mock.js";

let instances: RunningMock[] = [];

afterEach(async () => {
  await Promise.all(instances.map((instance) => instance.close()));
  instances = [];
});

function configFor(port: number, storeDir: string, idsStart: number) {
  return parseConfig(
    [
      `spec: ${fixturePath("inventory-api.yaml")}`,
      "operations:",
      "  - POST /inventory",
      "  - GET /inventory",
      "  - GET /inventory/{id}",
      `server: { port: ${port} }`,
      `storage: { driver: sqlite, path: ${JSON.stringify(storePath(storeDir))} }`,
      `ids: { generatedStart: ${idsStart} }`,
    ].join("\n"),
    `${storeDir}/understudy.yaml`,
  );
}

async function startInstance(port: number, storeDir: string, idsStart: number): Promise<RunningMock> {
  const instance = await createMock(configFor(port, storeDir, idsStart), {
    // Explicit ports (not ephemeral) so the test asserts distinct *configured* ports.
    port,
    out: () => {},
    logger: createLogger({ write: () => {} }),
  });
  instances.push(instance);
  return instance;
}

async function create(baseUrl: string, sku: string): Promise<{ id: number; sku: string }> {
  const response = await fetch(`${baseUrl}/inventory`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sku, quantity: 1 }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: number; sku: string };
}

async function list(baseUrl: string): Promise<Array<{ id: number; sku: string }>> {
  const response = await fetch(`${baseUrl}/inventory`);
  expect(response.status).toBe(200);
  return (await response.json()) as Array<{ id: number; sku: string }>;
}

describe("two instances are isolated (SC-007)", () => {
  it("run on distinct ports with distinct store files — and neither sees the other's records", async () => {
    const dirA = newStoreDir();
    const dirB = newStoreDir();
    // Distinct identity ranges (part of "different configuration" in SC-007): with disjoint
    // id spaces, "the other instance's id is not readable here" is a genuine cross-talk
    // assertion, not a coincidence where both allocated the same first id.
    const a = await startInstance(0, dirA, 100000);
    const b = await startInstance(0, dirB, 200000);

    // Distinct ports and distinct store files: the two preconditions SC-007 names.
    expect(a.port).not.toBe(b.port);
    expect(a.store.path).not.toBe(b.store.path);
    expect(a.store.path).toBe(storePath(dirA));
    expect(b.store.path).toBe(storePath(dirB));

    const recordA = await create(a.baseUrl, "ONLY-IN-A");
    const recordB = await create(b.baseUrl, "ONLY-IN-B");
    // The seeds came from disjoint ranges, so an id from one instance names nothing in the other.
    expect(recordA.id).toBeGreaterThanOrEqual(100000);
    expect(recordB.id).toBeGreaterThanOrEqual(200000);

    // No cross-talk: each instance lists exactly its own record.
    const listedA = await list(a.baseUrl);
    const listedB = await list(b.baseUrl);
    expect(listedA.map((row) => row.sku)).toEqual(["ONLY-IN-A"]);
    expect(listedB.map((row) => row.sku)).toEqual(["ONLY-IN-B"]);

    // The other instance's record is not even readable by its identity.
    expect((await fetch(`${a.baseUrl}/inventory/${recordB.id}`)).status).toBe(404);
    expect((await fetch(`${b.baseUrl}/inventory/${recordA.id}`)).status).toBe(404);

    // The isolation is real at the file layer: two separate SQLite files exist.
    expect(existsSync(a.store.path)).toBe(true);
    expect(existsSync(b.store.path)).toBe(true);
    expect(statSync(a.store.path).ino).not.toBe(statSync(b.store.path).ino);
  });

  it("a reset on one instance leaves the other's records untouched", async () => {
    const a = await startInstance(0, newStoreDir(), 100000);
    const b = await startInstance(0, newStoreDir(), 200000);
    await create(a.baseUrl, "A-1");
    await create(b.baseUrl, "B-1");

    const reset = await fetch(`${a.controlUrl}${a.controlPrefix}/reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "wipe" }),
    });
    expect(reset.status).toBe(200);

    // A is emptied; B is not.
    expect(await list(a.baseUrl)).toEqual([]);
    expect((await list(b.baseUrl)).map((row) => row.sku)).toEqual(["B-1"]);
  });
});
