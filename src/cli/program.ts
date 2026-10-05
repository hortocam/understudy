/**
 * The `ustdy` command set (T036, T037; FR-019, FR-020).
 *
 * Every command issues one control request and renders the answer — nothing more. `up` is
 * the single exception: something has to construct and start the server, so it builds it
 * from the config through the library entry (`createMock`) and then polls `/health`.
 *
 * This module must not import `src/mock/`, `src/store/` or `src/spec/`
 * (`tests/unit/architecture.test.ts`).
 */
import { existsSync } from "node:fs";
import { Command, CommanderError } from "commander";
import { loadConfig, type UnderstudyConfig } from "../config/load.js";
import { createMock } from "../index.js";
import { renderRefusal } from "../logging.js";
import {
  ControlClient,
  ControlConnectionError,
  ControlRequestError,
  type OperationRef,
  type RequestLogEntry,
} from "./client.js";

/** The CLI's only windows to the outside, so tests can drive it in-process. */
export interface CliIo {
  out: (text: string) => void;
  err: (text: string) => void;
  env: Record<string, string | undefined>;
}

const DEFAULT_CONFIG = "understudy.yaml";
const DEFAULT_CONTROL_URL = "http://127.0.0.1:8080/__understudy";
const READY_TIMEOUT_MS = 10_000;
const POLL_MS = 50;

function label(op: OperationRef): string {
  return `${op.method} ${op.path}${op.operationId ? ` (${op.operationId})` : ""}`;
}

function controlUrlFor(config: UnderstudyConfig): string {
  const host = config.control.host ?? config.server.host;
  const port = config.control.port ?? config.server.port;
  return `http://${host}:${port}${config.control.prefix}`;
}

/**
 * `--control-url`, else `USTDY_CONTROL_URL`, else composed from the config file (`--config`,
 * `USTDY_CONFIG`, or ./understudy.yaml when it exists), else the documented defaults.
 */
function resolveControlUrl(options: { controlUrl?: string; config?: string }, io: CliIo): string {
  if (options.controlUrl) return options.controlUrl;
  const fromEnv = io.env.USTDY_CONTROL_URL;
  if (fromEnv) return fromEnv;
  const configPath = options.config ?? io.env.USTDY_CONFIG;
  if (configPath) return controlUrlFor(loadConfig(configPath));
  if (existsSync(DEFAULT_CONFIG)) return controlUrlFor(loadConfig(DEFAULT_CONFIG));
  return DEFAULT_CONTROL_URL;
}

function parsePort(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) > 65535) {
    throw new CommanderError(1, "ustdy.badPort", `error: "${value}" is not a valid port`);
  }
  return Number(value);
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/**
 * Parse `USTDY_OPERATIONS` (FR-020): entries separated by commas or newlines, surrounding
 * whitespace trimmed, empty entries dropped. An entry keeps its internal spelling — a
 * `METHOD /path` entry's single space is significant and is *not* collapsed here.
 */
function parseOperationsEnv(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * The operation selection for `up` (FR-020, contracts/cli.md): an explicit `--operation`
 * (repeatable), else `USTDY_OPERATIONS`, else the loaded config's own `operations`. An
 * explicit selection **overrides** the config file's; when neither is given the config's
 * stands. Resolution and validation stay engine-side — this only composes the config.
 */
function resolveSelection(
  options: { operation: string[] },
  env: Record<string, string | undefined>,
  config: UnderstudyConfig,
): string[] {
  if (options.operation.length > 0) return options.operation;
  if (env.USTDY_OPERATIONS !== undefined) return parseOperationsEnv(env.USTDY_OPERATIONS);
  return config.operations;
}

function formatLogEntry(entry: RequestLogEntry): string {
  const kind = entry.live ? "live" : "not-implemented";
  return `${entry.at}  ${entry.status}  ${entry.method} ${entry.path}  ${kind}  ${entry.durationMs}ms`;
}

async function waitForHealth(client: ControlClient): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    try {
      await client.health();
      return;
    } catch (error) {
      if (!(error instanceof ControlConnectionError) || Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }
}

async function waitForRelease(client: ControlClient): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (!(await client.isGone())) {
    if (Date.now() > deadline) throw new ControlRequestError(0, "the control plane is still answering after teardown");
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

export function buildProgram(io: CliIo): Command {
  const program = new Command();
  program
    .name("ustdy")
    .description("Declarative, stateful mocking of third-party APIs and webhook events from an OpenAPI spec.")
    .version("0.1.0")
    .addHelpText(
      "after",
      [
        "",
        "Environment:",
        "  USTDY_CONFIG       config file path (default: ./understudy.yaml)",
        "  USTDY_CONTROL_URL  control plane base URL, e.g. http://127.0.0.1:8080/__understudy",
        "  USTDY_OPERATIONS   operations to make live for `up`, comma- or newline-separated",
        "",
        "Every command except `up` is a client of the running mock's control plane.",
      ].join("\n"),
    )
    .exitOverride()
    .configureOutput({ writeOut: (text) => io.out(text.replace(/\n$/, "")), writeErr: (text) => io.err(text.replace(/\n$/, "")) });

  const clientCommand = (name: string, description: string): Command =>
    program
      .command(name)
      .description(description)
      .option("--config <path>", "config file, used only to compose the default control URL")
      .option("--control-url <url>", "control plane base URL (default: composed from the config, or USTDY_CONTROL_URL)");

  program
    .command("up")
    .description("start the mock from a config and wait until its control plane is healthy")
    .option("--config <path>", "config file (default: USTDY_CONFIG, else ./understudy.yaml)")
    .option("--port <n>", "port for the mocked surface (overrides server.port)", parsePort)
    .option("--control-port <n>", "separate port for the control plane (overrides control.port)", parsePort)
    .option("--control-url <url>", "control plane base URL to poll for readiness")
    .option(
      "--operation <entry>",
      "operation to make live, as `METHOD /path` or `operationId` (repeatable; default: the config's operations, or USTDY_OPERATIONS)",
      collect,
      [] as string[],
    )
    .action(
      async (options: {
        config?: string;
        port?: number;
        controlPort?: number;
        controlUrl?: string;
        operation: string[];
      }) => {
        const configPath = options.config ?? io.env.USTDY_CONFIG ?? DEFAULT_CONFIG;
        let config: UnderstudyConfig;
        try {
          config = loadConfig(configPath);
        } catch (error) {
          throw new ControlRequestError(0, renderRefusal(error));
        }
        if (options.controlPort !== undefined) config = { ...config, control: { ...config.control, port: options.controlPort } };
        // FR-020: fold the start-time selection into the config createMock sees, so an
        // explicit choice overrides the file's `operations` without any engine-side change.
        config = { ...config, operations: resolveSelection(options, io.env, config) };

        let mock;
        try {
          mock = await createMock(config, {
            ...(options.port !== undefined ? { port: options.port } : {}),
            out: io.out,
          });
        } catch (error) {
          // createMock has already printed the refusal; only the exit status remains.
          throw new ControlRequestError(0, error instanceof Error ? error.message : String(error));
        }

        const client = new ControlClient(options.controlUrl ?? `${mock.controlUrl}${mock.controlPrefix}`);
        await waitForHealth(client);
        io.out(`ready: control plane at ${client.baseUrl}  mock at ${mock.baseUrl}`);
        const stop = (): void => void mock.close();
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
        await mock.closed;
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      },
    );

  clientCommand("down", "tear the running mock down and wait until its port is released").action(
    async (options: { config?: string; controlUrl?: string }) => {
      const client = new ControlClient(resolveControlUrl(options, io));
      await client.teardown();
      await waitForRelease(client);
      io.out(`torn down: ${client.baseUrl} released`);
    },
  );

  const ops = program.command("ops").description("operations of the running mock");
  ops
    .command("list")
    .description("list live and not-implemented operations")
    .option("--config <path>", "config file, used only to compose the default control URL")
    .option("--control-url <url>", "control plane base URL")
    .action(async (options: { config?: string; controlUrl?: string }) => {
      const answer = await new ControlClient(resolveControlUrl(options, io)).operations();
      io.out(`live operations (${answer.live.length}):`);
      for (const op of answer.live) io.out(`  ${label(op)}`);
      io.out(`not implemented (${answer.notImplemented.length}):`);
      for (const op of answer.notImplemented) io.out(`  ${label(op)}`);
    });

  clientCommand("reset", "reset the mock's data and report the rows removed per entity")
    .option("--to <mode>", "reset mode; slice 1 implements only \"wipe\"", "wipe")
    .option("--entity <name>", "limit the reset to an entity (repeatable)", collect, [] as string[])
    .action(async (options: { config?: string; controlUrl?: string; to: string; entity: string[] }) => {
      const answer = await new ControlClient(resolveControlUrl(options, io)).reset({
        mode: options.to,
        ...(options.entity.length > 0 ? { entities: options.entity } : {}),
      });
      io.out(`reset (${answer.mode}): rows removed per entity`);
      for (const [entity, removed] of Object.entries(answer.removed)) io.out(`  ${entity}: ${removed}`);
    });

  const logs = program.command("logs").description("logs of the running mock");
  logs
    .command("requests")
    .description("print the request log, newest first")
    .option("--config <path>", "config file, used only to compose the default control URL")
    .option("--control-url <url>", "control plane base URL")
    .option("--method <method>", "only this HTTP method")
    .option("--status <code>", "only this response status")
    .option("--live", "only requests that hit a live (selected) operation")
    .option("--limit <n>", "at most this many entries")
    .action(
      async (options: { config?: string; controlUrl?: string; method?: string; status?: string; live?: boolean; limit?: string }) => {
        const answer = await new ControlClient(resolveControlUrl(options, io)).requests({
          ...(options.method !== undefined ? { method: options.method } : {}),
          ...(options.status !== undefined ? { status: options.status } : {}),
          ...(options.live ? { live: true } : {}),
          ...(options.limit !== undefined ? { limit: options.limit } : {}),
        });
        for (const entry of answer.requests) io.out(formatLogEntry(entry));
      },
    );

  return program;
}

/** Run the CLI and return its exit status. Never throws. */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const program = buildProgram(io);
  try {
    await program.parseAsync(argv);
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    if (error instanceof ControlConnectionError || error instanceof ControlRequestError) {
      // `up` refusals were already printed in full by the config loader / createMock.
      io.err(error.message.startsWith("understudy:") ? error.message : `ustdy: ${error.message}`);
      return 1;
    }
    io.err(`ustdy: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
