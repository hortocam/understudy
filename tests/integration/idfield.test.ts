/** `entities.<X>.idField` is not inert: live CRUD keys on it, exactly as the fixture layer does (constitution IX). */
import { afterEach, describe, expect, it } from "vitest";
import type { RunningMock } from "../../src/index.js";
import { fixturePath } from "../helpers/mock.js";
import { startProject } from "../helpers/project.js";
import { loadSpec } from "../../src/spec/load.js";
import { collectOperations } from "../../src/spec/operations.js";
import { deriveModel } from "../../src/spec/resources.js";

const mocks: RunningMock[] = [];
afterEach(async () => {
  await Promise.all(mocks.splice(0).map((m) => m.close()));
});

const OPS = ["GET /parts", "POST /parts", "GET /parts/{id}", "DELETE /parts/{id}"];

describe("entities.<X>.idField is wired through to the derived resource", () => {
  it("derivation: the pin replaces the instance-parameter identity and its facts follow the property", async () => {
    const loaded = await loadSpec(fixturePath("idfield-api.yaml"));
    const live = collectOperations(loaded.document);
    const plain = deriveModel(loaded.document, live, {}).resources[0];
    const pinned = deriveModel(loaded.document, live, { idFields: { Part: "sku" } }).resources[0];
    expect(plain?.idField).toBe("id");
    expect(pinned?.idField).toBe("sku");
    expect(pinned?.idType).toBe("string");
    expect(pinned?.idPattern).toBe("^SKU-[0-9]{8}$");
    expect(pinned?.idSpace).toBe("formatted");
    expect(pinned?.instanceParam).toBe("id");
  });

  it("live CRUD: a created record is addressed by the pinned field", async () => {
    const { mock } = await startProject({}, {
      spec: fixturePath("idfield-api.yaml"),
      operations: OPS,
      config: "entities:\n  Part: { idField: sku }\n",
    });
    mocks.push(mock);
    const post = await fetch(`${mock.baseUrl}/parts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sku: "SKU-00000042", name: "bolt" }),
    });
    expect(post.status).toBe(201);
    const { sku } = (await post.json()) as { sku: string };
    expect(sku).toMatch(/^SKU-[0-9]{8}$/);
    const get = await fetch(`${mock.baseUrl}/parts/${sku}`);
    expect(get.status).toBe(200);
    expect(((await get.json()) as { name: string }).name).toBe("bolt");
    expect(mock.store.listIdentities("Part")).toEqual([sku]);
    const del = await fetch(`${mock.baseUrl}/parts/${sku}`, { method: "DELETE" });
    expect(del.status).toBe(204);
  });
});
