import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig, parseConfig } from "../../src/config/load.js";
import { configSchema } from "../../src/config/schema.js";
import {
  ConfigInvalidError,
  ConfigUnparseableError,
  ReservedConfigError,
  UnderstudyError,
} from "../../src/errors.js";

// Slice 2's contract is authoritative (plan → "Known integration point"); slice 1's file stays as history.
const contractPath = fileURLToPath(
  new URL("../../specs/002-data-layer/contracts/config.schema.yaml", import.meta.url),
);
const slice1ContractPath = fileURLToPath(
  new URL("../../specs/001-slice-1-core/contracts/config.schema.yaml", import.meta.url),
);

function capture(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

describe("config schema", () => {
  it("keeps the inlined schema identical to the checked-in contract", () => {
    const contract = JSON.parse(readFileSync(contractPath, "utf8")) as unknown;
    expect(configSchema).toEqual(contract);
  });

  it("derives from slice 2's contract, and leaves slice 1's file in place as history", () => {
    const slice1 = JSON.parse(readFileSync(slice1ContractPath, "utf8")) as { properties: Record<string, unknown> };
    // slice 1's contract predates the extended keys: it is history, never edited
    expect(slice1.properties.entities).toBeUndefined();
    expect((configSchema as { properties: Record<string, unknown> }).properties.entities).toBeDefined();
    expect(readFileSync(new URL("../../scripts/generate-config-schema.mjs", import.meta.url), "utf8")).toContain(
      "specs/002-data-layer/contracts/config.schema.yaml",
    );
  });

  it("states the default seed in the contract (D9, constitution IX)", () => {
    const seed = (configSchema as { properties: { seed: { default?: unknown } } }).properties.seed;
    expect(seed.default).toBe(0);
  });
});

describe("loadConfig defaults", () => {
  const config = parseConfig("spec: ./api.yaml\noperations:\n  - GET /pets\n", "/tmp/proj/understudy.yaml");

  it("applies every documented default", () => {
    expect(config.server).toEqual({ port: 8080, host: "127.0.0.1", basePath: "" });
    expect(config.control).toEqual({ prefix: "/__understudy" });
    expect(config.storage).toEqual({ driver: "sqlite", path: "./.understudy/state.db" });
    expect(config.ids).toEqual({ generatedStart: 100000 });
  });

  it("preserves explicit values", () => {
    const explicit = parseConfig(
      [
        "spec: https://example.test/openapi.json",
        "operations: [getPets]",
        "server: { port: 9999, host: 0.0.0.0 }",
        "storage: { driver: sqlite, path: ./custom.db }",
        "ids: { generatedStart: 500000 }",
      ].join("\n"),
      "/tmp/proj/understudy.yaml",
    );
    expect(explicit.server.port).toBe(9999);
    expect(explicit.server.host).toBe("0.0.0.0");
    expect(explicit.storage.path).toBe("./custom.db");
    expect(explicit.ids.generatedStart).toBe(500000);
    expect(explicit.spec).toBe("https://example.test/openapi.json");
  });
});

describe("loadConfig refusals", () => {
  it("refuses an unknown key by name", () => {
    const error = capture(() => parseConfig("spec: ./api.yaml\noperations: [GET /pets]\nbogus: true\n", "c.yaml"));
    expect(error).toBeInstanceOf(ConfigInvalidError);
    expect((error as Error).message).toContain("bogus");
  });

  it("refuses an unknown nested key by name", () => {
    const error = capture(() =>
      parseConfig("spec: ./api.yaml\noperations: [GET /pets]\nserver:\n  bogus: 1\n", "c.yaml"),
    );
    expect(error).toBeInstanceOf(ConfigInvalidError);
    expect((error as Error).message).toContain("bogus");
  });

  it("refuses an empty operations selection", () => {
    const error = capture(() => parseConfig("spec: ./api.yaml\noperations: []\n", "c.yaml"));
    expect(error).toBeInstanceOf(UnderstudyError);
  });

  it("refuses unparseable YAML", () => {
    const error = capture(() => parseConfig("spec: [unclosed\noperations: 3\n", "c.yaml"));
    expect(error).toBeInstanceOf(ConfigUnparseableError);
    expect((error as Error).message).toContain("c.yaml");
  });

  it("refuses a missing required key", () => {
    const error = capture(() => parseConfig("operations: [GET /pets]\n", "c.yaml"));
    expect(error).toBeInstanceOf(ConfigInvalidError);
    expect((error as Error).message).toContain("spec");
  });

  it("accepts an operationId that is not an identifier shape (T048: hyphens and dots)", () => {
    // OpenAPI constrains operationId only as a unique string; real documents use hyphens and
    // dots. The contract must not refuse them before the document is even consulted.
    for (const entry of ["get-widgets", "api.getWidgets"]) {
      const config = parseConfig(`spec: ./api.yaml\noperations: [${entry}]\n`, "c.yaml");
      expect(config.operations).toEqual([entry]);
    }
  });

  it("accepts a METHOD /path entry containing a hyphen or dot in the path", () => {
    const config = parseConfig(
      'spec: ./api.yaml\noperations: ["GET /v1.2/foo-bar"]\n',
      "c.yaml",
    );
    expect(config.operations).toEqual(["GET /v1.2/foo-bar"]);
  });
});

describe("reserved keys refuse by name", () => {
  it("refuses signing", () => {
    const error = capture(() =>
      parseConfig("spec: ./api.yaml\noperations: [GET /pets]\nsigning:\n  alg: hmac-sha256\n", "c.yaml"),
    );
    expect(error).toBeInstanceOf(ReservedConfigError);
    expect((error as Error).message).toContain("signing");
  });

  it("refuses clock.mode: virtual, but accepts the real clock and a pinned start (slice 2)", () => {
    const error = capture(() =>
      parseConfig("spec: ./api.yaml\noperations: [GET /pets]\nclock:\n  mode: virtual\n", "c.yaml"),
    );
    expect(error).toBeInstanceOf(ReservedConfigError);
    expect((error as Error).message).toContain("clock.mode");
    const ok = parseConfig(
      "spec: ./api.yaml\noperations: [GET /pets]\nclock:\n  mode: real\n  start: 2026-01-02T03:04:05Z\n",
      "c.yaml",
    );
    expect(ok.clock).toEqual({ mode: "real", start: "2026-01-02T03:04:05Z" });
  });

  it("refuses storage.driver: postgres", () => {
    const error = capture(() =>
      parseConfig("spec: ./api.yaml\noperations: [GET /pets]\nstorage:\n  driver: postgres\n", "c.yaml"),
    );
    expect(error).toBeInstanceOf(ReservedConfigError);
    expect((error as Error).message).toContain("storage.driver");
  });
});

describe("spec path resolution", () => {
  it("resolves a relative spec path against the config file, not the cwd", () => {
    const dir = mkdtempSync(join(tmpdir(), "understudy-config-"));
    const file = join(dir, "understudy.yaml");
    writeFileSync(file, "spec: ./api.yaml\noperations: [GET /pets]\n");
    const config = loadConfig(file);
    expect(config.spec).toBe(resolve(dir, "api.yaml"));
  });

  it("leaves a URL spec untouched", () => {
    const config = parseConfig("spec: https://example.test/openapi.json\noperations: [getPets]\n", "c.yaml");
    expect(config.spec).toBe("https://example.test/openapi.json");
  });
});