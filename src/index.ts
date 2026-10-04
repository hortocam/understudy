/**
 * The library entry point (FR-023, FR-024, constitution VI).
 *
 * `createMock` is the one composition root: it loads the document, resolves the
 * selection, derives the model, builds the report, opens the store, serves the mocked
 * surface and prints the startup report. It refuses to start — before binding a port — on
 * any error the taxonomy names, rather than serving a half-alive mock (FR-004).
 *
 * The same report data drives both renderings: the human-readable text on `out` and one
 * structured log line through `logger` (FR-024).
 */
import { createLogger, renderRefusal, renderStartupReport, type Logger } from "./logging.js";
import { SqliteStore } from "./store/sqlite.js";
import type { Store } from "./store/index.js";
import { buildMockServer } from "./mock/route.js";
import { loadSpec } from "./spec/load.js";
import { selectOperations } from "./spec/operations.js";
import { buildStartupReport } from "./spec/report.js";
import { deriveModel } from "./spec/resources.js";
import type { StartupReport } from "./spec/types.js";

export type { UnderstudyConfig } from "./config/load.js";
export type { StartupReport } from "./spec/types.js";

export interface MockOptions {
  /** Bind port. `0` asks the OS for an ephemeral port (the tests' choice). */
  port?: number;
  /** Host to bind; defaults to `config.server.host`. */
  host?: string;
  /** Structured-log sink (FR-024). A silent logger by default. */
  logger?: Logger;
  /** Human-readable sink for the startup report. Defaults to stdout. */
  out?: (text: string) => void;
  /** An already-open store, for tests that share one; otherwise a SQLite store at `config.storage.path`. */
  store?: Store;
  /** Called with the bound port once the server is listening (0 if it never bound). */
  onListening?: (port: number) => void;
}

export interface RunningMock {
  /** The mocked surface's base URL, e.g. `http://127.0.0.1:54321`. */
  baseUrl: string;
  port: number;
  /** The report as data — the same object the human and structured renderings came from. */
  report: StartupReport;
  store: Store;
  /** Stop serving and close the store. Idempotent. */
  close(): Promise<void>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Build and start a mock from a validated config. Rejects (having bound nothing) on any
 * refusal the spec names: unreadable/undereferenceable document, empty or unknown
 * selection, invalid config, unwritable store, port in use (FR-004, FR-021).
 */
export async function createMock(
  config: import("./config/load.js").UnderstudyConfig,
  options: MockOptions = {},
): Promise<RunningMock> {
  const logger = options.logger ?? createLogger();
  const out = options.out ?? ((text: string) => process.stdout.write(`${text}\n`));

  try {
    // 1. Load and dereference the document (FR-001).
    const spec = await loadSpec(config.spec);

    // 2. Resolve the selection against it (FR-002, FR-004). Both selector forms are peers.
    const selection = selectOperations(spec.document, config.operations);

    // 3. Derive the model from the live set (FR-023).
    const model = deriveModel(spec.document, selection.live);

    // 4. Build the report from all three (FR-023, FR-024).
    const report = buildStartupReport({
      spec,
      live: selection.live,
      notSelected: selection.notImplemented,
      model,
      selection,
    });

    // 5. Open the store and create one table per derived resource (SC-002, data-model.md §2).
    const store = options.store ?? new SqliteStore({ path: config.storage.path });
    store.open();
    for (const resource of model.resources) store.ensureResource(resource.name);
    store.setMeta("spec_hash", spec.contentHash);

    // 6. Serve the mocked surface. Only after 1–5 have succeeded does anything bind.
    const server = buildMockServer({
      document: spec.document,
      model,
      live: selection.live,
      crud: { store, ids: config.ids },
      basePath: config.server.basePath,
    });

    const port = options.port ?? config.server.port;
    const host = options.host ?? config.server.host;
    await server.listen({ port, host });

    const address = server.server.address();
    const boundPort = isObject(address) && typeof address.port === "number" ? address.port : port;
    options.onListening?.(boundPort);

    // 7. Report — the deliverable, not debug output (FR-023, SC-006).
    const rendered = renderStartupReport(report);
    out(rendered);
    const structured: Record<string, unknown> = { report };
    logger.info("startup report", structured);

    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await server.close();
      store.close();
    };

    return { baseUrl: `http://${host}:${boundPort}`, port: boundPort, report, store, close };
  } catch (error) {
    // FR-004/FR-024: a refusal is human-readable and names the cause; the structured log
    // carries the same fact. Nothing was bound, so nothing has to be torn down.
    out(renderRefusal(error));
    logger.error("refusing to start", {
      error: isObject(error) && "code" in error ? error.code : undefined,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
