/**
 * Operation collection and selection (FR-002, FR-004).
 *
 * Selection entries are either `operationId` or `METHOD /path`. A selection is
 * resolved as a whole: if any entry names an operation the document does not
 * contain, the whole selection is refused by name.
 */
import { EmptySelectionError, UnknownOperationError } from "../errors.js";
import type { DocumentOperation, ResolvedSelectionEntry, SelectionResult, SelectorForm } from "./types.js";

export type { DocumentOperation, ResolvedSelectionEntry, SelectionResult, SelectorForm } from "./types.js";

const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "head", "options"] as const;

const METHOD_PATH = /^(GET|PUT|POST|DELETE|PATCH|HEAD|OPTIONS)\s+\/.+$/;

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

/**
 * The form an entry is written in, decided by its spelling alone — neither form is a
 * fallback for the other, so an entry never "tries" the other form (FR-002, A2).
 */
export function selectorForm(entry: string): SelectorForm {
  return METHOD_PATH.test(entry.trim()) ? "method-path" : "operationId";
}

function findMatches(operations: DocumentOperation[], entry: string, form: SelectorForm): DocumentOperation[] {
  if (form === "method-path") {
    const [method, path] = entry.trim().split(/\s+/) as [string, string];
    return operations.filter((op) => op.method === method.toUpperCase() && op.path === path);
  }
  return operations.filter((op) => op.operationId !== undefined && op.operationId === entry.trim());
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
  const resolved: ResolvedSelectionEntry[] = [];

  for (const entry of selection) {
    const form = selectorForm(entry);
    const matches = findMatches(all, entry, form);
    if (matches.length === 0) throw new UnknownOperationError(entry);
    for (const match of matches) {
      const key = operationKey(match);
      if (!liveKeys.has(key)) {
        liveKeys.add(key);
        live.push(match);
      }
      const record: ResolvedSelectionEntry = { entry, form, methodPath: key };
      if (match.operationId !== undefined) record.operationId = match.operationId;
      resolved.push(record);
    }
  }

  const notImplemented = all.filter((op) => !liveKeys.has(operationKey(op)));
  const forms = [...new Set(resolved.map((record) => record.form))];
  return { live, notImplemented, resolved, mixed: forms.length > 1, forms };
}