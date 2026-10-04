/**
 * F-C (converge round 1, MEDIUM — FR-007) — a cursor-style paging document (the shape
 * docs/05-target-apis.md §1 measures on the target: an opaque cursor token plus a size cap).
 *
 * The defects: a cursor declared WITHOUT a companion limit fell through to "no paging" (and,
 * when the cursor name was misclassified as a filter, answered `[]` — data loss); and with a
 * limit the token was dropped, so `cursor=<id>&limit=n` equalled `limit=n`. The cursor is
 * honoured as an opaque start-after marker over the collection's order, and a token naming no
 * record answers the operation's declared client error rather than silently returning nothing.
 *
 * The cursor parameter's spelling is read from the document, not hard-coded, so the test
 * tracks the fixture (and the target API's `paginationToken`).
 */
import { afterEach, describe, expect, it } from "vitest";
import { NOT_IMPLEMENTED } from "../../src/mock/errors.js";
import type { RunningMock } from "../../src/index.js";
import { loadSpec } from "../../src/spec/load.js";
import { fixturePath, start } from "../helpers/mock.js";

let mock: RunningMock | undefined;

afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

const CURSOR_OPERATIONS = ["listItems", "createItem", "readItem"] as const;

/** The cursor parameter's declared spelling, so the test follows the document. */
async function declaredCursorParam(): Promise<string> {
  const loaded = await loadSpec(fixturePath("cursor-api.yaml"));
  const get = ((loaded.document.paths as Record<string, unknown>)["/items"] as Record<string, unknown>).get as Record<
    string,
    unknown
  >;
  const parameters = get.parameters as Array<{ name: string; in: string }>;
  const cursor = parameters.find((parameter) => parameter.in === "query" && /token|cursor/i.test(parameter.name));
  if (!cursor) throw new Error("the fixture declares no cursor parameter");
  return cursor.name;
}

async function seedItems(count: number): Promise<Array<{ id: number; name: string }>> {
  const base = (mock as RunningMock).baseUrl;
  const created: Array<{ id: number; name: string }> = [];
  for (let index = 0; index < count; index += 1) {
    const response = await fetch(`${base}/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: `n${index}` }),
    });
    expect(response.status).toBe(201);
    created.push((await response.json()) as { id: number; name: string });
  }
  return created;
}

async function list(query: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${(mock as RunningMock).baseUrl}/items${query}`);
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? (JSON.parse(text) as unknown) : undefined };
}

describe("cursor paging (FR-007)", () => {
  it("moves the window to start after the token, not back to the beginning", async () => {
    mock = await start({ spec: fixturePath("cursor-api.yaml"), operations: CURSOR_OPERATIONS });
    const created = await seedItems(5);
    const token = await declaredCursorParam();
    const anchor = created[1]?.id as number;

    const page = await list(`?${token}=${anchor}&limit=2`);
    expect(page.status).toBe(200);
    expect((page.body as Array<{ id: number }>).map((row) => row.id)).toEqual([created[2]?.id, created[3]?.id]);

    // The token alone is the tail from that point, not the whole collection and not `[]`.
    const tail = await list(`?${token}=${anchor}`);
    expect((tail.body as Array<{ id: number }>).map((row) => row.id)).toEqual([
      created[2]?.id,
      created[3]?.id,
      created[4]?.id,
    ]);
  });

  it("does not answer an empty collection when the document declares a cursor without a limit", async () => {
    mock = await start({ spec: fixturePath("cursor-api.yaml"), operations: CURSOR_OPERATIONS });
    const created = await seedItems(3);
    const token = await declaredCursorParam();

    const noToken = await list("");
    expect((noToken.body as Array<{ id: number }>).map((row) => row.id)).toEqual(created.map((row) => row.id));

    const firstAsToken = await list(`?${token}=${created[0]?.id}&limit=2`);
    expect((firstAsToken.body as Array<{ id: number }>).map((row) => row.id)).toEqual([created[1]?.id, created[2]?.id]);
  });

  it("answers the declared client error for a cursor that names no record", async () => {
    mock = await start({ spec: fixturePath("cursor-api.yaml"), operations: CURSOR_OPERATIONS });
    await seedItems(3);
    const token = await declaredCursorParam();

    const response = await fetch(`${mock.baseUrl}/items?${token}=___definitely_unknown___`);
    // cursor-api.yaml declares a 400 for an unrecognised cursor; a silent `[]` or the full
    // collection would both be data loss dressed up as success.
    expect(response.status).toBe(400);
    expect(response.status).not.toBe(NOT_IMPLEMENTED);
    const body = (await response.json()) as Record<string, unknown>;
    expect(typeof body.error).toBe("string");
    expect(typeof body.message).toBe("string");
  });

  it("treats the target API's cursor name as paging, not as a filter", async () => {
    // docs/05-target-apis.md §1: the measured cursor parameter on the target is a token
    // (`paginationToken`, ×21). Misclassifying it as a filter makes a conforming client's
    // page request answer `[]` instead of the next window.
    mock = await start({ spec: fixturePath("cursor-api.yaml"), operations: CURSOR_OPERATIONS });
    const created = await seedItems(3);
    const token = await declaredCursorParam();

    const declared = mock.report.resources[0]?.listParams.find((param) => param.name === token);
    expect(declared?.kind).toBe("paging");

    const page = await list(`?${token}=${created[0]?.id}&limit=1`);
    expect((page.body as Array<{ id: number }>).map((row) => row.id)).toEqual([created[1]?.id]);
  });

  /**
   * F-D (converge round 2, HIGH — FR-007): a cursor request that ALSO carries the document's
   * declared sort mis-bound the store's SQL placeholders (filter/sort groups swapped, sort
   * values duplicated), answering an undeclared 500. A conforming client combining the
   * declared cursor with the declared sort is the shape one request away from the fixture; the
   * cursor tests above declare no sort, so the suite was blind to it. These assert row CONTENT
   * under the sort, not just the status — a partial fix that only drops a duplicated spread
   * silently mis-binds (a filter value lands on `json_extract`'s path argument).
   */
  async function seedTyped(rows: Array<{ name: string; group: string }>): Promise<Array<{ id: number; name: string }>> {
    const base = (mock as RunningMock).baseUrl;
    const created: Array<{ id: number; name: string }> = [];
    for (const row of rows) {
      const response = await fetch(`${base}/items`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(row),
      });
      expect(response.status).toBe(201);
      created.push((await response.json()) as { id: number; name: string });
    }
    return created;
  }

  it("moves the cursor window under the document's declared sort", async () => {
    mock = await start({ spec: fixturePath("cursor-api.yaml"), operations: CURSOR_OPERATIONS });
    const token = await declaredCursorParam();
    // Deliberately not insertion order, so a window that ignores the sort is distinguishable.
    const created = await seedTyped([
      { name: "delta", group: "A" },
      { name: "alpha", group: "B" },
      { name: "charlie", group: "A" },
      { name: "bravo", group: "A" },
      { name: "echo", group: "A" },
    ]);
    const charlie = created[2] as { id: number };

    // sort=name ascending -> alpha, bravo, charlie, delta, echo; the window after charlie is
    // delta then echo.
    const page = await list(`?sort=name&limit=2&${token}=${charlie.id}`);
    expect(page.status).toBe(200);
    expect((page.body as Array<{ name: string }>).map((row) => row.name)).toEqual(["delta", "echo"]);
  });

  it("moves the cursor window under a declared filter, sort and cursor together", async () => {
    mock = await start({ spec: fixturePath("cursor-api.yaml"), operations: CURSOR_OPERATIONS });
    const token = await declaredCursorParam();
    const created = await seedTyped([
      { name: "delta", group: "A" },
      { name: "alpha", group: "B" },
      { name: "charlie", group: "A" },
      { name: "bravo", group: "A" },
      { name: "echo", group: "A" },
    ]);
    const charlie = created[2] as { id: number };

    // group=A filters out alpha (B); sort=name orders bravo, charlie, delta, echo; the window
    // after charlie is delta then echo. Content is asserted so a swapped/mis-counted binding
    // (a filter value landing on a json path argument) is caught, not masked by a 200.
    const page = await list(`?group=A&sort=name&limit=2&${token}=${charlie.id}`);
    expect(page.status).toBe(200);
    const rows = page.body as Array<{ name: string; group: string }>;
    expect(rows.map((row) => row.name)).toEqual(["delta", "echo"]);
    expect(rows.every((row) => row.group === "A")).toBe(true);
  });
});
