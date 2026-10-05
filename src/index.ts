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
import { controlApiBytes } from "./control/openapi.js";
import { buildControlInstance } from "./control/server.js";
import { loadSpec } from "./spec/load.js";
import { selectOperations } from "./spec/operations.js";
import { buildStartupReport } from "./spec/report.js";
import { deriveModel } from "./spec/resources.js";
import { loadBehavior } from "./config/layers/behavior.js";
import { loadFixtures } from "./config/layers/fixtures.js";
import { loadImportMappings } from "./config/layers/imports.js";
import { loadRecipes, selectRecipe } from "./config/layers/recipes.js";
import { ConfigRefusedError, type Refusal } from "./errors.js";
import { createClock } from "./clock.js";
import { buildGenerationPlan } from "./data/plan.js";
import { applyFixtures } from "./data/fixtures.js";
import { indexReasons } from "./spec/report.js";
import { effectiveSeed } from "./config/load.js";
import { reconcile } from "./config/reconcile.js";
import { BUILTIN_GENERATOR_NAMES, isFakerPath } from "./data/generators/names.js";
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
  /** The control surface's base URL: the mock's own address unless `control.port` is set. */
  controlUrl: string;
  /** The reserved path prefix of the control surface (`config.control.prefix`). */
  controlPrefix: string;
  /** Resolves once the mock has fully shut down: port released, store closed (FR-017). */
  closed: Promise<void>;
  /** Stop serving and close the store. Idempotent; a second caller awaits the same shutdown. */
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
    // Links pinned in configuration are the `configured` evidence rung (FR-006); the naming
    // convention's rules are configurable (`inference`).
    const configuredRelationships = Object.entries(config.entities).flatMap(([from, entity]) =>
      Object.entries(entity.relations ?? {}).map(([field, relation]) => ({
        from,
        to: relation.to.split(".")[0] as string,
        field,
      })),
    );
    const model = deriveModel(spec.document, selection.live, { configuredRelationships, inference: config.inference });

    // 3b. Load the four configuration layers (FR-001) and reconcile them against the document
    // (FR-005): every cause is collected, so one refusal lists the whole problem. Nothing is
    // written and nothing is bound until this passes. The behaviour and imports layers are
    // validated and consumed nowhere (slices 3–5).
    const fixtures = loadFixtures(config.paths.static, config.baseDir);
    const recipes = loadRecipes(config.paths.dynamic, config.baseDir);
    const recipe = config.recipe === undefined ? undefined : selectRecipe(recipes, config.recipe);
    loadBehavior(config.paths.behavior, config.baseDir);
    loadImportMappings(config.paths.imports, config.baseDir);
    const refusals: Refusal[] = reconcile({
      config,
      model,
      fixtures,
      recipes: [...recipes.values()],
      knownGenerators: BUILTIN_GENERATOR_NAMES,
      isFakerPath,
    });

    // 3c. The plan: generation order over the decided links, cycles reported (FR-008/009), and
    // every refusal it can already see. Nothing is written yet.
    const plan = buildGenerationPlan({ model, ...(recipe ? { recipe } : {}), entities: config.entities });
    refusals.push(...plan.refusals);
    if (refusals.length > 0) throw new ConfigRefusedError(refusals);
    const clock = createClock(config.clock);
    const seed = effectiveSeed(config, recipe);

    // 4. Build the report from all three (FR-023, FR-024).
    const report = buildStartupReport({
      spec,
      live: selection.live,
      notSelected: selection.notImplemented,
      model,
      selection,
      clock,
      seed,
      plan,
      ...(recipe ? { recipe: recipe.name } : {}),
    });

    // 5. Open the store and create one table per derived resource, parents first, each with the
    // real foreign keys of its DECIDED links and an index for every property the document
    // declares filterable/sortable (SC-002, data-model.md §2–§3).
    const store = options.store ?? new SqliteStore({ path: config.storage.path });
    store.open();
    const indexed = new Map<string, string[]>();
    for (const index of indexReasons(model)) indexed.set(index.resource, [...(indexed.get(index.resource) ?? []), index.field]);
    for (const name of plan.order) {
      store.ensureResource(name, {
        foreignKeys: (plan.links[name] ?? []).map((link) => ({ field: link.field, references: link.to, onDelete: link.onDelete })),
        indexes: indexed.get(name) ?? [],
      });
    }
    store.setMeta("spec_hash", spec.contentHash);
    store.setMeta("seed", String(seed));
    store.setMeta("clock_mode", clock.mode);

    // 5b. Fixtures (FR-002): make the store's `static` rows equal the files, in one transaction.
    // Time comes from the clock seam, read once for this run (D8).
    const run = clock.startRun();
    const fixtureSummary = applyFixtures({
      store,
      fixtures,
      resources: model.resources,
      order: plan.order,
      links: plan.links,
      instant: run.now().toISOString(),
    });
    for (const table of fixtureSummary.lookupOnly) {
      model.ambiguities.push({
        kind: "lookup-only",
        subject: table,
        detail: `${table} is a lookup table that names no collection of the live operations: it is held in memory for 'lookup:' rules and is neither stored nor served`,
      });
    }
    report.ambiguities.push(...model.ambiguities.filter((a) => a.kind === "lookup-only" && !report.ambiguities.includes(a)));
    report.origins = store.countByOrigin();

    // 6. Serve the mocked surface and the control plane. Only after 1–5 have succeeded does
    // anything bind.
    const server = buildMockServer({
      document: spec.document,
      model,
      live: selection.live,
      crud: { store, ids: config.ids },
      basePath: config.server.basePath,
      recordRequest: (entry) => store.appendRequest(entry),
    });

    let closing: Promise<void> | undefined;
    let markClosed: () => void = () => {};
    const closed = new Promise<void>((resolve) => {
      markClosed = resolve;
    });

    const prefix = config.control.prefix;
    const control = buildControlInstance({
      prefix,
      store,
      live: report.live,
      notImplemented: report.notSelected,
      resources: model.resources,
      idsStart: config.ids.generatedStart,
      openapiBytes: controlApiBytes,
      onTeardown: () => {
        close().catch((error: unknown) => {
          logger.error("teardown failed", { message: error instanceof Error ? error.message : String(error) });
        });
      },
    });
    await control.ready();

    const port = options.port ?? config.server.port;
    const host = options.host ?? config.server.host;
    const separateControlPort = config.control.port;
    if (separateControlPort === undefined) {
      // Same port: requests under the reserved prefix are handed to the control instance and
      // never reach the mocked surface's catch-all (FR-012).
      server.addHook("onRequest", (request, reply, done) => {
        const rawPath = (request.raw.url ?? "").split("?")[0] ?? "";
        if (rawPath === prefix || rawPath.startsWith(`${prefix}/`)) {
          reply.hijack();
          control.server.emit("request", request.raw, reply.raw);
          return;
        }
        done();
      });
    }
    await server.listen({ port, host });

    const address = server.server.address();
    const boundPort = isObject(address) && typeof address.port === "number" ? address.port : port;
    let controlUrl = `http://${host}:${boundPort}`;
    if (separateControlPort !== undefined) {
      const controlHost = config.control.host ?? host;
      try {
        await control.listen({ port: separateControlPort, host: controlHost });
      } catch (error) {
        // The mocked surface is already bound; do not leave it serving half a mock.
        await server.close();
        store.close();
        throw error;
      }
      const controlAddress = control.server.address();
      const controlPort =
        isObject(controlAddress) && typeof controlAddress.port === "number" ? controlAddress.port : separateControlPort;
      controlUrl = `http://${controlHost}:${controlPort}`;
    }
    options.onListening?.(boundPort);

    // 7. Report — the deliverable, not debug output (FR-023, SC-006).
    const rendered = renderStartupReport(report);
    out(rendered);
    const structured: Record<string, unknown> = { report };
    logger.info("startup report", structured);

    function close(): Promise<void> {
      closing ??= (async () => {
        try {
          await server.close();
          // Harmless when the control instance was only mounted, never listened.
          await control.close();
          store.close();
        } finally {
          markClosed();
        }
      })();
      return closing;
    }

    return {
      baseUrl: `http://${host}:${boundPort}`,
      port: boundPort,
      report,
      store,
      controlUrl,
      controlPrefix: prefix,
      closed,
      close,
    };
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
