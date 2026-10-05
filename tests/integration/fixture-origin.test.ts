/**
 * T043 (SC-003, narrowed per D2; constitution IV).
 *
 * What is guaranteed — and proven here — is exactly what the layers that own the rows control:
 * the fixture FILES are never rewritten; fixture rows are applied identically on every start; and
 * `static` rows are byte-identical across reads, lists, creates, `wipe`, and (in the generation
 * suites) generation. What is NOT guaranteed is that an API `PATCH`/`PUT`/`DELETE` addressed to a
 * static-origin row leaves it alone: those are mutations (slice 1's CRUD semantics stand, D2), and
 * the test below asserts the mutation happens — and that the next start restores the row to what
 * the reviewed file says.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { RunningMock } from "../../src/index.js";
import { fixturesProject, startProject } from "../helpers/project.js";
import { serialiseStore } from "../helpers/serialize.js";

const mocks: RunningMock[] = [];
afterEach(async () => {
  await Promise.all(mocks.splice(0).map((m) => m.close()));
});

const PIN = 'clock:\n  mode: real\n  start: "2026-01-01T00:00:00Z"\n';
const json = { "content-type": "application/json" };

async function boot(dir?: string): Promise<{ dir: string; mock: RunningMock }> {
  const started = await startProject(fixturesProject("fixtures-project"), { config: PIN, ...(dir ? { dir } : {}) });
  mocks.push(started.mock);
  return started;
}

describe("static rows across API activity and wipe (SC-003, narrowed per D2)", () => {
  it("are byte-identical across creates, reads, lists, filters, paging and reset-wipe", async () => {
    const { mock } = await boot();
    const before = serialiseStore(mock.store, { origins: ["static"] });
    for (let i = 0; i < 5; i += 1) {
      await fetch(`${mock.baseUrl}/venues`, { method: "POST", headers: json, body: JSON.stringify({ name: `Runtime ${i}` }) });
    }
    await fetch(`${mock.baseUrl}/venues?limit=1&offset=1`);
    await fetch(`${mock.baseUrl}/events?venueId=1`);
    await fetch(`${mock.baseUrl}/venues/1`);
    expect(serialiseStore(mock.store, { origins: ["static"] })).toBe(before);

    const reset = await fetch(`${mock.controlUrl}${mock.controlPrefix}/reset`, { method: "POST", headers: json, body: "{}" });
    expect(reset.status).toBe(200);
    expect(serialiseStore(mock.store, { origins: ["static"] })).toBe(before);
    expect(mock.store.countByOrigin().Venue).toEqual({ static: 2 }); // the runtime rows went; static stayed
  });

  it("wipe rewinds the runtime identity counter (slice 1's semantics, consumed unchanged)", async () => {
    const { mock } = await boot();
    await fetch(`${mock.baseUrl}/venues`, { method: "POST", headers: json, body: JSON.stringify({ name: "Runtime" }) });
    expect(mock.store.getMeta("id_seq:Venue")).toBe("100001");
    await fetch(`${mock.controlUrl}${mock.controlPrefix}/reset`, { method: "POST", headers: json, body: "{}" });
    expect(mock.store.getMeta("id_seq:Venue")).toBe("100000");
  });

  it("D2: an API PATCH/DELETE of a static-origin row IS a mutation; the next start restores it from the file", async () => {
    const { dir, mock } = await boot();
    const patched = await fetch(`${mock.baseUrl}/venues/1`, { method: "PATCH", headers: json, body: JSON.stringify({ name: "Renamed Arena" }) });
    expect(patched.status).toBe(200);
    expect(mock.store.readOne("Venue", "1")?.data).toMatchObject({ name: "Renamed Arena" });
    expect(mock.store.readOne("Venue", "1")?.origin).toBe("static"); // still the layer's row
    const deleted = await fetch(`${mock.baseUrl}/venues/2`, { method: "DELETE" });
    expect([204, 409]).toContain(deleted.status); // Event 2 references Venue 2 (restrict) — either way, slice 1's rules
    await mock.close();
    mocks.pop();

    const again = await boot(dir);
    expect(again.mock.store.readOne("Venue", "1")?.data).toMatchObject({ name: "Test Arena" });
    expect(again.mock.store.listIdentities("Venue").sort()).toEqual(["1", "2"]);
  });
});

describe("nothing but the fixtures loader writes a static row", () => {
  const srcDir = fileURLToPath(new URL("../../src", import.meta.url));
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
    );

  it("`origin: \"static\"` is written in exactly one source file", () => {
    const writers = files(srcDir)
      .filter((f) => /origin:\s*"static"|,\s*"static"\s*\)/.test(readFileSync(f, "utf8")))
      .map((f) => relative(srcDir, f));
    expect(writers).toEqual(["data/fixtures.ts"]);
  });
});
