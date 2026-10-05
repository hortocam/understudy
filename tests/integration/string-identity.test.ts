/**
 * F-B (converge round 1, MEDIUM — FR-011) — a string identity with a declared `pattern` must
 * be allocated a value that satisfies it. data-model.md §"Identity allocation": a `string`
 * identity is "a value satisfying the declared `pattern` where present, else an opaque short
 * id, from the same reserved space". The bare stringified counter (`"100000"`) does not
 * satisfy `^W-[0-9]{6}$`.
 *
 * The declared pattern is read out of the document, not hard-coded, so the assertion tracks
 * the fixture rather than the implementation.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { RunningMock } from "../../src/index.js";
import { loadSpec } from "../../src/spec/load.js";
import { fixturePath, start } from "../helpers/mock.js";

let mock: RunningMock | undefined;

afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

async function declaredIdentityPattern(): Promise<string> {
  const loaded = await loadSpec(fixturePath("string-id-api.yaml"));
  const schema = ((loaded.document.components as Record<string, unknown>).schemas as Record<string, unknown>).Widget as Record<
    string,
    unknown
  >;
  const id = (schema.properties as Record<string, unknown>).id as Record<string, unknown>;
  if (typeof id.pattern !== "string") throw new Error("the fixture declares no identity pattern");
  return id.pattern;
}

describe("identity allocation satisfies the declared pattern (FR-011)", () => {
  it("allocates a string identity matching the document's declared pattern", async () => {
    const base = (mock = await start({ spec: fixturePath("string-id-api.yaml"), operations: ["createWidget", "readWidget"] }))
      .baseUrl;

    const response = await fetch(`${base}/widgets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ colour: "red" }),
    });
    expect(response.status).toBe(201);

    const body = (await response.json()) as { id: unknown };
    const pattern = await declaredIdentityPattern();
    expect(typeof body.id).toBe("string");
    expect(String(body.id)).toMatch(new RegExp(pattern));
    // The bare reserved counter is not a valid identity for this document.
    expect(body.id).not.toBe("100000");
  });

  it("allocates further identities that still satisfy the pattern and are readable back", async () => {
    const base = (mock = await start({ spec: fixturePath("string-id-api.yaml"), operations: ["createWidget", "readWidget"] }))
      .baseUrl;
    const pattern = await declaredIdentityPattern();

    const ids: string[] = [];
    for (const colour of ["red", "green", "blue"]) {
      const created = await fetch(`${base}/widgets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ colour }),
      });
      expect(created.status).toBe(201);
      const body = (await created.json()) as { id: string };
      expect(body.id).toMatch(new RegExp(pattern));
      ids.push(body.id);
    }
    expect(new Set(ids).size).toBe(ids.length);

    for (const [index, id] of ids.entries()) {
      const read = await fetch(`${base}/widgets/${id}`);
      expect(read.status).toBe(200);
      expect((await read.json()) as { colour: string }).toMatchObject({ colour: ["red", "green", "blue"][index] as string });
    }
  });
});

describe("F-E — an open-quantifier identity pattern never collides (UNIQUE 500 at create #11)", () => {
  it("creates 120 records under ^W-[0-9]+$, all unique and matching, with NO unsupported-pattern ambiguity", async () => {
    mock = await start({ spec: fixturePath("open-quantifier-api.yaml"), operations: ["createWidget", "getWidget"] });
    expect(mock.report.ambiguities.filter((a) => a.kind === "identity-pattern-unsupported")).toEqual([]);
    const ids: string[] = [];
    for (let i = 0; i < 120; i += 1) {
      const response = await fetch(`${mock.baseUrl}/widgets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: `w${i}` }),
      });
      expect(response.status, `create #${i + 1}`).toBe(201);
      ids.push(((await response.json()) as { id: string }).id);
    }
    expect(new Set(ids).size).toBe(120);
    expect(ids.every((id) => /^W-[0-9]+$/.test(id))).toBe(true);
  });
});
