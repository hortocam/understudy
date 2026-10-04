/**
 * Structured logging and the human-readable startup report (FR-024).
 *
 * Both surfaces are built from the same data: `createLogger` emits JSON lines, and
 * `renderStartupReport` turns the `StartupReport` structure into text a human can
 * act on without reading source (principle VI, SC-006).
 */
import type { StartupReport } from "./spec/types.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  level?: LogLevel;
  write?: (line: string) => void;
  now?: () => Date;
}

/** A JSON-line logger. Every record has `time`, `level` and `message`. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? "info";
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date());

  const emit = (recordLevel: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[recordLevel] < LEVEL_ORDER[level]) return;
    const record = { time: now().toISOString(), level: recordLevel, message, ...fields };
    write(JSON.stringify(record));
  };

  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
  };
}

function operationLabel(op: { method: string; path: string; operationId?: string }): string {
  return `${op.method} ${op.path}${op.operationId ? ` (${op.operationId})` : ""}`;
}

/** Render the startup report as text for a human (FR-024, SC-006). */
export function renderStartupReport(report: StartupReport): string {
  const lines: string[] = [];
  lines.push(`understudy: ${report.spec.source}`);
  lines.push(
    `  spec version ${report.spec.sourceVersion} (normalised to ${report.spec.version}), sha256 ${report.spec.contentHash.slice(0, 12)}`,
  );
  lines.push(`  clock: ${report.clock.mode}`);

  lines.push("");
  lines.push(`live operations (${report.live.length}):`);
  for (const op of report.live) lines.push(`  ${operationLabel(op)}`);

  lines.push("");
  lines.push(`not selected (${report.notSelected.length}):`);
  for (const op of report.notSelected) lines.push(`  ${operationLabel(op)}`);

  lines.push("");
  lines.push(`entities derived (${report.resources.length}):`);
  for (const resource of report.resources) {
    const instance = resource.instancePath ? ` instance ${resource.instancePath}` : "";
    const pattern = resource.idPattern ? ` pattern ${resource.idPattern}` : "";
    lines.push(
      `  ${resource.name} (${resource.collectionPath}${instance}) id=${resource.idField}:${resource.idType}${pattern} name=${resource.nameSource}`,
    );
  }

  lines.push("");
  lines.push(`relationships inferred (${report.relationships.length}):`);
  for (const relationship of report.relationships) {
    lines.push(
      `  ${relationship.from} -> ${relationship.to} via ${relationship.field} [${relationship.cardinality}, ${relationship.evidence}]`,
    );
  }

  lines.push("");
  lines.push(`ambiguities (${report.ambiguities.length}):`);
  for (const ambiguity of report.ambiguities) {
    const where = ambiguity.path ? ` at ${ambiguity.path}` : ambiguity.operationId ? ` on ${ambiguity.operationId}` : "";
    lines.push(`  ${ambiguity.kind}${where}: ${ambiguity.detail}`);
  }

  return lines.join("\n");
}

/** Render a refusal to start as text for a human (FR-024). */
export function renderRefusal(error: unknown): string {
  if (error instanceof Error) return `understudy: refusing to start: ${error.message}`;
  return `understudy: refusing to start: ${String(error)}`;
}