/**
 * US1 (FR-001, FR-002, SC-003 for the fixture layer): versioned fixtures that are identical every
 * run. Fixtures are the one thing the tool must never get "almost right" — a mock whose lookup
 * tables drift makes every test failure ambiguous.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FixtureConformanceError, IdentityRangeOverlapError } from "../../src/errors.js";
import type { RunningMock } from "../../src/index.js";
import { fixturesProject, makeProject, readTree, startProject } from "../helpers/project.js";
import { serialiseStore, sha256 } from "../helpers/serialize.js";

const mocks: RunningMock[] = [];
afterEach(async () => {
  await Promise.all(mocks.splice(0).map((m) => m.close()));
});

const PIN = (iso: string): string => `clock:\n  mode: real\n  start: "${iso}"\n`;

async function run(files: Record<string, string>, iso = "2026-01-01T00:00:00Z", dir?: string): Promise<{ dir: string; mock: RunningMock }> {
  const started = await startProject(files, { config: PIN(iso), ...(dir ? { dir } : {}) });
  mocks.push(started.mock);
  return started;
}

const staticRows = (m: RunningMock): string => serialiseStore(m.store, { origins: ["static"] });

describe("US1 — fixtures are applied exactly, and identically on every start", () => {
  it("1.1 declared identities and values exist exactly, with origin 'static'", async () => {
    const { mock } = await run(fixturesProject("fixtures-project"));
    const venue = await (await fetch(`${mock.baseUrl}/venues/1`)).json();
    expect(venue).toEqual({ id: 1, name: "Test Arena", city: "Boston", state: "MA", timezone: "America/New_York" });
    const statuses = (await (await fetch(`${mock.baseUrl}/inventory-statuses`)).json()) as Array<{ id: number; code: string }>;
    expect(statuses.map((s) => `${s.id}:${s.code}`).sort()).toEqual(["1:available", "2:held", "3:sold", "4:cancelled"]);
    expect(mock.store.countByOrigin()).toEqual({
      Event: { static: 2 },
      InventoryStatus: { static: 4 },
      Venue: { static: 2 },
    });
    expect(mock.store.readOne("Event", "2")?.data).toMatchObject({ id: 2, venueId: 2, category: "sport" });
  });

  it("1.2 two starts from wiped stores give byte-identical fixture rows (sha256 equal)", async () => {
    const files = fixturesProject("fixtures-project");
    const a = await run(files);
    const b = await run(files);
    const first = staticRows(a.mock);
    const second = staticRows(b.mock);
    expect(first.length).toBeGreaterThan(100);
    expect(sha256(first)).toBe(sha256(second));
    expect(second).toBe(first);
  });

  it("an edited fixture changes ONLY its own row on restart; untouched rows keep their timestamps", async () => {
    const files = fixturesProject("fixtures-project");
    const first = await run(files, "2026-01-01T00:00:00Z");
    const before = first.mock.store.list("Venue");
    await first.mock.close();
    mocks.pop();

    const edited = { ...files, "static/entities/venues.yaml": files["static/entities/venues.yaml"]!.replace("Harbor Hall", "Harbour Hall") };
    const second = await run(edited, "2026-06-01T00:00:00Z", first.dir);
    const after = second.mock.store.list("Venue");
    const byId = (rows: typeof before) => new Map(rows.map((r) => [r.identity, r]));
    expect(byId(after).get("1")).toEqual(byId(before).get("1")); // identical, timestamps included
    expect((byId(after).get("2")?.data as { name: string }).name).toBe("Harbour Hall");
    expect(byId(after).get("2")?.createdAt).toBe(byId(before).get("2")?.createdAt);
    expect(byId(after).get("2")?.updatedAt).toBe("2026-06-01T00:00:00.000Z");
  });

  it("a row removed from the file is removed from the store on restart; a row added appears", async () => {
    const files = fixturesProject("fixtures-project");
    const first = await run(files);
    await first.mock.close();
    mocks.pop();
    const trimmed = {
      ...files,
      "static/entities/events.yaml": "entity: Event\nrows:\n  - { id: 2, name: Derby Day, venueId: 2, category: sport, startsAt: '2026-04-11T13:30:00Z' }\n  - { id: 3, name: Gala, venueId: 1, category: theatre }\n",
    };
    const second = await run(trimmed, "2026-01-01T00:00:00Z", first.dir);
    expect(second.mock.store.listIdentities("Event").sort()).toEqual(["2", "3"]);
  });

  it("1.3 / 1.4 API writes never touch fixture rows, and a fixture record is shape-indistinguishable from a runtime one", async () => {
    const { dir, mock } = await run(fixturesProject("fixtures-project"));
    const before = staticRows(mock);
    const filesBefore = createHash("sha256").update(JSON.stringify(readTree(join(dir, "static")))).digest("hex");
    for (let i = 0; i < 3; i += 1) {
      const created = await fetch(`${mock.baseUrl}/venues`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: `Runtime ${i}`, city: "X" }),
      });
      expect(created.status).toBe(201);
    }
    await fetch(`${mock.baseUrl}/venues`); // read
    expect(staticRows(mock)).toBe(before);
    expect(createHash("sha256").update(JSON.stringify(readTree(join(dir, "static")))).digest("hex")).toBe(filesBefore);
    expect(mock.store.countByOrigin().Venue).toEqual({ static: 2, runtime: 3 });

    const fixtureBody = (await (await fetch(`${mock.baseUrl}/venues/1`)).json()) as Record<string, unknown>;
    const runtimeId = mock.store.list("Venue").find((r) => r.origin === "runtime")?.identity as string;
    const runtimeBody = (await (await fetch(`${mock.baseUrl}/venues/${runtimeId}`)).json()) as Record<string, unknown>;
    expect("origin" in fixtureBody || "origin" in runtimeBody).toBe(false); // the surface never says which layer
    const allowed = new Set(["id", "name", "city", "state", "timezone"]);
    expect(Object.keys(fixtureBody).every((k) => allowed.has(k))).toBe(true);
    expect(Object.keys(runtimeBody).every((k) => allowed.has(k))).toBe(true);
  });
});

describe("fixtures refuse rather than guess", () => {
  it("a fixture identity already held by a non-static record refuses, naming the collection", async () => {
    // A runtime record at identity 5 (this store was created with a low generatedStart)...
    const first = await startProject({}, { config: `${PIN("2026-01-01T00:00:00Z")}ids: { generatedStart: 5 }\n` });
    mocks.push(first.mock);
    await fetch(`${first.mock.baseUrl}/venues`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Runtime" }) });
    expect(first.mock.store.listIdentities("Venue")).toEqual(["5"]);
    await first.mock.close();
    mocks.pop();
    // ...and a fixture now claims it: the reviewed file and the running state would disagree.
    const error = await run({ "static/entities/venues.yaml": "entity: Venue\nrows:\n  - { id: 5, name: Taken }\n" }, "2026-01-01T00:00:00Z", first.dir).catch((e) => e as Error);
    expect(error).toBeInstanceOf(IdentityRangeOverlapError);
    expect((error as Error).message).toContain("Venue");
    expect((error as Error).message).toContain("runtime");
  });

  it("a child fixture naming a parent that does not exist refuses, naming file, entity and identity", async () => {
    await expect(
      run({
        "static/entities/venues.yaml": "entity: Venue\nrows:\n  - { id: 1, name: Arena One }\n",
        "static/entities/events.yaml": "entity: Event\nrows:\n  - { id: 1, name: Orphan, venueId: 99 }\n",
      }),
    ).rejects.toBeInstanceOf(FixtureConformanceError);
  });

  it("a lookup table that is not a collection is held in memory and reported as lookup-only (D10)", async () => {
    const { mock } = await run({ "static/lookups/colors.yaml": "entity: Color\nrows:\n  - { id: 1, code: red }\n" });
    expect(mock.report.ambiguities.some((a) => a.kind === "lookup-only" && a.subject === "Color")).toBe(true);
    expect(mock.store.countByOrigin().Color).toBeUndefined();
  });

  it("reads the fixture file bytes unchanged (a sanity check that the test reads what it hashes)", () => {
    const dir = makeProject(fixturesProject("fixtures-project"));
    expect(readFileSync(join(dir, "static/entities/venues.yaml"), "utf8")).toContain("Test Arena");
  });
});
