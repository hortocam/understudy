/**
 * US6 / Scenario 4 (FR-017, FR-018, SC-006): identities that cannot collide, across the four
 * identity spaces one document can mix. Generation joins these assertions in the generation suites.
 */
import { afterEach, describe, expect, it } from "vitest";
import { ConfigRefusedError } from "../../src/errors.js";
import type { RunningMock } from "../../src/index.js";
import { fixturePath } from "../helpers/mock.js";
import { allOperations, startProject } from "../helpers/project.js";

let mock: RunningMock | undefined;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

const SPACES = fixturePath("spaces-api.yaml");
const json = { "content-type": "application/json" };

async function spaces(files: Record<string, string> = {}, config = "", out?: string[]): Promise<RunningMock> {
  const started = await startProject(files, {
    spec: SPACES,
    operations: await allOperations(SPACES),
    config,
    ...(out ? { mock: { out: (t: string) => out.push(t) } } : {}),
  });
  return started.mock;
}

describe("the report says which space each collection's identity lives in, and its range", () => {
  it("lists integer, uuid, formatted and opaque spaces; the opaque one is flagged, not guessed", async () => {
    const out: string[] = [];
    mock = await spaces({}, "", out);
    const text = out.join("\n");
    expect(text).toContain("identity ranges");
    expect(text).toMatch(/BigInt: integer — reserved 100000\.\./);
    expect(text).toMatch(/UuidThing: uuid — reserved 00000000\.\.ffffffff/);
    expect(text).toMatch(/Formatted: formatted — reserved EVT-100000\.\./);
    expect(text).toMatch(/Opaque: opaque — no range can be reserved/);
    expect(mock.store.readRange("Formatted")).toMatchObject({ idSpace: "formatted", reserved: "EVT-100000..", next: "100000" });
  });
});

describe("overlapping ranges refuse to start, naming the collection (US6.2, SC-006)", () => {
  it("an integer fixture at or above the generated start", async () => {
    await expect(spaces({ "static/entities/big.yaml": "entity: BigInt\nrows:\n  - { id: 100500, name: Big }\n" })).rejects.toThrow(/BigInt/);
  });

  it("a formatted fixture inside the configured span", async () => {
    const error = await spaces(
      { "static/entities/f.yaml": "entity: Formatted\nrows:\n  - { id: EVT-100500, name: Inside }\n" },
      "entities:\n  Formatted:\n    ids: { reserved: 'EVT-100000..EVT-199999' }\n",
    ).catch((e) => e as Error);
    expect(error).toBeInstanceOf(ConfigRefusedError);
    expect((error as Error).message).toContain("Formatted");
    expect((error as Error).message).toContain("EVT-100500");
    expect((error as Error).message).not.toMatch(/\bat .*\.ts:\d+/); // a message, not a stack trace
  });

  it("a uuid fixture inside the configured leading-hex span", async () => {
    const error = await spaces(
      { "static/entities/u.yaml": "entity: UuidThing\nrows:\n  - { id: a1234567-0000-4000-8000-000000000000, name: Inside }\n" },
      "entities:\n  UuidThing:\n    ids: { reserved: 'a0000000..afffffff' }\n",
    ).catch((e) => e as Error);
    expect((error as Error).message).toContain("UuidThing");
  });

  it("a span on an opaque space, or an integer start on a string space, contradicts the document", async () => {
    await expect(spaces({}, "entities:\n  Opaque:\n    ids: { reserved: 'a..b' }\n")).rejects.toThrow(/Opaque/);
    await expect(spaces({}, "entities:\n  Formatted:\n    ids: { generatedStart: 5 }\n")).rejects.toThrow(/Formatted/);
  });
});

describe("API-written identities are in the declared form and cannot collide with fixtures (US6.4, FR-018)", () => {
  it("creates identities in each space's declared form; none equals a fixture identity", async () => {
    mock = await spaces({
      "static/entities/f.yaml": "entity: Formatted\nrows:\n  - { id: EVT-000001, name: Fixture }\n",
      "static/entities/u.yaml": "entity: UuidThing\nrows:\n  - { id: 11111111-1111-4111-8111-111111111111, name: Fixture }\n",
    });
    const base = mock.baseUrl;
    const make = async (path: string): Promise<string> => {
      const r = await fetch(`${base}${path}`, { method: "POST", headers: json, body: JSON.stringify({ name: "Runtime" }) });
      expect(r.status).toBe(201);
      return String(((await r.json()) as { id: unknown }).id);
    };
    for (let i = 0; i < 5; i += 1) {
      expect(await make("/formatted")).toMatch(/^EVT-[0-9]{6}$/);
      expect(await make("/uuids")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(Number(await make("/big-ints"))).toBeGreaterThanOrEqual(100000);
    }
    for (const resource of ["Formatted", "UuidThing"]) {
      const ids = mock.store.listIdentities(resource);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toHaveLength(6);
    }
  });

  it("an identity range declared per collection starts where configured (entity start wins over the global one)", async () => {
    mock = await spaces({}, "entities:\n  BigInt:\n    ids: { generatedStart: 500000 }\n");
    const created = await fetch(`${mock.baseUrl}/big-ints`, { method: "POST", headers: json, body: JSON.stringify({ name: "Runtime" }) });
    expect(((await created.json()) as { id: number }).id).toBe(500000);
  });
});
