/**
 * Operation collection and selection (FR-002, FR-004).
 *
 * Selection entries are an `operationId`, a `METHOD /path`, or a tag — three peers with no
 * precedence (FR-002; slice 2 adds the tag form because the measured target declares no
 * `operationId` at all). A selection is resolved as a whole: if any entry names an operation the document does not
 * contain, the whole selection is refused by name.
 */
import { AmbiguousSelectionError, EmptySelectionError, UnknownOperationError } from "../errors.js";
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

/** A tag written with `_` for each space (`Market Orders` -> `Market_Orders`), the config spelling. */
function normaliseTag(tag: string): string {
  return tag.trim().replace(/\s+/g, "_");
}

function tagsOf(operation: DocumentOperation): string[] {
  const tags = operation.operation.tags;
  return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === "string") : [];
}

/** Every distinct tag the operations carry (the document's top-level `tags` array is optional). */
function distinctTags(operations: DocumentOperation[]): string[] {
  return [...new Set(operations.flatMap(tagsOf))];
}

/**
 * The form an entry is written in, when its spelling alone decides it: `METHOD /path` is
 * unmistakable; anything else is an `operationId` or a tag and is decided by what the document
 * contains (`resolveEntry`) — never by trying one as a fallback for the other.
 */
export function selectorForm(entry: string): SelectorForm {
  return METHOD_PATH.test(entry.trim()) ? "method-path" : "operationId";
}

interface Resolution {
  form: SelectorForm;
  matches: DocumentOperation[];
}

/**
 * Resolve one entry against the document. The three forms are peers: the entry is looked up in
 * each, and if it names something in more than one form (an operationId spelled like a tag), or
 * collapses two distinct tags into one spelling, the entry is refused by name rather than
 * resolved by a hidden priority.
 */
function resolveEntry(operations: DocumentOperation[], entry: string): Resolution | undefined {
  const trimmed = entry.trim();
  if (METHOD_PATH.test(trimmed)) {
    const [method, path] = trimmed.split(/\s+/) as [string, string];
    const matches = operations.filter((op) => op.method === method.toUpperCase() && op.path === path);
    return matches.length > 0 ? { form: "method-path", matches } : undefined;
  }
  const byId = operations.filter((op) => op.operationId !== undefined && op.operationId === trimmed);
  const matchingTags = distinctTags(operations).filter((tag) => tag === trimmed || normaliseTag(tag) === trimmed);
  if (matchingTags.length > 1) {
    throw new AmbiguousSelectionError(entry, matchingTags.map((tag) => `tag "${tag}"`));
  }
  const byTag = matchingTags[0] === undefined ? [] : operations.filter((op) => tagsOf(op).includes(matchingTags[0] as string));
  if (byId.length > 0 && byTag.length > 0) {
    throw new AmbiguousSelectionError(entry, [`the operationId of ${operationKey(byId[0] as DocumentOperation)}`, `the tag "${matchingTags[0]}"`]);
  }
  if (byId.length > 0) return { form: "operationId", matches: byId };
  if (byTag.length > 0) return { form: "tag", matches: byTag };
  return undefined;
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
    const resolution = resolveEntry(all, entry);
    if (!resolution) throw new UnknownOperationError(entry);
    const { form, matches } = resolution;
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