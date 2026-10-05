import { afterEach, describe, expect, it } from "vitest";
import { ConfigRefusedError, ConfigLayerInvalidError, RecipeNotFoundError } from "../../src/errors.js";
import type { RunningMock } from "../../src/index.js";
import { runCli } from "../../src/cli/program.js";
import { makeProject, startProject } from "../helpers/project.js";
import { fixturePath } from "../helpers/mock.js";
import { join } from "node:path";
import { writeFileSync } from "node:fs";

let mock: RunningMock | undefined;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

describe("the four layers at startup (FR-001, FR-005)", () => {
  it("a project with none of the layer folders starts (a missing layer is not an error)", async () => {
    ({ mock } = await startProject({}));
    expect(mock.port).toBeGreaterThan(0);
  });

  it("refuses before binding anything, listing EVERY cause with file and key", async () => {
    const out: string[] = [];
    await expect(
      startProject(
        {
          "dynamic/r.yaml": "entities:\n  Ghost: { count: 1 }\n",
          "static/entities/venues.yaml": "entity: Venue\nrows:\n  - { id: 1, name: ab }\n",
        },
        { config: "recipe: r\nentities:\n  Specter: {}\n", mock: { out: (t) => out.push(t) } },
      ),
    ).rejects.toBeInstanceOf(ConfigRefusedError);
    const text = out.join("\n");
    expect(text).toContain("dynamic/r.yaml: entities.Ghost");
    expect(text).toContain("understudy.yaml: entities.Specter");
    expect(text).toContain("static/entities/venues.yaml: rows[0].name");
  });

  it("a behaviour-layer typo refuses with the same `file: key — cause` shape (Scenario 7)", async () => {
    await expect(
      startProject({ "behavior/webhooks.yaml": "targets:\n  pos:\n    url: http://x\n    urll: oops\n" }),
    ).rejects.toThrow(/behavior\/webhooks\.yaml: targets\.pos\.urll/);
  });

  it("an unknown selected recipe refuses naming it and the available ones", async () => {
    await expect(
      startProject({ "dynamic/ci-small.yaml": "entities: {}\n" }, { config: "recipe: ci-smal\n" }),
    ).rejects.toBeInstanceOf(RecipeNotFoundError);
  });

  it("a layer file that is not valid refuses as a layer error", async () => {
    await expect(startProject({ "static/lookups/x.yaml": "entity: A\nrows: []\n" })).rejects.toBeInstanceOf(ConfigLayerInvalidError);
  });
});

describe("`up --recipe` / `--seed` override the config (CLI is a thin client of config)", () => {
  it("--recipe naming a missing recipe exits non-zero naming it; --seed must be an integer", async () => {
    const dir = makeProject({ "dynamic/ci.yaml": "entities: {}\n" });
    writeFileSync(
      join(dir, "understudy.yaml"),
      `spec: ${fixturePath("shop-api.yaml")}\noperations: ["GET /venues"]\nserver: { port: 0 }\nstorage: { driver: sqlite, path: ${JSON.stringify(join(dir, "s.db"))} }\n`,
    );
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (t: string) => out.push(t), err: (t: string) => err.push(t), env: {} };
    expect(await runCli(["node", "ustdy", "up", "--config", join(dir, "understudy.yaml"), "--recipe", "nope"], io)).toBe(1);
    expect(out.join("\n") + err.join("\n")).toContain("nope");
    expect(await runCli(["node", "ustdy", "up", "--config", join(dir, "understudy.yaml"), "--seed", "abc"], io)).not.toBe(0);
  });
});
