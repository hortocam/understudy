/**
 * T019 — the SC-003 contract suite.
 *
 * Every request is driven over real HTTP against a running mock, and every response is
 * asserted against `tests/fixtures/inventory-api.yaml`: status codes and body shapes are
 * the document's, not the implementation's. Zero unexpected status codes is the pass bar.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { RunningMock } from "../../src/index.js";
import { INVENTORY_OPERATIONS, fixturePath, start } from "../helpers/mock.js";

let mock: RunningMock | undefined;

afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

async function startInventory(): Promise<string> {
  mock = await start({ spec: fixturePath("inventory-api.yaml"), operations: INVENTORY_OPERATIONS });
  return mock.baseUrl;
}

async function json(response: Response): Promise<unknown> {
  const text = await response.text();
  return text.length > 0 ? (JSON.parse(text) as unknown) : undefined;
}

describe("contract: inventory-api.yaml (SC-003)", () => {
  it("serves create, read-one, list, update and delete with the document's own statuses", async () => {
    const base = await startInventory();

    const created = await fetch(`${base}/inventory`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sku: "GA-100", quantity: 4 }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await json(created)) as { id: number; sku: string; quantity: number };
    // The document declares id as an integer; the mock must render it as one (FR-009).
    expect(typeof createdBody.id).toBe("number");
    expect(createdBody.id).toBeGreaterThanOrEqual(100000);
    expect(createdBody).toMatchObject({ sku: "GA-100", quantity: 4 });

    const read = await fetch(`${base}/inventory/${createdBody.id}`);
    expect(read.status).toBe(200);
    expect(await json(read)).toEqual(createdBody);

    const list = await fetch(`${base}/inventory`);
    expect(list.status).toBe(200);
    const listed = (await json(list)) as Array<{ id: number }>;
    expect(listed.map((row) => row.id)).toContain(createdBody.id);

    const patched = await fetch(`${base}/inventory/${createdBody.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quantity: 7 }),
    });
    expect(patched.status).toBe(200);
    // PATCH merges: sku survives, quantity changes (FR-006).
    expect(await json(patched)).toEqual({ ...createdBody, quantity: 7 });

    const removed = await fetch(`${base}/inventory/${createdBody.id}`, { method: "DELETE" });
    expect(removed.status).toBe(204);

    const gone = await fetch(`${base}/inventory/${createdBody.id}`);
    expect(gone.status).toBe(404);
    const goneBody = (await json(gone)) as { error: string; message: string };
    expect(typeof goneBody.error).toBe("string");
    expect(typeof goneBody.message).toBe("string");
  });

  it("rejects an invalid body with the document's declared error, not a 200 or a 500 (FR-008)", async () => {
    const base = await startInventory();

    const response = await fetch(`${base}/inventory`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sku: "GA-100", quantity: "lots" }),
    });

    expect(response.status).toBe(400);
    const body = (await json(response)) as { error: string; message: string };
    expect(typeof body.error).toBe("string");
    expect(typeof body.message).toBe("string");
  });

  it("rejects a missing required field with the declared 400", async () => {
    const base = await startInventory();
    const response = await fetch(`${base}/inventory`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quantity: 4 }),
    });
    expect(response.status).toBe(400);
  });

  it("never answers a selected operation with an unexpected status code", async () => {
    const base = await startInventory();
    const allowed = new Set([200, 201, 204, 400, 404]);

    const requests: Array<() => Promise<Response>> = [
      () => fetch(`${base}/inventory`),
      () => fetch(`${base}/inventory`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
      () => fetch(`${base}/inventory/1`),
      () => fetch(`${base}/inventory/1`, { method: "PATCH", headers: { "content-type": "application/json" }, body: "{}" }),
      () => fetch(`${base}/inventory/1`, { method: "DELETE" }),
    ];
    for (const issue of requests) {
      const response = await issue();
      expect(allowed.has(response.status), `unexpected status ${response.status}`).toBe(true);
    }
  });
});
