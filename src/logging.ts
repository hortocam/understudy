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
  if (report.clock.pinned === undefined) lines.push(`  clock: ${report.clock.mode}`);
  else if (report.clock.pinned) lines.push(`  clock: ${report.clock.mode}, pinned to ${report.clock.instant ?? "?"}`);
  else lines.push(`  clock: ${report.clock.mode}, unpinned — time-derived values differ between runs (pin with clock.start)`);
  if (report.seed !== undefined) lines.push(`  seed: ${report.seed} (per-collection seeds derive from it and the collection name)`);
  if (report.recipe !== undefined) lines.push(`  recipe: ${report.recipe}`);

  lines.push("");
  lines.push(`live operations (${report.live.length}):`);
  for (const op of report.live) lines.push(`  ${operationLabel(op)}`);

  // FR-023 (amendment A2): when a selection mixes the two selector forms, say which form
  // resolved each live operation. Printed only when there is a mix to explain, so the
  // common single-form report is not noise.
  if (report.selection.mixed) {
    lines.push("");
    lines.push(`selection resolved by several forms (${report.selection.forms.join(" + ")}):`);
    for (const entry of report.selection.resolved) {
      lines.push(`  ${entry.form}: "${entry.entry}" -> ${entry.methodPath}`);
    }
  }

  lines.push("");
  lines.push(`not selected (${report.notSelected.length}):`);
  for (const op of report.notSelected) lines.push(`  ${operationLabel(op)}`);

  lines.push("");
  lines.push(`entities derived (${report.resources.length}):`);
  for (const resource of report.resources) {
    const instance = resource.instancePath ? ` instance ${resource.instancePath}` : "";
    const pattern = resource.idPattern ? ` pattern ${resource.idPattern}` : "";
    const params = `params=[${resource.listParams.map((param) => `${param.name}:${param.kind}`).join(",")}]`;
    lines.push(
      `  ${resource.name} (${resource.collectionPath}${instance}) id=${resource.idField}:${resource.idType}${pattern} space=${resource.idSpace} paging=${resource.pagingStyle} ${params} name=${resource.nameSource}`,
    );
  }

  lines.push("");
  const decided = report.relationships.filter((r) => r.status === "decided");
  const undetermined = report.relationships.filter((r) => r.status === "undetermined");
  lines.push(`relationships inferred (${decided.length}):`);
  for (const relationship of decided) {
    lines.push(
      `  ${relationship.from} -> ${relationship.to} via ${relationship.field} [${relationship.cardinality}, ${relationship.evidence}]`,
    );
  }

  // FR-006/FR-007: a link the convention proposed but could not decide is listed on its own,
  // with what competed, and is neither used for ordering nor given a foreign key.
  lines.push("");
  lines.push(`undetermined links (${undetermined.length}) — reported, not acted on:`);
  for (const link of undetermined) {
    const target = link.to === "" ? "(no single target)" : `-> ${link.to}`;
    const candidates = link.candidates && link.candidates.length > 0 ? `  candidates: ${link.candidates.join(", ")}` : "";
    lines.push(`  ${link.from}.${link.field} ${target} [${link.evidence}]${candidates}`);
    lines.push(`    pin it with entities.${link.from}.relations.${link.field}: { to: <Collection>.<id> } if it is a link`);
  }

  if (report.plan) {
    lines.push("");
    lines.push(`generation order: ${report.plan.order.join(", ")}`);
    for (const cycle of report.plan.cycles) {
      lines.push(`  cycle (${cycle.members.join(", ")}): generated in that order; unresolved: ${cycle.unresolved.join(", ") || "none"}`);
    }
    const counted = Object.entries(report.plan.counts);
    if (counted.length > 0) {
      lines.push("configured counts:");
      for (const [name, count] of counted) {
        if (count.kind === "absolute") lines.push(`  ${name}: ${count.n} records`);
        else if (count.kind === "perParent") {
          lines.push(`  ${name}: ${count.range[0]}..${count.range[1]} per ${count.parent} (via ${count.field}, ${count.distribution})`);
        } else lines.push(`  ${name}: from an import (not generated; slice 3)`);
      }
    }
  }

  if (report.identity && report.identity.length > 0) {
    lines.push("");
    lines.push("identity ranges (reserved per collection, kept disjoint from fixtures):");
    for (const id of report.identity) {
      const detail = id.unreservable ? "no range can be reserved in this space (reported, not guessed)" : `reserved ${id.reserved}`;
      lines.push(`  ${id.resource}: ${id.space} — ${detail} [${id.declared}]`);
    }
  }

  if (report.indexes.length > 0) {
    lines.push("");
    lines.push("indexed because the document declares them filterable/sortable:");
    for (const index of report.indexes) lines.push(`  ${index.resource}.${index.field} (${index.reason})`);
  }

  if (report.generation) {
    const g = report.generation;
    lines.push("");
    lines.push(
      g.regenerated
        ? `generation: recipe ${g.recipe}, seed ${g.seed} — ${Object.values(g.created).reduce((n, c) => n + (c.generated ?? 0), 0)} records created, ${g.redraws} invariant redraws`
        : `generation: recipe ${g.recipe}, seed ${g.seed} — already applied to this store; nothing regenerated`,
    );
    for (const [collection, counts] of Object.entries(g.created)) {
      lines.push(`  created ${collection}: ${Object.entries(counts).map(([o, n]) => `${o} ${n}`).join(", ")}`);
    }
    for (const fallback of g.fallbacks) {
      lines.push(`  fallback: ${fallback.collection}.${fallback.field} chosen by ${fallback.rule} (level ${fallback.level}) for ${fallback.count} records`);
    }
    for (const note of g.notes) lines.push(`  note: ${note}`);
  }

  if (report.origins) {
    lines.push("");
    lines.push("records by origin:");
    for (const [name, counts] of Object.entries(report.origins)) {
      lines.push(`  ${name}: ${Object.entries(counts).map(([origin, n]) => `${origin} ${n}`).join(", ")}`);
    }
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