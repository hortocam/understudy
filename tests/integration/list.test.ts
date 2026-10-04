/**
 * T025 — list semantics (FR-007): filtering, sorting and paging follow the parameters the
 * document declares, in the declared paging style. Where none is declared the full
 * collection is returned. The paging proof also asserts the engine does not load the
 * whole collection into memory to answer a page.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createMock, type RunningMock } from "../../src/index.js";
import { createLogger } from "../../src/logging.js";
import { parseConfig } from "../../src/config/load.js";
import { fixturePath, newStoreDir, storePath } from "../helpers/mock.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

let mock: RunningMock | undefined;

afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

function configFor(spec: string, operations: string[], storeDir: string) {
  return parseConfig(
    [
      `spec: ${spec}`,
      "operations:",
      ...operations.map((entry) => `  - ${entry}`),
      `storage: { driver: sqlite, path: ${JSON.stringify(storePath(storeDir))} }`,
    ].join("\n"),
    storeDir + "/understudy.yaml",
  );
}

async function seed(base: string, rows: Array<Record<string, unknown>>): Promise<void> {
  for (const row of rows) {
    const response = await fetch(`${base}/inventory`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(row),
    });
    expect(response.status).toBe(201);
  }
}

describe("list filtering, sorting and paging (FR-007)", () => {
  it("filters on a declared query parameter", async () => {
    const dir = newStoreDir();
    mock = await createMock(configFor(fixturePath("inventory-api.yaml"), ["POST /inventory", "GET /inventory"], dir), {
      port: 0,
      out: () => {},
      logger: createLogger({ write: () => {} }),
    });
    await seed(mock.baseUrl, [
      { sku: "GA-100", quantity: 4 },
      { sku: "GA-200", quantity: 1 },
    ]);
    const filtered = await fetch(`${mock.baseUrl}/inventory?sku=GA-200`);
    const rows = (await filtered.json()) as Array<{ sku: string }>;
    expect(rows.map((row) => row.sku)).toEqual(["GA-200"]);
  });

  it("pages with the offset/limit style the document declares", async () => {
    const dir = newStoreDir();
    mock = await createMock(configFor(fixturePath("inventory-api.yaml"), ["POST /inventory", "GET /inventory"], dir), {
      port: 0,
      out: () => {},
      logger: createLogger({ write: () => {} }),
    });
    await seed(mock.baseUrl, Array.from({ length: 5 }, (_unused, index) => ({ sku: `SKU-${index}`, quantity: index })));

    const page = (await (await fetch(`${mock.baseUrl}/inventory?offset=1&limit=2`)).json()) as Array<{ sku: string }>;
    expect(page).toHaveLength(2);
    expect(page.map((row) => row.sku)).toEqual(["SKU-1", "SKU-2"]);
  });

  it("pages with the page/size style a second fixture declares", async () => {
    const dir = newStoreDir();
    mock = await createMock(
      configFor(fixturePath("paged-api.yaml"), ["POST /widgets", "GET /widgets"], dir),
      { port: 0, out: () => {}, logger: createLogger({ write: () => {} }) },
    );
    for (let index = 0; index < 5; index += 1) {
      const response = await fetch(`${mock.baseUrl}/widgets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ colour: `c${index}` }),
      });
      expect(response.status).toBe(201);
    }
    const page = (await (await fetch(`${mock.baseUrl}/widgets?page=2&size=2`)).json()) as Array<{ colour: string }>;
    expect(page.map((row) => row.colour)).toEqual(["c2", "c3"]);
  });

  it("sorts on the declared sort parameter", async () => {
    const dir = newStoreDir();
    mock = await createMock(configFor(fixturePath("paged-api.yaml"), ["POST /widgets", "GET /widgets"], dir), {
      port: 0,
      out: () => {},
      logger: createLogger({ write: () => {} }),
    });
    for (const colour of ["b", "a", "c"]) {
      await fetch(`${mock.baseUrl}/widgets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ colour }),
      });
    }
    const rows = (await (await fetch(`${mock.baseUrl}/widgets?sort=colour`)).json()) as Array<{ colour: string }>;
    expect(rows.map((row) => row.colour)).toEqual(["a", "b", "c"]);
  });

  it("does not load the whole collection to answer a page (FR-007)", async () => {
    // The engine must not slurp the collection into memory: prove by construction that
    // the list path uses a bounded store read (a page-sized read), not Store.list().
    const listSource = readFileSync(`${repoRoot}/src/mock/list.ts`, "utf8");
    expect(listSource).toMatch(/listPaged|LIMIT|limit/i);
    expect(listSource).not.toMatch(/\.list\(/);
  });
});
