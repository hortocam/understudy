/**
 * T028 — the control plane integration suite (quickstart.md §7; FR-012–FR-018).
 *
 * Drives the running control plane over HTTP exactly as §7 does: health reports store
 * reachability; reset wipes and leaves the mock answering; operations lists both sets;
 * requests filters; teardown releases the port (proved by binding it again) and is
 * idempotent; an unknown control path under the prefix is answered as an unknown CONTROL
 * operation with the declared `ControlError` body and never reaches the mocked surface;
 * a malformed reset body is the declared 400 `ControlError`. T030's drift check lives here
 * too, because the served document is a running-server claim.
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, describe, expect, it } from "vitest";
import { createMock, type RunningMock } from "../../src/index.js";
import { createLogger } from "../../src/logging.js";
import { parseConfig } from "../../src/config/load.js";
import { INVENTORY_OPERATIONS, fixturePath, newStoreDir, storePath } from "../helpers/mock.js";

const contractPath = fileURLToPath(
  new URL("../../specs/002-data-layer/contracts/control-api.openapi.json", import.meta.url),
);

/**
 * The contract's own declared `Health` schema (`GET /health` → 200), compiled once. The health
 * tests assert against THIS, not against whatever shape the handler happens to return — the
 * code cannot be its own witness (FR-013, constitution I).
 */
const healthIsValid = (() => {
  const document = JSON.parse(readFileSync(contractPath, "utf8")) as {
    paths: { "/health": { get: { responses: { "200": { content: { "application/json": { schema: object } } } } } } };
  };
  const schema = document.paths["/health"].get.responses["200"].content["application/json"].schema;
  return new Ajv2020({ allErrors: true, strict: false }).compile(schema);
})();

interface HealthBody {
  status: string;
  store: { reachable: boolean; path?: string; error?: string };
}

let mock: RunningMock | undefined;

afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

function configFor(
  spec: string,
  operations: readonly string[],
  storeDir: string,
  control?: { port: number; host?: string },
) {
  const lines = [
    `spec: ${spec}`,
    "operations:",
    ...operations.map((entry) => `  - ${entry}`),
    `storage: { driver: sqlite, path: ${JSON.stringify(storePath(storeDir))} }`,
  ];
  if (control) {
    // T031: a configured `control.port` gives the control plane its own listener.
    const host = control.host === undefined ? "" : `, host: ${JSON.stringify(control.host)}`;
    lines.push(`control: { port: ${control.port}${host} }`);
  }
  return parseConfig(lines.join("\n"), join(storeDir, "understudy.yaml"));
}

async function startControl(
  options: {
    spec?: string;
    operations?: readonly string[];
    storeDir?: string;
    control?: { port: number; host?: string };
  } = {},
): Promise<RunningMock> {
  const dir = options.storeDir ?? newStoreDir();
  mock = await createMock(
    configFor(options.spec ?? fixturePath("inventory-api.yaml"), options.operations ?? INVENTORY_OPERATIONS, dir, options.control),
    { port: 0, out: () => {}, logger: createLogger({ write: () => {} }) },
  );
  return mock;
}

/** Build a control URL path against the running mock's control surface. */
function control(url: string, path: string, prefix: string): string {
  return `${url}${prefix}${path}`;
}

async function createInventory(url: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${url}/inventory`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Resolve whether `port` is free by attempting to bind it. */
function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

/** Ask the OS for a free port by binding 0 and reading it back. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

describe("control plane health (FR-013)", () => {
  it("reports the store reachable and its path", async () => {
    const running = await startControl();
    const response = await fetch(control(running.controlUrl, "/health", running.controlPrefix));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; store: { reachable: boolean; path?: string } };
    expect(body.status).toBe("ok");
    expect(body.store.reachable).toBe(true);
    expect(body.store.path).toBe(running.store.path);
    // The declared Health schema, not the code's own opinion of it.
    expect(healthIsValid(body)).toBe(true);
    expect(body).toMatchObject({ store: { reachable: true, path: running.store.path } });
    expect((body.store as { error?: string }).error).toBeUndefined();
  });

  it("reports the store unreachable in the declared shape when the store is closed, not a 500", async () => {
    const running = await startControl();
    // The store is closed out from under the control plane: reachability is a claim the health
    // endpoint makes, so the answer must describe the failure, not throw from inside the handler.
    running.store.close();

    const response = await fetch(control(running.controlUrl, "/health", running.controlPrefix));

    // FR-013: the health answer is 200 and describes the store; an unreachable store is NOT an
    // internal error. A 500 here would make /health useless as a liveness probe.
    expect(response.status).toBe(200);
    const body = (await response.json()) as HealthBody;
    expect(body.status).toBe("ok");
    expect(body.store.reachable).toBe(false);
    expect(body.store.path).toBe(running.store.path);
    // ...with a non-empty `error`, which is the branch's whole point.
    expect(typeof body.store.error).toBe("string");
    expect(body.store.error).not.toBe("");
    // Assert against the contract's declared schema, not the shape the handler chose.
    expect(healthIsValid(body)).toBe(true);
    // The error names why, so an operator can act on it rather than guess.
    expect(body.store.error).toMatch(/not open|closed|store/i);
  });
});

describe("control plane operations (FR-015)", () => {
  it("lists the live and the not-implemented operations", async () => {
    const running = await startControl();
    const response = await fetch(control(running.controlUrl, "/operations", running.controlPrefix));

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      live: Array<{ method: string; path: string; operationId?: string }>;
      notImplemented: Array<{ method: string; path: string }>;
    };

    const live = body.live.map((op) => `${op.method} ${op.path}`);
    expect(live).toEqual(expect.arrayContaining([...INVENTORY_OPERATIONS]));
    expect(live).toHaveLength(INVENTORY_OPERATIONS.length);
    expect(body.notImplemented.map((op) => `${op.method} ${op.path}`)).toContain("GET /events");
  });
});

describe("control plane reset (FR-014, SC-002)", () => {
  it("wipes records written over the API and leaves the mock answering", async () => {
    const running = await startControl();
    const created = await createInventory(running.baseUrl, { sku: "GA-100", quantity: 4 });
    expect(created.status).toBe(201);
    const record = (await created.json()) as { id: number };

    const reset = await fetch(control(running.controlUrl, "/reset", running.controlPrefix), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "wipe" }),
    });
    expect(reset.status).toBe(200);
    const resetBody = (await reset.json()) as { ok: boolean; mode: string; removed: Record<string, number> };
    expect(resetBody.ok).toBe(true);
    expect(resetBody.mode).toBe("wipe");
    expect(resetBody.removed.Inventory).toBeGreaterThanOrEqual(1);

    // The record is gone: the document's own declared not-found status (404).
    const after = await fetch(`${running.baseUrl}/inventory/${record.id}`);
    expect(after.status).toBe(404);
    // ...and the mock is still alive and answering.
    expect((await fetch(`${running.baseUrl}/inventory`)).status).toBe(200);
    const health = await fetch(control(running.controlUrl, "/health", running.controlPrefix));
    expect(health.status).toBe(200);
  });

  it("resets the identity counters so a wiped mock starts counting where it began", async () => {
    const running = await startControl();
    const first = (await (await createInventory(running.baseUrl, { sku: "A", quantity: 1 })).json()) as { id: number };

    await fetch(control(running.controlUrl, "/reset", running.controlPrefix), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "wipe" }),
    });

    const second = (await (await createInventory(running.baseUrl, { sku: "B", quantity: 1 })).json()) as { id: number };
    expect(second.id).toBe(first.id);
  });

  it("refuses a reset mode outside the enum with the declared 400 ControlError", async () => {
    const running = await startControl();
    const response = await fetch(control(running.controlUrl, "/reset", running.controlPrefix), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "baseline" }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("malformed_request");
    expect(body.message).toContain("baseline");
  });

  it("answers a 400 ControlError for a malformed reset body", async () => {
    const running = await startControl();
    const response = await fetch(control(running.controlUrl, "/reset", running.controlPrefix), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("malformed_request");
    expect(typeof body.message).toBe("string");
  });
});

describe("control plane request log (FR-016)", () => {
  it("records mocked-surface requests and filters them", async () => {
    const running = await startControl();
    await createInventory(running.baseUrl, { sku: "GA-100", quantity: 4 });
    await fetch(`${running.baseUrl}/events`); // a not-implemented operation -> 501

    const all = (await (await fetch(control(running.controlUrl, "/requests", running.controlPrefix))).json()) as {
      total: number;
      requests: Array<{ method: string; path: string; status: number; live: boolean; durationMs: number; at: string }>;
    };
    const statuses = all.requests.map((entry) => entry.status);
    expect(statuses).toContain(201);
    expect(statuses).toContain(501);

    const filtered = (await (
      await fetch(control(running.controlUrl, "/requests?status=501", running.controlPrefix))
    ).json()) as { total: number; requests: Array<{ status: number; live: boolean }> };
    expect(filtered.requests.length).toBeGreaterThan(0);
    expect(filtered.requests.every((entry) => entry.status === 501)).toBe(true);
    expect(filtered.requests.every((entry) => entry.live === false)).toBe(true);

    // Control-plane traffic is not part of the mocked-surface log (FR-016).
    expect(all.requests.every((entry) => !entry.path.startsWith(running.controlPrefix))).toBe(true);
  });

  it("refuses a malformed requests query with the declared 400 ControlError", async () => {
    const running = await startControl();
    const response = await fetch(control(running.controlUrl, "/requests?status=not-a-number", running.controlPrefix));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("malformed_request");
  });
});

describe("control plane reserved prefix (FR-012, spec edge case)", () => {
  it("answers an unknown control path with the declared ControlError and never the mocked surface", async () => {
    const running = await startControl();
    const response = await fetch(control(running.controlUrl, "/not-a-control-operation", running.controlPrefix));

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string; message: string; field?: string };
    expect(body.error).toBe("unknown_control_operation");
    expect(body.message).toContain("/not-a-control-operation");
    // Never the mocked surface's own not-found body.
    expect(body.error).not.toBe("not_found");
  });
});

describe("control plane teardown (FR-017)", () => {
  it("releases the port, proves it free by rebinding, and is idempotent", async () => {
    const running = await startControl();
    const port = running.port;

    const response = await fetch(control(running.controlUrl, "/teardown", running.controlPrefix), { method: "POST" });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { ok: boolean }).ok).toBe(true);

    await running.closed;
    expect(await portIsFree(port)).toBe(true);

    // A repeated teardown is not destructive: the lifecycle close is idempotent, and a
    // second HTTP teardown is only a connection failure (the mock is already gone).
    await expect(running.close()).resolves.toBeUndefined();
    const second = await fetch(control(running.controlUrl, "/teardown", running.controlPrefix), {
      method: "POST",
    }).then(
      (reply) => reply.status,
      () => "connection-refused" as const,
    );
    expect(second === "connection-refused" || second === 200).toBe(true);
  });
});

describe("control plane describes itself (T030, FR-018)", () => {
  it("serves the checked-in control contract byte for byte (drift check)", async () => {
    const running = await startControl();
    const response = await fetch(control(running.controlUrl, "/openapi.json", running.controlPrefix));

    expect(response.status).toBe(200);
    const served = await response.text();
    const checkedIn = readFileSync(contractPath, "utf8");
    expect(served).toBe(checkedIn);
  });
});

describe("control plane on its own listener (T031, FR-012, FR-021)", () => {
  it("serves the control API on control.port and not on the mocked surface's port", async () => {
    const controlPort = await freePort();
    const running = await startControl({ control: { port: controlPort, host: "127.0.0.1" } });

    // The control URL is composed from control.host / control.port, not the mock's address.
    expect(running.controlUrl).toBe(`http://127.0.0.1:${controlPort}`);
    expect(running.controlUrl).not.toBe(running.baseUrl);

    // The control plane answers on its OWN listener.
    const health = await fetch(control(running.controlUrl, "/health", running.controlPrefix));
    expect(health.status).toBe(200);
    const body = (await health.json()) as HealthBody;
    expect(body.status).toBe("ok");
    expect(body.store.reachable).toBe(true);
    expect(healthIsValid(body)).toBe(true);

    // The mocked surface does NOT route the reserved prefix into a control operation: a request
    // under the prefix on the mock's own port is an ordinary undeclared path of the DOCUMENT, so
    // it gets the mocked surface's declared not-found (`error: "not_found"`) — never the control
    // plane's health answer, and never its `unknown_control_operation`. With a separate listener
    // the mock has no knowledge of the prefix at all (FR-012).
    const onMockPort = await fetch(control(running.baseUrl, "/health", running.controlPrefix));
    expect(onMockPort.status).toBe(404);
    const mockBody = (await onMockPort.json()) as { error?: string; status?: string; store?: unknown };
    expect(mockBody.status).toBeUndefined();
    expect(mockBody.store).toBeUndefined();
    expect(mockBody.error).toBe("not_found");
    expect(mockBody.error).not.toBe("unknown_control_operation");

    // ...while the mocked surface itself still serves the live operations on its own port.
    const listed = await fetch(`${running.baseUrl}/inventory`);
    expect(listed.status).toBe(200);
  });

  it("releases BOTH the mock port and the control port on teardown (FR-017)", async () => {
    const controlPort = await freePort();
    const running = await startControl({ control: { port: controlPort } });
    const mockPort = running.port;

    // Both listeners are bound while the mock runs.
    expect(await portIsFree(mockPort)).toBe(false);
    expect(await portIsFree(controlPort)).toBe(false);
    // ...and both answer before teardown.
    expect((await fetch(`${running.baseUrl}/inventory`)).status).toBe(200);
    expect((await fetch(control(running.controlUrl, "/health", running.controlPrefix))).status).toBe(200);

    const response = await fetch(control(running.controlUrl, "/teardown", running.controlPrefix), { method: "POST" });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { ok: boolean }).ok).toBe(true);

    await running.closed;
    // Both ports are released: neither probe can bind them, and each listener now REFUSES a
    // connection (not merely a non-200 — the port is gone).
    expect(await portIsFree(mockPort)).toBe(true);
    expect(await portIsFree(controlPort)).toBe(true);
    await expect(fetch(`${running.baseUrl}/inventory`)).rejects.toThrow();
    await expect(fetch(control(running.controlUrl, "/health", running.controlPrefix))).rejects.toThrow();
  });
});
