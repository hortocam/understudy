/**
 * FR-017 / FR-018 / SC-006 — identities that cannot collide, across the four identity spaces the
 * measured target mixes within ONE document (integer, uuid, prefixed/formatted string, opaque).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { IdentityAllocator, planIdentity } from "../../src/data/identity.js";
import { createStream } from "../../src/data/seed.js";
import { IdentitySpaceExhaustedError } from "../../src/errors.js";
import { allocateIdentity } from "../../src/spec/identity.js";
import type { Resource } from "../../src/spec/types.js";
import { createSqliteStore } from "../../src/store/sqlite.js";
import type { Store } from "../../src/store/index.js";
import { REF_DATE, resourceOf } from "../helpers/env.js";

function store(): Store {
  const s = createSqliteStore({ path: join(mkdtempSync(join(tmpdir(), "understudy-idr-")), "s.db") });
  s.open();
  return s;
}

const integer = (name = "Event"): Resource => ({ ...resourceOf(name, {}), idType: "integer", idSpace: "integer" });
const uuid = (name = "Group"): Resource => ({ ...resourceOf(name, {}), idType: "string", idSpace: "uuid" });
const formatted = (name = "Ticket", pattern = "^EVT-[0-9]{6}$"): Resource => ({ ...resourceOf(name, {}), idType: "string", idSpace: "formatted", idPattern: pattern });
const opaque = (name = "Thing"): Resource => ({ ...resourceOf(name, {}), idType: "string", idSpace: "opaque" });

function allocator(s: Store, resource: Resource, entity: Parameters<typeof planIdentity>[0]["entity"], fixtureIds: string[] = [], seed = 42) {
  const { plan, refusals } = planIdentity({ resource, ...(entity ? { entity } : {}), globalStart: 100000, fixtureIds });
  return { plan, refusals, alloc: new IdentityAllocator({ store: s, resource, plan, stream: createStream(seed, resource.name, REF_DATE) }) };
}

describe("integer space", () => {
  it("allocates from the reserved start, and persists the cursor in _id_ranges", () => {
    const s = store();
    const { alloc, plan } = allocator(s, integer(), undefined);
    expect([alloc.next(), alloc.next(), alloc.next()]).toEqual(["100000", "100001", "100002"]);
    alloc.commit();
    expect(plan.space).toBe("integer");
    expect(s.readRange("Event")).toBeUndefined(); // reserving is the caller's startup step; commit only advances an existing range
    s.reserveRange({ resource: "Event", idSpace: "integer", declared: plan.declared, reserved: plan.reserved, next: "100000" });
    const again = allocator(s, integer(), undefined).alloc;
    again.next();
    again.commit();
    expect(s.readRange("Event")?.next).toBe("100001");
  });

  it("an entity's own generatedStart wins over the global one", () => {
    const { alloc } = allocator(store(), integer(), { ids: { generatedStart: 500000 } });
    expect(alloc.next()).toBe("500000");
  });

  it("skips identities already held by ANY origin (a runtime or static row never gets reissued)", () => {
    const s = store();
    s.insert("Event", "100001", { id: 100001 }, "runtime");
    s.insert("Event", "100002", { id: 100002 }, "static");
    const { alloc } = allocator(s, integer(), undefined);
    expect([alloc.next(), alloc.next(), alloc.next()]).toEqual(["100000", "100003", "100004"]);
  });
});

describe("uuid space", () => {
  const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it("allocates v4-shaped uuids from the collection's stream: stable for the seed, different for another", () => {
    const run = (seed: number): string[] => {
      const { alloc } = allocator(store(), uuid(), undefined, [], seed);
      return Array.from({ length: 20 }, () => alloc.next());
    };
    const a = run(42);
    expect(a.every((id) => V4.test(id))).toBe(true);
    expect(new Set(a).size).toBe(20);
    expect(run(42)).toEqual(a);
    expect(run(43)).not.toEqual(a);
  });

  it("a draw equal to a fixture identity is redrawn (disjoint from fixtures)", () => {
    const first = allocator(store(), uuid(), undefined).alloc.next();
    const s = store();
    s.insert("Group", first, { id: first }, "static");
    const next = allocator(s, uuid(), undefined).alloc.next();
    expect(next).not.toBe(first);
    expect(V4.test(next)).toBe(true);
  });

  it("an explicit leading-hex span is honoured, and a fixture inside it refuses naming the collection", () => {
    const entity = { ids: { reserved: "a0000000..afffffff" } };
    const { alloc, refusals } = allocator(store(), uuid(), entity);
    expect(refusals).toEqual([]);
    for (let i = 0; i < 50; i += 1) expect(alloc.next()).toMatch(/^a[0-9a-f]{7}-/);
    const clash = allocator(store(), uuid("Group"), entity, ["a1234567-0000-4000-8000-000000000000"]);
    expect(clash.refusals[0]?.key).toBe("entities.Group.ids.reserved");
    expect(clash.refusals[0]?.cause).toContain("Group");
    expect(clash.refusals[0]?.cause).toContain("a1234567-0000-4000-8000-000000000000");
  });

  it("a malformed or inverted span refuses naming the collection", () => {
    for (const reserved of ["zz..yy", "afffffff..a0000000", "a0000000"]) {
      const { refusals } = allocator(store(), uuid("Group"), { ids: { reserved } });
      expect(refusals[0]?.key, reserved).toBe("entities.Group.ids.reserved");
      expect(refusals[0]?.cause).toContain("Group");
    }
  });
});

describe("formatted (prefixed) space", () => {
  it("allocates identities in the declared form from the default start", () => {
    const { alloc } = allocator(store(), formatted(), undefined);
    expect([alloc.next(), alloc.next()]).toEqual(["EVT-100000", "EVT-100001"]);
  });

  it("ids.reserved spans the pattern's numeric run; the span exhausts by name, never wraps", () => {
    const { alloc, refusals } = allocator(store(), formatted(), { ids: { reserved: "EVT-200000..EVT-200002" } });
    expect(refusals).toEqual([]);
    expect([alloc.next(), alloc.next(), alloc.next()]).toEqual(["EVT-200000", "EVT-200001", "EVT-200002"]);
    expect(() => alloc.next()).toThrow(IdentitySpaceExhaustedError);
    expect(() => alloc.next()).toThrow(/Ticket/);
  });

  it("overlap: a fixture inside the span — or at/above the default start — refuses naming the collection (SC-006)", () => {
    const inside = allocator(store(), formatted("Ticket"), { ids: { reserved: "EVT-100000..EVT-199999" } }, ["EVT-100500"]);
    expect(inside.refusals[0]?.cause).toContain("Ticket");
    expect(inside.refusals[0]?.cause).toContain("EVT-100500");
    const above = allocator(store(), formatted("Ticket"), undefined, ["EVT-100001"]);
    expect(above.refusals[0]?.cause).toContain("Ticket");
    const below = allocator(store(), formatted("Ticket"), undefined, ["EVT-000123"]);
    expect(below.refusals).toEqual([]);
  });

  it("a span whose ends do not match the declared pattern, or are inverted, refuses", () => {
    for (const reserved of ["EVT-1..EVT-2", "XYZ-100000..XYZ-100005", "EVT-200005..EVT-200000"]) {
      const { refusals } = allocator(store(), formatted("Ticket"), { ids: { reserved } });
      expect(refusals[0]?.key, reserved).toBe("entities.Ticket.ids.reserved");
    }
  });

  it("an open-quantifier pattern allocates past its minimum width (F-E carried into the range)", () => {
    const { alloc } = allocator(store(), formatted("Widget", "^W-[0-9]+$"), undefined);
    expect([alloc.next(), alloc.next()]).toEqual(["W-100000", "W-100001"]);
  });
});

describe("opaque space — reported, never guessed", () => {
  it("is flagged unreservable and still avoids fixtures by a membership check, not a range", () => {
    const s = store();
    s.insert("Thing", (100000).toString(36), { id: "x" }, "static");
    const { alloc, plan, refusals } = allocator(s, opaque(), undefined);
    expect(refusals).toEqual([]);
    expect(plan.unreservable).toBe(true);
    expect(plan.space).toBe("opaque");
    expect(alloc.next()).toBe((100001).toString(36)); // 100000 is held by a fixture
  });
});

describe("FR-018 — API-written identities collide with neither fixture nor generated ones", () => {
  // The runtime path is `allocateIdentity` + an existence check over the same table; here the
  // generated rows are written first, then 200 "API" identities are allocated the way crud.ts does.
  function runtime(s: Store, resource: Resource, start: number): string {
    for (;;) {
      const counter = s.nextIdentity(resource.name, start);
      const id = allocateIdentity(resource, counter);
      if (!s.readOne(resource.name, id)) return id;
    }
  }

  it.each([
    ["integer", integer()],
    ["uuid", uuid()],
    ["formatted", formatted("Ticket", "^EVT-[0-9]{6}$")],
    ["opaque", opaque()],
  ] as const)("%s: 500 generated then 200 runtime identities are duplicate-free", (_label, resource) => {
    const s = store();
    const fixtureId = resource.idSpace === "integer" ? "7" : resource.idSpace === "uuid" ? "11111111-1111-4111-8111-111111111111" : resource.idSpace === "formatted" ? "EVT-000007" : "fixture";
    s.insert(resource.name, fixtureId, { id: fixtureId }, "static");
    const { alloc } = allocator(s, resource, undefined);
    for (let i = 0; i < 500; i += 1) {
      const id = alloc.next();
      s.insert(resource.name, id, { id }, "generated");
    }
    alloc.commit();
    const created: string[] = [];
    for (let i = 0; i < 200; i += 1) {
      const id = runtime(s, resource, 100000);
      s.insert(resource.name, id, { id }, "runtime");
      created.push(id);
    }
    const all = s.listIdentities(resource.name);
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(701);
    expect(created.every((id) => !s.list(resource.name).some((r) => r.identity === id && r.origin !== "runtime"))).toBe(true);
  });
});

describe("a pattern narrower than the default generated start is a structured refusal, not a throw", () => {
  const narrow = formatted("Gate", "^G-[0-9]{3}$");

  it("refuses with a cause that names the resource and the way out", () => {
    const planned = planIdentity({ resource: narrow, globalStart: 100000, fixtureIds: [] });
    expect(planned.refusals).toHaveLength(1);
    expect(planned.refusals[0]?.key).toBe("entities.Gate.ids.reserved");
    expect(planned.refusals[0]?.cause).toContain("Gate");
    expect(planned.refusals[0]?.cause).toContain("100000");
    expect(planned.refusals[0]?.cause).toMatch(/ids\.generatedStart|reserved/);
  });

  it("plans cleanly when the start fits inside the pattern's space", () => {
    const planned = planIdentity({ resource: narrow, globalStart: 100, fixtureIds: [] });
    expect(planned.refusals).toEqual([]);
    expect(planned.plan.reserved).toBe("G-100..");
  });

  it("plans cleanly when an explicit span is reserved", () => {
    const planned = planIdentity({ resource: narrow, entity: { ids: { reserved: "G-500..G-599" } }, globalStart: 100000, fixtureIds: [] });
    expect(planned.refusals).toEqual([]);
  });
});
