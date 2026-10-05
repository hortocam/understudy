/**
 * FR-020 / Scenario 1 / US4: `ustdy init` scaffolds the four layer folders and an `understudy.yaml`
 * for a specification and prints the inferred collection report — the developer starts from the
 * tool's understanding, not a blank directory. It is the one documented non-client act besides `up`
 * (it writes files, the same class of local act) and contains no generation logic.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/load.js";
import { runCli, type CliIo } from "../../src/cli/program.js";
import { createLogger } from "../../src/logging.js";
import { createMock, type RunningMock } from "../../src/index.js";
import { fixturePath, newStoreDir } from "../helpers/mock.js";
import { withOutboundSpy } from "../helpers/outbound.js";

const mocks: RunningMock[] = [];
afterEach(async () => {
  await Promise.all(mocks.splice(0).map((m) => m.close()));
});

async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const io: CliIo = { out: (t) => (stdout += `${t}\n`), err: (t) => (stderr += `${t}\n`), env: {} };
  const code = await runCli(["node", "ustdy", ...args], io);
  return { code, stdout, stderr };
}

describe("ustdy init (FR-020)", () => {
  it("creates the four layer folders and understudy.yaml, and prints the inferred collection report", async () => {
    const dir = newStoreDir();
    const result = await cli(["init", "--spec", fixturePath("shop-api.yaml"), "--dir", dir]);
    expect(result.code).toBe(0);
    for (const folder of ["static/lookups", "static/entities", "imports", "dynamic", "behavior"]) {
      expect(statSync(join(dir, folder)).isDirectory(), folder).toBe(true);
    }
    expect(existsSync(join(dir, "understudy.yaml"))).toBe(true);
    // the report: collections, links with their evidence source, undetermined links listed separately
    expect(result.stdout).toContain("entities derived");
    expect(result.stdout).toContain("Event -> Venue via venueId [one, convention]");
    expect(result.stdout).toContain("Inventory -> Event via eventId [one, convention]");
    expect(result.stdout).toContain("undetermined links");
    expect(result.stdout).toContain("generation order: ");
    expect(result.stdout).toMatch(/wrote .*understudy\.yaml/);
  });

  it("the report names undetermined links with candidates, so a developer can decide what to pin without reading source", async () => {
    const dir = newStoreDir();
    const result = await cli(["init", "--spec", fixturePath("collisions-api.yaml"), "--dir", dir]);
    expect(result.stdout).toContain("undetermined links (8)");
    expect(result.stdout).toMatch(/Order\.eventId .*candidates: eventId, primaryEventId, viagogoEventId/);
    expect(result.stdout).toMatch(/pin it with entities\.Order\.relations\.eventId/);
  });

  it("the scaffolded understudy.yaml is a valid config that selects the document's operations and documents every key it shows", async () => {
    const dir = newStoreDir();
    await cli(["init", "--spec", fixturePath("shop-api.yaml"), "--dir", dir]);
    const text = readFileSync(join(dir, "understudy.yaml"), "utf8");
    const config = parseConfig(text, join(dir, "understudy.yaml"));
    expect(config.operations.length).toBeGreaterThan(0);
    expect(text).toMatch(/# .*recipe/i); // the optional keys are shown commented, with their meaning
    expect(text).toMatch(/# .*seed/i);
  });

  it("a tagged document is selected by TAG (the ergonomic form when operationIds are absent)", async () => {
    const dir = newStoreDir();
    await cli(["init", "--spec", fixturePath("tags-api.yaml"), "--dir", dir]);
    const config = parseConfig(readFileSync(join(dir, "understudy.yaml"), "utf8"), join(dir, "understudy.yaml"));
    expect([...config.operations].sort()).toEqual(["Invoices", "Market_Orders", "Venues"]);
  });

  it("the scaffolded project STARTS, and its starter recipe generates a populated mock from the tool's own understanding", async () => {
    const dir = newStoreDir();
    await cli(["init", "--spec", fixturePath("shop-api.yaml"), "--dir", dir]);
    expect(readdirSync(join(dir, "dynamic")).some((f) => f.endsWith(".yaml"))).toBe(true);
    const config = parseConfig(readFileSync(join(dir, "understudy.yaml"), "utf8"), join(dir, "understudy.yaml"));
    const mock = await createMock({ ...config, recipe: "starter", storage: { ...config.storage, path: join(dir, "state.db") } }, { port: 0, out: () => {}, logger: createLogger({ write: () => {} }) });
    mocks.push(mock);
    const counts = mock.store.countByOrigin();
    expect(counts.Venue?.generated).toBeGreaterThan(0);
    expect(counts.Event?.generated).toBeGreaterThan(0); // attached to Venue by the decided link
    const venues = new Set(mock.store.listIdentities("Venue"));
    expect(mock.store.list("Event").every((e) => venues.has(String((e.data as { venueId: number }).venueId)))).toBe(true);
  });

  it("refuses to overwrite existing files, naming them; --force replaces them", async () => {
    const dir = newStoreDir();
    writeFileSync(join(dir, "understudy.yaml"), "# mine\n");
    const refused = await cli(["init", "--spec", fixturePath("shop-api.yaml"), "--dir", dir]);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("understudy.yaml");
    expect(refused.stderr).toContain("--force");
    expect(readFileSync(join(dir, "understudy.yaml"), "utf8")).toBe("# mine\n");
    const forced = await cli(["init", "--spec", fixturePath("shop-api.yaml"), "--dir", dir, "--force"]);
    expect(forced.code).toBe(0);
    expect(readFileSync(join(dir, "understudy.yaml"), "utf8")).not.toBe("# mine\n");
  });

  it("an unreadable specification refuses naming it and writes nothing", async () => {
    const dir = newStoreDir();
    const result = await cli(["init", "--spec", join(dir, "nope.yaml"), "--dir", dir]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("nope.yaml");
    expect(existsSync(join(dir, "understudy.yaml"))).toBe(false);
  });

  it("makes no outbound connection for a file spec (a URL is the only network call the tool ever makes)", async () => {
    const dir = newStoreDir();
    const { report } = await withOutboundSpy(async () => cli(["init", "--spec", fixturePath("shop-api.yaml"), "--dir", dir]));
    expect(report.external).toEqual([]);
  });
});
