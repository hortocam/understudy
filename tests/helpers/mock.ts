import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig } from "../../src/config/load.js";
import { createLogger, type Logger } from "../../src/logging.js";
import { createMock, type RunningMock } from "../../src/index.js";
import type { Store } from "../../src/store/index.js";

export const fixturePath = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

/** The five operations inventory-api.yaml is asked to serve. */
export const INVENTORY_OPERATIONS = [
  "POST /inventory",
  "GET /inventory",
  "GET /inventory/{id}",
  "PATCH /inventory/{id}",
  "DELETE /inventory/{id}",
] as const;

export function newStoreDir(): string {
  return mkdtempSync(join(tmpdir(), "understudy-mock-"));
}

export function storePath(storeDir: string): string {
  return join(storeDir, "state.db");
}

export interface StartForTest {
  spec: string;
  operations: readonly string[];
  storeDir?: string;
  logger?: Logger;
  out?: (text: string) => void;
  store?: Store;
}

/**
 * Start a mock against a fixture on an ephemeral port, silencing the default sinks
 * (the startup report and the structured log) unless a test asks for them.
 */
export async function start(options: StartForTest): Promise<RunningMock> {
  const storeDir = options.storeDir ?? newStoreDir();
  const configText = [
    `spec: ${options.spec}`,
    "operations:",
    ...options.operations.map((entry) => `  - ${entry}`),
    `storage: { driver: sqlite, path: ${JSON.stringify(storePath(storeDir))} }`,
  ].join("\n");
  const config = parseConfig(configText, join(storeDir, "understudy.yaml"));

  return createMock(config, {
    port: 0,
    logger: options.logger ?? createLogger({ write: () => {} }),
    out: options.out ?? (() => {}),
    ...(options.store ? { store: options.store } : {}),
  });
}
