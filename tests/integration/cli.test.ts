/**
 * T034 — the CLI is a client of the control plane and nothing more (SC-005, FR-019, FR-020).
 *
 * Every command is run in-process through `runCli` against a real running mock, and its
 * output is compared with the control API's own answer for the same request. With the control
 * plane stopped, every command must exit non-zero with a connection error rather than fall
 * back to doing the work locally (contracts/cli.md, "Connection behaviour").
 */
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli, type CliIo } from "../../src/cli/program.js";
import type { RunningMock } from "../../src/index.js";
import { INVENTORY_OPERATIONS, fixturePath, newStoreDir, start, storePath } from "../helpers/mock.js";

let mock: RunningMock | undefined;

afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(args: string[], env: Record<string, string> = {}): Promise<Result> {
  let stdout = "";
  let stderr = "";
  const io: CliIo = {
    out: (text) => (stdout += `${text}\n`),
    err: (text) => (stderr += `${text}\n`),
    env,
  };
  const code = await runCli(["node", "ustdy", ...args], io);
  return { code, stdout, stderr };
}

async function running(): Promise<{ mock: RunningMock; url: string }> {
  mock = await start({ spec: fixturePath("inventory-api.yaml"), operations: INVENTORY_OPERATIONS });
  return { mock, url: `${mock.controlUrl}${mock.controlPrefix}` };
}

async function json(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  return (await (await fetch(url, init)).json()) as Record<string, unknown>;
}

async function deadControlUrl(): Promise<string> {
  const port = await new Promise<number>((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const bound = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(bound));
    });
  });
  return `http://127.0.0.1:${port}/__understudy`;
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

describe("ops list mirrors GET /operations", () => {
  it("prints every live and not-implemented operation the control plane reports", async () => {
    const { url } = await running();
    const answer = (await json(`${url}/operations`)) as {
      live: { method: string; path: string }[];
      notImplemented: { method: string; path: string }[];
    };
    const result = await cli(["ops", "list", "--control-url", url]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`live operations (${answer.live.length})`);
    expect(result.stdout).toContain(`not implemented (${answer.notImplemented.length})`);
    for (const op of [...answer.live, ...answer.notImplemented]) {
      expect(result.stdout).toContain(`${op.method} ${op.path}`);
    }
    expect(answer.live.length).toBeGreaterThan(0);
  });
});

describe("reset mirrors POST /reset", () => {
  it("reports the rows removed per entity, and the data is really gone", async () => {
    const { mock: m, url } = await running();
    for (const sku of ["A", "B"]) {
      await fetch(`${m.baseUrl}/inventory`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sku, quantity: 1 }),
      });
    }
    const result = await cli(["reset", "--to", "wipe", "--control-url", url]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Inventory\D+2/);
    const after = await json(`${m.baseUrl}/inventory`);
    expect(JSON.stringify(after)).not.toContain('"sku"');

    // The same request made by hand now removes nothing — the CLI and the API agree.
    const again = (await json(`${url}/reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "wipe" }),
    })) as { removed: Record<string, number> };
    expect(again.removed.Inventory).toBe(0);
    const second = await cli(["reset", "--control-url", url]);
    expect(second.stdout).toMatch(/Inventory\D+0/);
  });

  it("scopes to --entity and relays the control plane's refusal of any other mode", async () => {
    const { url } = await running();
    const scoped = await cli(["reset", "--entity", "Inventory", "--control-url", url]);
    expect(scoped.code).toBe(0);
    expect(scoped.stdout).toContain("Inventory");

    const unknown = await cli(["reset", "--entity", "nope", "--control-url", url]);
    expect(unknown.code).not.toBe(0);
    expect(unknown.stderr).toContain('unknown entity "nope"');

    const refused = await cli(["reset", "--to", "baseline", "--control-url", url]);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("unsupported reset mode");
  });
});

describe("logs requests mirrors GET /requests", () => {
  it("lists the request log newest first and honours --status, --method, --live, --limit", async () => {
    const { mock: m, url } = await running();
    await fetch(`${m.baseUrl}/inventory`);
    await fetch(`${m.baseUrl}/inventory/missing`);
    await fetch(`${m.baseUrl}/events`);

    const all = (await json(`${url}/requests`)) as { total: number; requests: { method: string; path: string; status: number }[] };
    const result = await cli(["logs", "requests", "--control-url", url]);
    expect(result.code).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines).toHaveLength(all.requests.length);
    all.requests.forEach((entry, index) => {
      expect(lines[index]).toContain(String(entry.status));
      expect(lines[index]).toContain(`${entry.method} ${entry.path}`);
    });

    const notImplemented = await cli(["logs", "requests", "--status", "501", "--control-url", url]);
    expect(notImplemented.stdout.trim().split("\n")).toHaveLength(
      ((await json(`${url}/requests?status=501`)) as { requests: unknown[] }).requests.length,
    );
    expect(notImplemented.stdout).toContain("/events");

    const live = await cli(["logs", "requests", "--live", "--method", "get", "--limit", "1", "--control-url", url]);
    expect(live.stdout.trim().split("\n")).toHaveLength(1);
    expect(live.stdout).not.toContain("/events");
  });

  it("relays the control plane's refusal of a bad filter", async () => {
    const { url } = await running();
    const result = await cli(["logs", "requests", "--status", "abc", "--control-url", url]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('"status" must be an integer');
  });
});

describe("down mirrors POST /teardown", () => {
  it("exits 0 only once the port is released, and is idempotent", async () => {
    const { mock: m, url } = await running();
    const result = await cli(["down", "--control-url", url]);
    expect(result.code).toBe(0);
    expect(await portIsFree(m.port)).toBe(true);
    await m.closed;
    // A second `down` finds nothing listening: a clear failure, not a silent success.
    const again = await cli(["down", "--control-url", url]);
    expect(again.code).not.toBe(0);
  });
});

describe("up is the one command that starts a server", () => {
  it("builds the mock from the config, prints the report then a ready line, and stops on down", async () => {
    const dir = newStoreDir();
    const configPath = join(dir, "understudy.yaml");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      configPath,
      [
        `spec: ${fixturePath("inventory-api.yaml")}`,
        "operations:",
        ...INVENTORY_OPERATIONS.map((entry) => `  - ${entry}`),
        `storage: { driver: sqlite, path: ${JSON.stringify(storePath(dir))} }`,
      ].join("\n"),
    );

    let stdout = "";
    let announce: (url: string) => void = () => {};
    const ready = new Promise<string>((resolve) => (announce = resolve));
    const io: CliIo = {
      out: (text) => {
        stdout += `${text}\n`;
        const match = /ready: control plane at (\S+)/.exec(text);
        if (match?.[1]) announce(match[1]);
      },
      err: () => {},
      env: {},
    };
    const exit = runCli(["node", "ustdy", "up", "--config", configPath, "--port", "0"], io);
    const controlUrl = await ready;

    expect(stdout).toContain("live operations (5)");
    expect(stdout.indexOf("live operations")).toBeLessThan(stdout.indexOf("ready:"));
    expect((await json(`${controlUrl}/health`)).status).toBe("ok");

    const down = await cli(["down", "--control-url", controlUrl]);
    expect(down.code).toBe(0);
    expect(await exit).toBe(0);
  });

  it("refuses to start on a bad config with a non-zero exit and a message naming the cause", async () => {
    const result = await cli(["up", "--config", join(newStoreDir(), "missing.yaml")]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("missing.yaml");
  });
});

describe("with the control plane stopped, every command fails with a connection error (SC-005)", () => {
  const commands: [string, string[]][] = [
    ["down", ["down"]],
    ["ops list", ["ops", "list"]],
    ["reset", ["reset", "--to", "wipe"]],
    ["logs requests", ["logs", "requests"]],
  ];

  for (const [name, args] of commands) {
    it(`${name} exits non-zero, names the unreachable URL, and does no work locally`, async () => {
      const url = await deadControlUrl();
      const result = await cli([...args, "--control-url", url]);
      expect(result.code).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("cannot reach the control plane");
      expect(result.stderr).toContain(url);
    });
  }

  it("takes the control URL from the environment when no flag is given", async () => {
    const url = await deadControlUrl();
    const result = await cli(["ops", "list"], { USTDY_CONTROL_URL: url });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(url);
  });
});
