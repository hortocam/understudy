/**
 * T040 — every refusal path names its cause and exits non-zero (FR-004, FR-024).
 *
 * Each of the seven causes the spec names — an unreadable document, an unresolvable `$ref`,
 * an empty selection, an unknown operation, an invalid config, an unwritable store, a port
 * in use — is driven the way a user drives it (`ustdy up`) and asserted to: exit non-zero,
 * and produce a human-readable message that names the offending thing rather than a stack
 * trace or a bare "failed to start".
 *
 * `spec.md` → Edge Cases, FR-004: "the tool fails fast and states precisely what it could not
 * parse; it does not start a half-alive mock." FR-024: the refusal is readable without source.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli, type CliIo } from "../../src/cli/program.js";
import { parseConfig } from "../../src/config/load.js";
import { EmptySelectionError } from "../../src/errors.js";
import { createMock } from "../../src/index.js";
import { renderRefusal } from "../../src/logging.js";
import { fixturePath } from "../helpers/mock.js";

let occupied: ReturnType<typeof createServer> | undefined;

afterEach(async () => {
  if (occupied) {
    await new Promise<void>((resolve) => occupied?.close(() => resolve()));
    occupied = undefined;
  }
});

interface Result {
  code: number;
  /** stdout+stderr — either channel is output a human reads. */
  all: string;
  stdout: string;
  stderr: string;
}

async function up(configPath: string, extra: string[] = []): Promise<Result> {
  let stdout = "";
  let stderr = "";
  const io: CliIo = {
    out: (text) => (stdout += `${text}\n`),
    err: (text) => (stderr += `${text}\n`),
    env: {},
  };
  const code = await runCli(["node", "ustdy", "up", "--config", configPath, ...extra], io);
  return { code, all: stdout + stderr, stdout, stderr };
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "understudy-refusal-"));
}

/** Write a config file and return its path. The store lives in the same temp dir unless given. */
function writeConfig(dir: string, lines: string[]): string {
  const path = join(dir, "understudy.yaml");
  writeFileSync(path, lines.join("\n"));
  return path;
}

function configFor(spec: string, operations: string[], dir: string, extra: string[] = []): string {
  return writeConfig(dir, [
    `spec: ${spec}`,
    "operations:",
    ...operations.map((entry) => `  - ${entry}`),
    `storage: { driver: sqlite, path: ${JSON.stringify(join(dir, "state.db"))} }`,
    ...extra,
  ]);
}

describe("refusal paths (FR-004, FR-024): each names its cause and exits non-zero", () => {
  it("an unreadable document — names the path it could not read", async () => {
    const dir = tmp();
    const result = await up(configFor(fixturePath("does-not-exist.yaml"), ["GET /inventory"], dir));

    expect(result.code).not.toBe(0);
    expect(result.all).toContain("refusing to start");
    expect(result.all).toContain("does-not-exist.yaml");
    expect(result.all).toContain("cannot read the OpenAPI document");
  });

  it("an unresolvable $ref — names the reference it could not resolve", async () => {
    const dir = tmp();
    const specPath = join(dir, "bad-ref.yaml");
    writeFileSync(
      specPath,
      [
        "openapi: 3.1.0",
        "info: { title: Bad, version: 1.0.0 }",
        "paths:",
        "  /things:",
        "    get:",
        "      responses:",
        '        "200":',
        "          description: ok",
        "          content:",
        "            application/json:",
        "              schema: { $ref: './missing.yaml#/components/schemas/Thing' }",
      ].join("\n"),
    );
    const result = await up(configFor(specPath, ["GET /things"], dir));

    expect(result.code).not.toBe(0);
    expect(result.all).toContain("refusing to start");
    expect(result.all).toContain("unresolved $ref");
    expect(result.all).toContain("missing.yaml");
  });

  it("an empty selection — the config contract refuses it by name, and the engine guards it too", async () => {
    const dir = tmp();
    // The user-facing path: the config contract requires at least one operation.
    const result = await up(
      writeConfig(dir, [
        `spec: ${fixturePath("inventory-api.yaml")}`,
        "operations: []",
        `storage: { driver: sqlite, path: ${JSON.stringify(join(dir, "state.db"))} }`,
      ]),
    );
    expect(result.code).not.toBe(0);
    expect(result.all).toContain("refusing to start");
    expect(result.all).toContain("operations");

    // The engine's own guard, for a caller that builds a config past the contract: the refusal
    // is the EmptySelectionError, and its rendered message names the empty selection.
    const handBuilt = { ...parseConfig(`spec: ${fixturePath("inventory-api.yaml")}\noperations: [GET /inventory]\n`, join(dir, "c.yaml")), operations: [] };
    const thrown = await createMock(handBuilt, { port: 0, out: () => {} }).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(EmptySelectionError);
    expect(renderRefusal(thrown)).toContain("selection");
    expect(renderRefusal(thrown)).toContain("empty");
  });

  it("an unknown operation — names the entry the document does not contain", async () => {
    const dir = tmp();
    const result = await up(configFor(fixturePath("inventory-api.yaml"), ["GET /nope"], dir));

    expect(result.code).not.toBe(0);
    expect(result.all).toContain("refusing to start");
    expect(result.all).toContain("GET /nope");
    expect(result.all).toContain("does not contain");
  });

  it("an invalid config — names the offending key", async () => {
    const dir = tmp();
    const result = await up(
      writeConfig(dir, [
        `spec: ${fixturePath("inventory-api.yaml")}`,
        "operations: [GET /inventory]",
        "bogus: true",
        `storage: { driver: sqlite, path: ${JSON.stringify(join(dir, "state.db"))} }`,
      ]),
    );

    expect(result.code).not.toBe(0);
    expect(result.all).toContain("refusing to start");
    expect(result.all).toContain("invalid config");
    expect(result.all).toContain("bogus");
  });

  it("an unwritable store — names the store location it cannot write", async () => {
    const dir = tmp();
    const blocker = join(dir, "not-a-directory");
    writeFileSync(blocker, "x"); // a path *below a file*, so the directory cannot be created
    const result = await up(
      writeConfig(dir, [
        `spec: ${fixturePath("inventory-api.yaml")}`,
        "operations: [GET /inventory]",
        `storage: { driver: sqlite, path: ${JSON.stringify(join(blocker, "state.db"))} }`,
      ]),
    );

    expect(result.code).not.toBe(0);
    expect(result.all).toContain("refusing to start");
    expect(result.all).toContain("not writable");
    expect(result.all).toContain(blocker);
  });

  it("a port in use — names the port that could not be bound", async () => {
    // Occupy a port for real, then ask `up` to bind it.
    let port = 0;
    occupied = createServer();
    await new Promise<void>((resolve) => occupied?.listen(0, "127.0.0.1", () => resolve()));
    const address = occupied.address();
    port = typeof address === "object" && address ? address.port : 0;
    expect(port).toBeGreaterThan(0);

    const dir = tmp();
    const result = await up(
      configFor(fixturePath("inventory-api.yaml"), ["GET /inventory"], dir, [`server: { port: ${port} }`]),
    );

    expect(result.code).not.toBe(0);
    expect(result.all).toContain("refusing to start");
    expect(result.all).toContain(`127.0.0.1:${port}`);
    expect(result.all.toUpperCase()).toContain("EADDRINUSE");
  });
});
