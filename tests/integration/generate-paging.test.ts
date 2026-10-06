/**
 * FR-015 / Amendment C: generation must be able to produce a dataset large enough to exercise the
 * document's DECLARED paging, and the count and the declared style must agree.
 *
 * Slice 1's list serves arrays and honours the client-supplied cursor (the identity of the last
 * record seen) — the measured target pages by query parameter, not by a response envelope — so a
 * "page carrying a continuation token" is reached by following the last identity.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { RunningMock } from "../../src/index.js";
import { fixturePath } from "../helpers/mock.js";
import { allOperations, startProject } from "../helpers/project.js";

const mocks: RunningMock[] = [];
afterEach(async () => {
  await Promise.all(mocks.splice(0).map((m) => m.close()));
});

async function paged(entities: string): Promise<RunningMock> {
  const spec = fixturePath("cursor-schema-api.yaml");
  const { mock } = await startProject(
    { "dynamic/p.yaml": `entities:\n${entities}` },
    { spec, operations: await allOperations(spec), config: "recipe: p\n" },
  );
  mocks.push(mock);
  return mock;
}

const get = async (m: RunningMock, path: string): Promise<Array<{ id: number }>> =>
  (await (await fetch(`${m.baseUrl}${path}`)).json()) as Array<{ id: number }>;

describe("generated collections exercise the declared paging (FR-015)", () => {
  it("a cursor-style collection larger than a page lists as pages: following the token enumerates EXACTLY `count` distinct records", async () => {
    const m = await paged("  CursorThing: { count: 120 }\n");
    expect(m.report.resources.find((r) => r.name === "CursorThing")?.pagingStyle).toBe("cursor-in-schema");
    const first = await get(m, "/cursor-things?maxPageSize=50");
    expect(first).toHaveLength(50);
    const seen = [...first];
    for (let guard = 0; guard < 10; guard += 1) {
      const last = seen[seen.length - 1] as { id: number };
      const page = await get(m, `/cursor-things?maxPageSize=50&paginationToken=${last.id}`);
      if (page.length === 0) break;
      seen.push(...page);
    }
    expect(seen).toHaveLength(120);
    expect(new Set(seen.map((r) => r.id)).size).toBe(120);
    expect(m.report.ambiguities.some((a) => a.kind === "paging-not-exercised" && a.subject === "CursorThing")).toBe(false);
  });

  it("NC target: a count below one page says `paging-not-exercised` instead of pretending paging was tested", async () => {
    const m = await paged("  CursorThing: { count: 30 }\n");
    const first = await get(m, "/cursor-things?maxPageSize=50");
    expect(first).toHaveLength(30); // everything fits one page: no continuation exists
    const last = first[first.length - 1] as { id: number };
    expect(await get(m, `/cursor-things?maxPageSize=50&paginationToken=${last.id}`)).toEqual([]);
    expect(m.report.ambiguities.find((a) => a.kind === "paging-not-exercised")?.subject).toBe("CursorThing");
  });

  it("offset/limit and page/size collections page by their own declared style", async () => {
    const m = await paged("  OffsetThing: { count: 25 }\n  PageThing: { count: 25 }\n");
    expect(await get(m, "/offset-things?limit=10&offset=20")).toHaveLength(5);
    expect(await get(m, "/offset-things?limit=10&offset=0")).toHaveLength(10);
    expect(await get(m, "/page-things?page=3&size=10")).toHaveLength(5);
    expect(await get(m, "/page-things?page=1&size=10")).toHaveLength(10);
    expect(m.report.resources.find((r) => r.name === "PageThing")?.pagingStyle).toBe("page-size");
  });

  it("a large collection that declares NO paging says so: the list returns the whole collection, and the report names it", async () => {
    const m = await paged("  PlainThing: { count: 150 }\n");
    expect(await get(m, "/plain-things")).toHaveLength(150);
    expect(m.report.ambiguities.find((a) => a.kind === "unpaged-large-collection")?.subject).toBe("PlainThing");
  });
});
