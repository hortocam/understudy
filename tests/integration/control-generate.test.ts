/**
 * FR-021 (constitution II): generation is a control-API operation; `POST /generate` applies a named
 * recipe to a RUNNING mock and answers, by collection and origin, what it created. The answer is
 * validated against the checked-in contract — the contract, not the implementation, is the judge.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsDefault from "ajv-formats";
import { afterEach, describe, expect, it } from "vitest";
import type { RunningMock } from "../../src/index.js";
import { startGen } from "../helpers/project.js";

const addFormats = addFormatsDefault as unknown as (ajv: unknown) => void;
const contract = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../specs/002-data-layer/contracts/control-api.openapi.json", import.meta.url)), "utf8"),
) as Record<string, unknown>;
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(contract, "contract");
const validator = (name: string) => ajv.getSchema(`contract#/components/schemas/${name}`) as ReturnType<typeof ajv.compile>;

interface GenerateBody {
  ok: boolean;
  recipe: string;
  seed: number;
  regenerated: boolean;
  clock: { mode: string; pinned: boolean };
  created: Record<string, Record<string, number>>;
  counts: Record<string, Record<string, number>>;
  provenance: Record<string, Record<string, Record<string, number>>>;
}

const mocks: RunningMock[] = [];
afterEach(async () => {
  await Promise.all(mocks.splice(0).map((m) => m.close()));
});

const json = { "content-type": "application/json" };

async function running(): Promise<{ mock: RunningMock; url: string }> {
  const { mock } = await startGen(undefined); // fixtures only: no recipe applied yet
  mocks.push(mock);
  return { mock, url: `${mock.controlUrl}${mock.controlPrefix}` };
}

describe("POST /generate (FR-021)", () => {
  it("applies the named recipe to a running mock and reports counts by collection and origin, per the contract", async () => {
    const { mock, url } = await running();
    expect(mock.store.countByOrigin().Venue).toEqual({ static: 2 });
    const response = await fetch(`${url}/generate`, { method: "POST", headers: json, body: JSON.stringify({ recipe: "ci-small" }) });
    expect(response.status).toBe(200);
    const body = (await response.json()) as GenerateBody;
    const validate = validator("GenerateResult");
    expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
    expect(body).toMatchObject({ ok: true, recipe: "ci-small", seed: 42, regenerated: true });
    expect(body.created.Venue).toEqual({ generated: 3 });
    expect(body.counts.Venue).toEqual({ static: 2, generated: 3 });
    expect(body.clock).toMatchObject({ mode: "real", pinned: true });
    expect(body.provenance.Inventory?.price).toEqual({ "1": expect.any(Number) });
    // the running mock now serves the generated records
    const venues = (await (await fetch(`${mock.baseUrl}/venues`)).json()) as unknown[];
    expect(venues).toHaveLength(5);
  });

  it("an explicit seed overrides the recipe's, and the same call twice is a declared no-op that says so (D7)", async () => {
    const { url } = await running();
    const first = (await (await fetch(`${url}/generate`, { method: "POST", headers: json, body: JSON.stringify({ recipe: "ci-small", seed: 9 }) })).json()) as GenerateBody;
    expect(first.seed).toBe(9);
    const again = (await (await fetch(`${url}/generate`, { method: "POST", headers: json, body: JSON.stringify({ recipe: "ci-small", seed: 9 }) })).json()) as GenerateBody;
    expect(again.regenerated).toBe(false);
    expect(again.created).toEqual({});
    expect(validator("GenerateResult")(again)).toBe(true);
  });

  it("a different seed on a populated store is a declared 409 naming the mismatch", async () => {
    const { url } = await running();
    await fetch(`${url}/generate`, { method: "POST", headers: json, body: JSON.stringify({ recipe: "ci-small", seed: 9 }) });
    const response = await fetch(`${url}/generate`, { method: "POST", headers: json, body: JSON.stringify({ recipe: "ci-small", seed: 10 }) });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string; message: string };
    expect(validator("ControlError")(body)).toBe(true);
    expect(body.message).toContain("seed");
    expect(body.message).toContain("reset --to wipe");
  });

  it("an unknown recipe is the declared 4xx ControlError naming it and listing the available ones", async () => {
    const { url } = await running();
    const response = await fetch(`${url}/generate`, { method: "POST", headers: json, body: JSON.stringify({ recipe: "ci-smal" }) });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string; message: string; field?: string };
    expect(validator("ControlError")(body)).toBe(true);
    expect(body.error).toBe("unknown_recipe");
    expect(body.message).toContain("ci-smal");
    expect(body.message).toContain("ci-small");
  });

  it("a malformed body is the declared 400; an omitted recipe with none configured is a 404, not a crash", async () => {
    const { url } = await running();
    expect((await fetch(`${url}/generate`, { method: "POST", headers: json, body: "{nope" })).status).toBe(400);
    expect((await fetch(`${url}/generate`, { method: "POST", headers: json, body: JSON.stringify({ seed: "x" }) })).status).toBe(400);
    expect((await fetch(`${url}/generate`, { method: "POST", headers: json, body: JSON.stringify({ bogus: 1 }) })).status).toBe(400);
    const none = await fetch(`${url}/generate`, { method: "POST", headers: json, body: "{}" });
    expect(none.status).toBe(404);
  });

  it("a recipe whose invariant cannot hold is a declared 422 naming the rule, and stores nothing", async () => {
    const { mock, url } = await running();
    const response = await fetch(`${url}/generate`, { method: "POST", headers: json, body: JSON.stringify({ recipe: "impossible" }) });
    expect(response.status).toBe(422);
    const body = (await response.json()) as { message: string };
    expect(body.message).toContain("price > 1000000");
    expect(mock.store.countByOrigin().Venue).toEqual({ static: 2 });
  });

  it("is a control operation: never routed into the mocked surface, and it appears in the served contract", async () => {
    const { mock, url } = await running();
    const served = (await (await fetch(`${url}/openapi.json`)).json()) as { paths: Record<string, unknown> };
    expect(Object.keys(served.paths)).toContain("/generate");
    await fetch(`${url}/generate`, { method: "POST", headers: json, body: JSON.stringify({ recipe: "ci-small" }) });
    expect(mock.store.listRequests().some((r) => r.path.includes("generate"))).toBe(false); // the request log covers the mocked surface only
  });

  it("a scoped reset that would orphan referencing records is the declared 400 naming both, not a 500", async () => {
    const { mock, url } = await running();
    await fetch(`${url}/generate`, { method: "POST", headers: json, body: JSON.stringify({ recipe: "ci-small" }) });
    const reset = await fetch(`${url}/reset`, { method: "POST", headers: json, body: JSON.stringify({ entities: ["Venue"] }) });
    expect(reset.status).toBe(400);
    expect(((await reset.json()) as { message: string }).message).toMatch(/Venue/);
    expect(mock.store.countByOrigin().Venue?.generated).toBe(3); // nothing was half-reset
  });
});
