import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Write a map of `relative/path -> text` into a fresh temp directory and return it. */
export function makeProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "understudy-project-"));
  for (const [rel, text] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  return dir;
}

import { join as joinPath } from "node:path";
import { parseConfig, type UnderstudyConfig } from "../../src/config/load.js";
import { createMock, type MockOptions, type RunningMock } from "../../src/index.js";
import { createLogger } from "../../src/logging.js";
import { fixturePath } from "./mock.js";

/** Every operation of `tests/fixtures/shop-api.yaml` (list/create/get/patch/delete on each collection). */
export const SHOP_COLLECTIONS = [
  ["/venues", "Venue"],
  ["/events", "Event"],
  ["/inventory", "Inventory"],
  ["/inventory-statuses", "InventoryStatus"],
  ["/audit-notes", "AuditNote"],
] as const;

export function shopOperations(only?: readonly string[]): string[] {
  const out: string[] = [];
  for (const [path] of SHOP_COLLECTIONS) {
    if (only && !only.includes(path)) continue;
    out.push(`GET ${path}`, `POST ${path}`, `GET ${path}/{id}`, `PATCH ${path}/{id}`, `DELETE ${path}/{id}`);
  }
  return out;
}

export interface ProjectOptions {
  /** Extra `understudy.yaml` text appended after spec/operations/storage. */
  config?: string;
  spec?: string;
  operations?: readonly string[];
  mock?: MockOptions;
  /** Reuse an existing project directory (a restart) instead of creating one. */
  dir?: string;
}

/** The parsed config of a project directory written by `makeProject` + this helper. */
export function projectConfig(dir: string, options: ProjectOptions = {}): UnderstudyConfig {
  const text = [
    `spec: ${options.spec ?? fixturePath("shop-api.yaml")}`,
    "operations:",
    ...(options.operations ?? shopOperations()).map((entry) => `  - ${JSON.stringify(entry)}`),
    `storage: { driver: sqlite, path: ${JSON.stringify(joinPath(dir, ".understudy", "state.db"))} }`,
    options.config ?? "",
  ].join("\n");
  return parseConfig(text, joinPath(dir, "understudy.yaml"));
}

/** Write a project (layer files) and start a mock on it, silencing the default sinks. */
export async function startProject(
  files: Record<string, string>,
  options: ProjectOptions = {},
): Promise<{ dir: string; mock: RunningMock }> {
  const dir = options.dir ?? makeProject(files);
  if (options.dir) {
    for (const [rel, text] of Object.entries(files)) {
      const full = joinPath(dir, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text);
    }
  }
  const mock = await createMock(projectConfig(dir, options), {
    port: 0,
    logger: createLogger({ write: () => {} }),
    out: () => {},
    ...options.mock,
  });
  return { dir, mock };
}
