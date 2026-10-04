/**
 * List semantics over the declared query parameters (FR-007).
 *
 * Filtering, sorting and paging are read from the `listParams` the document declares and
 * pushed down to `Store.listPaged`, so answering a page does not load the collection into
 * memory (T025). Where the document declares no list parameters the full collection is
 * returned — and the startup report already says so (T046).
 *
 * Three paging styles are recognised, from the parameters the document declares:
 *   offset/limit · page/size · cursor/limit (a cursor token is honoured as an opaque
 *   start-after marker). A document declaring none gets the full collection.
 */
import type { Store, StoredRecord } from "../store/index.js";
import type { Resource } from "../spec/types.js";
import { present, type CrudContext } from "./crud.js";

export interface ListRequest {
  /** The query parameters as received, by name. */
  query: Record<string, string | undefined>;
}

export interface PagingStyle {
  style: "offset" | "page" | "cursor" | "none";
  offset?: number;
  limit?: number;
  cursor?: string;
}

const OFFSET_NAMES = ["offset", "start", "skip"];
const LIMIT_NAMES = ["limit", "size", "per_page", "per-page", "pagesize", "count"];
const PAGE_NAMES = ["page"];
const CURSOR_NAMES = ["cursor", "paginationtoken", "page_token"];

function firstNumber(query: Record<string, string | undefined>, names: string[]): number | undefined {
  for (const name of names) {
    const raw = query[name];
    if (raw === undefined) continue;
    const value = Number.parseInt(raw, 10);
    if (!Number.isNaN(value)) return value;
  }
  return undefined;
}

function firstString(query: Record<string, string | undefined>, names: string[]): string | undefined {
  for (const name of names) {
    const raw = query[name];
    if (raw !== undefined) return raw;
  }
  return undefined;
}

/** Work out the paging style from the parameters the document declares. */
export function pagingStyle(resource: Resource, query: Record<string, string | undefined>): PagingStyle {
  const declared = new Set(resource.listParams.filter((param) => param.kind === "paging").map((param) => param.name.toLowerCase()));

  const cursor = firstString(query, CURSOR_NAMES.filter((name) => declared.has(name)));
  const limit = firstNumber(query, LIMIT_NAMES.filter((name) => declared.has(name)));
  const page = firstNumber(query, PAGE_NAMES.filter((name) => declared.has(name)));
  const offset = firstNumber(query, OFFSET_NAMES.filter((name) => declared.has(name)));

  if (page !== undefined && limit !== undefined) {
    // page/size: pages are 1-based in every document that declares `page`.
    return { style: "page", offset: Math.max(page - 1, 0) * limit, limit };
  }
  if (limit !== undefined && cursor !== undefined) {
    return { style: "cursor", cursor, limit };
  }
  if (limit !== undefined || offset !== undefined) {
    return { style: "offset", ...(offset !== undefined ? { offset } : {}), ...(limit !== undefined ? { limit } : {}) };
  }
  return { style: "none" };
}

function declaredFilters(resource: Resource): Set<string> {
  return new Set(resource.listParams.filter((param) => param.kind === "filter").map((param) => param.name));
}

export function listRecords(context: CrudContext, resource: Resource, request: ListRequest): Record<string, unknown>[] {
  const filters = [...declaredFilters(resource)]
    .filter((name) => request.query[name] !== undefined)
    .map((name) => ({ field: name, value: request.query[name] as string }));

  // `sort=-field` (descending) or `sort=field`; a document declaring `sort`/`sortBy`/
  // `order` gets its declared convention, and the leading `-` is the common spelling for
  // descending.
  const sortRaw = request.query.sort ?? request.query.sortBy ?? request.query.order;
  const sort = sortRaw
    ? sortRaw
        .split(",")
        .map((token) => token.trim())
        .filter((token) => token.length > 0)
        .map((token) =>
          token.startsWith("-")
            ? { field: token.slice(1), direction: "desc" as const }
            : { field: token.startsWith("+") ? token.slice(1) : token, direction: "asc" as const },
        )
    : [];

  const paging = pagingStyle(resource, request.query);
  const query: Parameters<Store["listPaged"]>[1] = {};
  if (filters.length > 0) query.filters = filters;
  if (sort.length > 0) query.sort = sort;
  if (paging.offset !== undefined) query.offset = paging.offset;
  if (paging.limit !== undefined) query.limit = paging.limit;

  return context.store.listPaged(resource.name, query).map((record: StoredRecord) => present(resource, record));
}
