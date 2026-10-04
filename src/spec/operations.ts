/**
 * Operation collection and selection (FR-002, FR-004).
 *
 * Selection entries are either `operationId` or `METHOD /path`. A selection is
 * resolved as a whole: if any entry names an operation the document does not
 * contain, the whole selection is refused by name.
 */
import { EmptySelectionError, UnknownOperationError } from "../errors.js";
import type { DocumentOperation, SelectionResult } from "./types.js";

export type { DocumentOperation, SelectionResult } from "./types.js";

const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "head", "options"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every operation the document declares, in path-then-method order. */
export function collectOperations(document: Record<string, unknown>): DocumentOperation[] {
  const paths = document.paths;
  if (!isObject(paths)) return [];
  const operations: DocumentOperation[] = [];
  for (const [path, pathItem] of Object.entries(paths)) {
    if (!isObject(pathItem)) continue;
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!isObject(operation)) continue;
      const operationId = typeof operation.operationId === "string" ? operation.operationId : undefined;
      const entry: DocumentOperation = { method: method.toUpperCase(), path, operation };
      if (operationId !== undefined) entry.operationId = operationId;
      operations.push(entry);
    }
  }
  return operations;
}

/** The stable `METHOD /path` key for an operation. */
export function operationKey(operation: DocumentOperation): string {
  return `${operation.method} ${operation.path}`;
}

function findMatches(operations: DocumentOperation[], entry: string): DocumentOperation[] {
  const parts = entry.split(/\s+/);
  if (parts.length === 2) {
    const [method, path] = parts as [string, string];
    const upper = method.toUpperCase();
    const matches = operations.filter((op) => op.method === upper && op.path === path);
    if (matches.length > 0) return matches;
  }
  return operations.filter((op) => op.operationId !== undefined && op.operationId === entry);
}

/**
 * Resolve the configured selection against the document.
 *
 * @throws EmptySelectionError when the selection is empty.
 * @throws UnknownOperationError when an entry names no operation in the document.
 */
export function selectOperations(
  document: Record<string, unknown>,
  selection: readonly string[],
): SelectionResult {
  if (selection.length === 0) throw new EmptySelectionError(selection);

  const all = collectOperations(document);
  const live: DocumentOperation[] = [];
  const liveKeys = new Set<string>();

  for (const entry of selection) {
    const matches = findMatches(all, entry);
    if (matches.length === 0) throw new UnknownOperationError(entry);
    for (const match of matches) {
      const key = operationKey(match);
      if (!liveKeys.has(key)) {
        liveKeys.add(key);
        live.push(match);
      }
    }
  }

  const notImplemented = all.filter((op) => !liveKeys.has(operationKey(op)));
  return { live, notImplemented };
}