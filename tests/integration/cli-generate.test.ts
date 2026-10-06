/**
 * FR-021 + the CLI contract (constitution II): `ustdy generate` is a CLIENT of `POST /generate` and
 * adds no logic; with the control plane down it fails with a connection error and does nothing
 * locally. `ustdy up --recipe/--seed` is the one place the CLI constructs a server, and it generates
 * through the same engine.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli, type CliIo } from "../../src/cli/program.js";
import type { RunningMock } from "../../src/index.js";
import { fixturePath } from "../helpers/mock.js";
import { allOperations, fixturesProject, makeProject, startGen } from "../helpers/project.js";
import { writeFileSync } from "node:fs";

const mocks: RunningMock[] = [];
const upUrls: string[] = [];
afterEach(async () => {
  await Promise.all(mocks.splice(0).map((m) => m.close()));
  for (const url of upUrls.splice(0)) await cli(["down", "--control-url", url]).catch(() => undefined);
});

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(args: string[], env: Record<string, string> = {}): Promise<Result> {
  let stdout = "";
  let stderr = "";
  const io: CliIo = { out: (t) => (stdout += `${t}\n`), err: (t) => (stderr += `${t}\n`), env };
  const code = await runCli(["node", "ustdy", ...args], io);
  return { code, stdout, stderr };
}

async function running(): Promise<{ mock: RunningMock; url: string }> {
  const { mock } = await startGen(undefined);
  mocks.push(mock);
  return { mock, url: `${mock.controlUrl}${mock.controlPrefix}` };
}

describe("ustdy generate", () => {
  it("applies the recipe through the control plane and reports counts by collection and origin", async () => {
    const { mock, url } = await running();
    const result = await cli(["generate", "--recipe", "ci-small", "--control-url", url]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("recipe ci-small");
    expect(result.stdout).toContain("seed 42");
    expect(result.stdout).toMatch(/Venue: .*generated 3/);
    expect(result.stdout).toMatch(/Venue: .*static 2/);
    const counts = mock.store.countByOrigin();
    for (const collection of ["Venue", "Event", "Inventory"]) {
      expect(result.stdout).toContain(`${collection}: generated ${counts[collection]?.generated}`);
    }
  });

  it("--seed overrides the recipe's seed, and a repeat is reported as already applied", async () => {
    const { url } = await running();
    const first = await cli(["generate", "--recipe", "ci-small", "--seed", "9", "--control-url", url]);
    expect(first.stdout).toContain("seed 9");
    const again = await cli(["generate", "--recipe", "ci-small", "--seed", "9", "--control-url", url]);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("already applied");
  });

  it("relays the control plane's refusals: an unknown recipe, a seed mismatch, a bad seed", async () => {
    const { url } = await running();
    const unknown = await cli(["generate", "--recipe", "ci-smal", "--control-url", url]);
    expect(unknown.code).not.toBe(0);
    expect(unknown.stderr).toContain("ci-smal");
    await cli(["generate", "--recipe", "ci-small", "--seed", "1", "--control-url", url]);
    const conflict = await cli(["generate", "--recipe", "ci-small", "--seed", "2", "--control-url", url]);
    expect(conflict.code).not.toBe(0);
    expect(conflict.stderr).toContain("seed");
    expect((await cli(["generate", "--recipe", "ci-small", "--seed", "abc", "--control-url", url])).code).not.toBe(0);
  });

  it("with the control plane down it exits non-zero with a connection error and does NO local work", async () => {
    const dir = makeProject(fixturesProject("gen-project"));
    const result = await cli(["generate", "--recipe", "ci-small", "--control-url", "http://127.0.0.1:1/__understudy"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/cannot reach the control plane/);
    expect(existsSync(join(dir, ".understudy"))).toBe(false); // nothing was generated anywhere
  });

  it("is listed in --help alongside init, with the new `up` flags", async () => {
    const help = await cli(["--help"]);
    expect(help.stdout).toMatch(/generate/);
    expect(help.stdout).toMatch(/init/);
    const up = await cli(["up", "--help"]);
    expect(up.stdout).toContain("--recipe");
    expect(up.stdout).toContain("--seed");
  });
});

describe("ustdy up --recipe / --seed", () => {
  async function upWith(args: string[]): Promise<{ stdout: string; mockUrl: string; controlUrl: string }> {
    const spec = fixturePath("shop-api.yaml");
    const operations = (await allOperations(spec)).map((o) => `  - "${o}"`).join("\n");
    const dir = makeProject(fixturesProject("gen-project"));
    const config = join(dir, "understudy.yaml");
    writeFileSync(
      config,
      `spec: ${spec}\noperations:\n${operations}\nserver: { port: 0 }\nstorage: { driver: sqlite, path: ${JSON.stringify(join(dir, "s.db"))} }\nclock: { mode: real, start: "2026-01-01T00:00:00Z" }\n`,
    );
    let stdout = "";
    let announce: (v: { control: string; mock: string }) => void = () => {};
    const ready = new Promise<{ control: string; mock: string }>((resolve) => (announce = resolve));
    const io: CliIo = {
      out: (t) => {
        stdout += `${t}\n`;
        const m = /ready: control plane at (\S+)\s+mock at (\S+)/.exec(t);
        if (m) announce({ control: m[1] as string, mock: m[2] as string });
      },
      err: () => undefined,
      env: {},
    };
    const exit = runCli(["node", "ustdy", "up", "--config", config, "--port", "0", ...args], io);
    const urls = await Promise.race([ready, exit.then(() => undefined)]);
    if (!urls) throw new Error(`up exited before ready:\n${stdout}`);
    upUrls.push(urls.control);
    return { stdout, mockUrl: urls.mock, controlUrl: urls.control };
  }

  it("generates at start with the named recipe and the --seed override (which beats the recipe's own seed)", async () => {
    const { stdout, mockUrl } = await upWith(["--recipe", "ci-small", "--seed", "5"]);
    expect(stdout).toContain("recipe: ci-small");
    expect(stdout).toContain("seed: 5");
    const venues = (await (await fetch(`${mockUrl}/venues`)).json()) as unknown[];
    expect(venues).toHaveLength(5); // 2 fixtures + 3 generated
  });

  it("without --recipe only the fixtures are loaded", async () => {
    const { mockUrl } = await upWith([]);
    const venues = (await (await fetch(`${mockUrl}/venues`)).json()) as unknown[];
    expect(venues).toHaveLength(2);
  });
});
