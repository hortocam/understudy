/**
 * SC-003 (narrowed per D2): fixture rows are byte-identical before and after generation and a
 * scripted API session; the fixture FILES are byte-identical after any activity; in 100% of 20
 * seeded runs.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunningMock } from "../../src/index.js";
import { fixturesProject, readTree, startGen } from "../helpers/project.js";
import { serialiseStore } from "../helpers/serialize.js";

const mocks: RunningMock[] = [];
afterEach(async () => {
  await Promise.all(mocks.splice(0).map((m) => m.close()));
});

const json = { "content-type": "application/json" };
const noSeed = fixturesProject("gen-project")["dynamic/ci-small.yaml"]!.replace("seed: 42\n", "");

describe("fixture immutability across generation and API activity (SC-003)", () => {
  it("static rows and fixture files are unchanged in every one of 20 seeded runs", async () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      // boot WITHOUT a recipe: fixtures only, then snapshot
      const { dir, mock } = await startGen(undefined, { files: { "dynamic/noseed.yaml": noSeed } });
      mocks.push(mock);
      const staticBefore = serialiseStore(mock.store, { origins: ["static"] });
      const filesBefore = createHash("sha256").update(JSON.stringify(readTree(join(dir, "static")))).digest("hex");
      expect(staticBefore.length).toBeGreaterThan(100);

      await mock.generate({ recipe: "noseed", seed });
      expect(mock.store.countByOrigin().Venue?.generated).toBe(3);

      // a scripted API session: create x N, read, list, filter, page, PATCH + DELETE of NON-static rows, reset wipe
      const base = mock.baseUrl;
      const created: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        const r = await fetch(`${base}/venues`, { method: "POST", headers: json, body: JSON.stringify({ name: `Runtime ${seed}-${i}` }) });
        created.push(((await r.json()) as { id: number }).id);
      }
      await fetch(`${base}/venues/${created[0]}`);
      await fetch(`${base}/venues?limit=2&offset=1&sort=name`);
      await fetch(`${base}/events?venueId=1&limit=3`);
      await fetch(`${base}/inventory?limit=5`);
      expect((await fetch(`${base}/venues/${created[1]}`, { method: "PATCH", headers: json, body: JSON.stringify({ city: "Patched" }) })).status).toBe(200);
      expect((await fetch(`${base}/venues/${created[2]}`, { method: "DELETE" })).status).toBe(204);
      expect(serialiseStore(mock.store, { origins: ["static"] })).toBe(staticBefore);

      const reset = await fetch(`${mock.controlUrl}${mock.controlPrefix}/reset`, { method: "POST", headers: json, body: "{}" });
      expect(reset.status).toBe(200);
      expect(serialiseStore(mock.store, { origins: ["static"] })).toBe(staticBefore);
      expect(createHash("sha256").update(JSON.stringify(readTree(join(dir, "static")))).digest("hex")).toBe(filesBefore);
      await mock.close();
      mocks.pop();
    }
  }, 120_000);
});
