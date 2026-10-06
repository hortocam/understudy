/**
 * T027 — the startup report as a deliverable (FR-023, FR-024), and the A2 obligation:
 * a selection that mixes the two selector forms must say which form resolved each live
 * operation. Also proves the wiring refuses to start on a T004 error instead of serving
 * a half-alive mock.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EmptySelectionError,
  StoreUnwritableError,
  UnknownOperationError,
} from "../../src/errors.js";
import { createMock, type RunningMock } from "../../src/index.js";
import { createLogger } from "../../src/logging.js";
import { loadConfig, parseConfig } from "../../src/config/load.js";
import { fixturePath, newStoreDir, storePath } from "../helpers/mock.js";

let mock: RunningMock | undefined;

afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

function configFor(spec: string, operations: string[], storeDir: string) {
  return parseConfig(
    [
      `spec: ${spec}`,
      "operations:",
      ...operations.map((entry) => `  - ${entry}`),
      `storage: { driver: sqlite, path: ${JSON.stringify(storePath(storeDir))} }`,
    ].join("\n"),
    join(storeDir, "understudy.yaml"),
  );
}

describe("startup wiring (FR-023, FR-024)", () => {
  it("renders the report for a human and emits it as one structured log line", async () => {
    const dir = newStoreDir();
    const lines: string[] = [];
    const logs: string[] = [];
    mock = await createMock(configFor(fixturePath("inventory-api.yaml"), ["GET /inventory"], dir), {
      port: 0,
      out: (text: string) => lines.push(text),
      logger: createLogger({ write: (line) => logs.push(line) }),
    });

    const rendered = lines.join("\n");
    expect(rendered).toContain("live operations (1)");
    expect(rendered).toContain("GET /inventory");
    expect(rendered).toContain("not selected (");
    expect(rendered).toContain("GET /events");
    expect(rendered).toContain("entities derived (");
    expect(rendered).toContain("ambiguities (");

    const reportLine = logs.map((line) => JSON.parse(line) as Record<string, unknown>).find((record) => record.message === "startup report");
    expect(reportLine).toBeDefined();
    const report = reportLine?.report as { live: unknown[]; resources: unknown[] };
    expect(report.live).toHaveLength(1);
    expect(report.resources.length).toBeGreaterThan(0);
  });

  it("says which selector form resolved each live operation when a selection mixes forms (A2)", async () => {
    // One entry by `METHOD /path` and one by `operationId` — the mixed case FR-023 names.
    const dir = newStoreDir();
    mock = await createMock(
      configFor(fixturePath("derivation-api.yaml"), ["GET /inventory", "createInventory"], dir),
      { port: 0, out: () => {}, logger: createLogger({ write: () => {} }) },
    );

    const selection = mock.report.selection;
    expect(selection.mixed).toBe(true);
    expect([...selection.forms].sort()).toEqual(["method-path", "operationId"]);
    expect(selection.resolved).toEqual(
      expect.arrayContaining([
        { methodPath: "GET /inventory", operationId: "listInventory", entry: "GET /inventory", form: "method-path" },
        { methodPath: "POST /inventory", operationId: "createInventory", entry: "createInventory", form: "operationId" },
      ]),
    );
  });

  it("does not call a selection mixed when every entry used the same form", async () => {
    const dir = newStoreDir();
    mock = await createMock(
      configFor(fixturePath("derivation-api.yaml"), ["listInventory", "createInventory"], dir),
      { port: 0, out: () => {}, logger: createLogger({ write: () => {} }) },
    );
    expect(mock.report.selection.mixed).toBe(false);
    expect(mock.report.selection.forms).toEqual(["operationId"]);
  });

  it("refuses to start — and binds nothing — on an unknown selection entry (FR-004)", async () => {
    const dir = newStoreDir();
    const config = configFor(fixturePath("inventory-api.yaml"), ["GET /nope"], dir);
    let boundPort = 0;
    await expect(
      createMock(config, {
        port: 0,
        out: () => {},
        logger: createLogger({ write: () => {} }),
        onListening: (port: number) => {
          boundPort = port;
        },
      }),
    ).rejects.toBeInstanceOf(UnknownOperationError);
    expect(boundPort).toBe(0);
  });

  it("refuses to start when the store location is not writable (FR-004)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "understudy-startup-"));
    const blocker = join(dir, "not-a-directory");
    writeFileSync(blocker, "x");
    const config = parseConfig(
      [
        `spec: ${fixturePath("inventory-api.yaml")}`,
        "operations: [GET /inventory]",
        `storage: { driver: sqlite, path: ${JSON.stringify(join(blocker, "state.db"))} }`,
      ].join("\n"),
      join(dir, "understudy.yaml"),
    );
    await expect(
      createMock(config, { port: 0, out: () => {}, logger: createLogger({ write: () => {} }) }),
    ).rejects.toBeInstanceOf(StoreUnwritableError);
  });

  it("refuses an empty selection rather than serving nothing (FR-004)", async () => {
    // The config contract already refuses an empty list; this asserts the engine's own
    // EmptySelectionError is not silently bypassed when a caller builds a config by hand.
    const dir = newStoreDir();
    const config = { ...configFor(fixturePath("inventory-api.yaml"), ["GET /inventory"], dir), operations: [] };
    await expect(
      createMock(config, { port: 0, out: () => {}, logger: createLogger({ write: () => {} }) }),
    ).rejects.toBeInstanceOf(EmptySelectionError);
  });

  it("opens a relative storage.path beside the config file, not the process cwd (FU)", async () => {
    // `ustdy up --config sub/understudy.yaml` with `storage.path: ./.understudy/state.db` must put
    // the store in `sub/`, exactly as `spec` already resolves against the config file's directory.
    const dir = mkdtempSync(join(tmpdir(), "understudy-startup-"));
    const sub = join(dir, "sub");
    mkdirSync(sub, { recursive: true });
    const configPath = join(sub, "understudy.yaml");
    writeFileSync(
      configPath,
      [
        `spec: ${fixturePath("inventory-api.yaml")}`,
        "operations: [GET /inventory]",
        "storage: { driver: sqlite, path: ./.understudy/state.db }",
      ].join("\n"),
    );
    const config = loadConfig(configPath);
    expect(config.storage.path).toBe(join(sub, ".understudy", "state.db"));

    mock = await createMock(config, { port: 0, out: () => {}, logger: createLogger({ write: () => {} }) });
    expect(existsSync(join(sub, ".understudy", "state.db"))).toBe(true);
    expect(existsSync(join(dir, ".understudy", "state.db"))).toBe(false);
  });
});
