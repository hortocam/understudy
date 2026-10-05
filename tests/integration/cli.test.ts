/**
 * T034 — the CLI is a client of the control plane and nothing more (SC-005, FR-019, FR-020).
 *
 * Every command is run in-process through `runCli` against a real running mock, and its
 * output is compared with the control API's own answer for the same request. With the control
 * plane stopped, every command must exit non-zero with a connection error rather than fall
 * back to doing the work locally (contracts/cli.md, "Connection behaviour").
 */
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli, type CliIo } from "../../src/cli/program.js";
import type { RunningMock } from "../../src/index.js";
import { INVENTORY_OPERATIONS, fixturePath, newStoreDir, start, storePath } from "../helpers/mock.js";

let mock: RunningMock | undefined;
/** Control URLs of mocks started via `up`, torn down after each test even if it throws. */
const upMocks: string[] = [];

afterEach(async () => {
  await mock?.close();
  mock = undefined;
  for (const url of upMocks.splice(0)) {
    try {
      await cli(["down", "--control-url", url]);
    } catch {
      // Already torn down by the test: cleanup is best-effort.
    }
  }
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
  interface UpResult {
    stdout: string;
    stderr: string;
    /** Present once `up` prints its `ready:` line; undefined if it exited first. */
    controlUrl: string | undefined;
    exit: Promise<number>;
  }

  /**
   * Run `up` in-process and wait for its `ready:` line, so the new-selection tests can
   * assert against a real running mock. If `up` exits before becoming ready (e.g. it
   * rejected the arguments), the promise still resolves — with `controlUrl` undefined —
   * so the caller fails on its own assertion instead of hanging.
   */
  async function upStarted(args: string[], env: Record<string, string> = {}): Promise<UpResult> {
    let stdout = "";
    let stderr = "";
    let announce: (url: string) => void = () => {};
    const ready = new Promise<string>((resolve) => (announce = resolve));
    const io: CliIo = {
      out: (text) => {
        stdout += `${text}\n`;
        const match = /ready: control plane at (\S+)/.exec(text);
        if (match?.[1]) announce(match[1]);
      },
      err: (text) => (stderr += `${text}\n`),
      env,
    };
    const exit = runCli(["node", "ustdy", ...args], io);
    const controlUrl = await Promise.race([ready, exit.then(() => undefined)]);
    if (controlUrl) upMocks.push(controlUrl);
    return { stdout, stderr, controlUrl, exit };
  }

  /** A config file selecting exactly `operations`. */
  function writeConfig(operations: readonly string[]): string {
    const dir = newStoreDir();
    const configPath = join(dir, "understudy.yaml");
    writeFileSync(
      configPath,
      [
        `spec: ${fixturePath("inventory-api.yaml")}`,
        "operations:",
        ...operations.map((entry) => `  - ${entry}`),
        `storage: { driver: sqlite, path: ${JSON.stringify(storePath(dir))} }`,
      ].join("\n"),
    );
    return configPath;
  }

  it("builds the mock from the config, prints the report then a ready line, and stops on down", async () => {
    const configPath = writeConfig(INVENTORY_OPERATIONS);

    const { stdout, controlUrl, exit } = await upStarted(["up", "--config", configPath, "--port", "0"]);

    expect(stdout).toContain("live operations (5)");
    expect(stdout.indexOf("live operations")).toBeLessThan(stdout.indexOf("ready:"));
    expect(controlUrl).toBeDefined();
    expect((await json(`${controlUrl}/health`)).status).toBe("ok");

    const down = await cli(["down", "--control-url", controlUrl as string]);
    expect(down.code).toBe(0);
    expect(await exit).toBe(0);
  });

  it("refuses to start on a bad config with a non-zero exit and a message naming the cause", async () => {
    const result = await cli(["up", "--config", join(newStoreDir(), "missing.yaml")]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("missing.yaml");
  });

  /**
   * FR-020: the operation selection may be given at start as arguments or environment, and
   * an explicit selection overrides the config file's `operations` (contracts/cli.md).
   */
  describe("FR-020 operation selection at start", () => {
    /** The `METHOD /path` set the startup report lists as live. */
    function liveSet(stdout: string): string[] {
      const lines = stdout.split("\n");
      const start = lines.findIndex((line) => line.startsWith("live operations ("));
      const live: string[] = [];
      for (let i = start + 1; i < lines.length && !/^\s*$/.test(lines[i] ?? ""); i += 1) {
        live.push((lines[i] ?? "").trim());
      }
      return live;
    }

    const TWO_LIVE = ["GET /inventory (listInventory)", "POST /inventory (createInventory)"];

    it("--operation (repeatable) selects exactly those operations and overrides the config", async () => {
      // The config selects all five; the flag selects two, so the two must win.
      const configPath = writeConfig(INVENTORY_OPERATIONS);
      const { stdout, controlUrl } = await upStarted([
        "up",
        "--config",
        configPath,
        "--port",
        "0",
        "--operation",
        "GET /inventory",
        "--operation",
        "POST /inventory",
      ]);

      // Exactly the two named are live, and the rest answer NOT_IMPLEMENTED.
      expect(liveSet(stdout)).toEqual(TWO_LIVE);
      // The fixture declares six operations; the two selected leave four unselected.
      expect(stdout).toContain("not selected (4)");

      expect(controlUrl).toBeDefined();
      const baseUrl = (controlUrl ?? "").replace(/\/__understudy$/, "");
      const unselected = await fetch(`${baseUrl}/events`);
      expect(unselected.status).toBe(501);
      expect(((await unselected.json()) as { error: string }).error).toBe("not_implemented");

      // A selected operation answers as a live one, not 501.
      const selected = await fetch(`${baseUrl}/inventory`);
      expect(selected.status).toBe(200);
    });

    it("USTDY_OPERATIONS (comma-separated) does the same", async () => {
      const configPath = writeConfig(INVENTORY_OPERATIONS);
      const { stdout } = await upStarted(["up", "--config", configPath, "--port", "0"], {
        USTDY_OPERATIONS: "GET /inventory,POST /inventory",
      });
      expect(liveSet(stdout)).toEqual(TWO_LIVE);
    });

    it("USTDY_OPERATIONS (newline-separated) does the same", async () => {
      const configPath = writeConfig(INVENTORY_OPERATIONS);
      const { stdout } = await upStarted(["up", "--config", configPath, "--port", "0"], {
        USTDY_OPERATIONS: "GET /inventory\nPOST /inventory",
      });
      expect(liveSet(stdout)).toEqual(TWO_LIVE);
    });

    it("accepts an operationId entry as well as METHOD /path (FR-002 peer forms)", async () => {
      const configPath = writeConfig(INVENTORY_OPERATIONS);
      const { stdout } = await upStarted(["up", "--config", configPath, "--port", "0", "--operation", "listInventory"]);
      expect(liveSet(stdout)).toEqual(["GET /inventory (listInventory)"]);
    });

    it("uses the config file's selection when neither flag nor env is given (regression guard)", async () => {
      const configPath = writeConfig(["GET /inventory", "POST /inventory"]);
      const { stdout } = await upStarted(["up", "--config", configPath, "--port", "0"]);
      expect(liveSet(stdout)).toEqual(TWO_LIVE);
    });

    it("refuses an unknown entry by name at startup, rather than blindly overriding", async () => {
      const configPath = writeConfig(INVENTORY_OPERATIONS);
      const result = await cli(["up", "--config", configPath, "--port", "0", "--operation", "GET /nope"], {});
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("GET /nope");
      expect(result.stderr).toContain("the operation selection names an operation the document does not contain");
    });
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
