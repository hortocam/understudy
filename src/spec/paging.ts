/**
 * The paging vocabulary, in one place (FR-007, FR-015).
 *
 * The derivation (which classifies a list parameter as paging and a collection's paging
 * style) and the list engine (which acts on those parameters) must agree on what each spelling
 * means, so both import these families instead of keeping private copies that could drift.
 * Spellings are lower-case; callers compare case-insensitively.
 */
import type { ListParam, PagingStyleKind } from "./types.js";

export const OFFSET_NAMES = ["offset", "start", "skip"];
export const LIMIT_NAMES = ["limit", "size", "per_page", "per-page", "pagesize", "count", "maxpagesize", "page_size", "perpage"];
export const PAGE_NAMES = ["page"];
// The target API's measured cursor spellings (docs/05-target-apis.md §1: `paginationToken`),
// plus the common `cursor`/`page_token`/`nextPageToken`.
export const CURSOR_NAMES = ["cursor", "paginationtoken", "page_token", "pagetoken", "nextpagetoken", "token"];

/** Every spelling that makes a query parameter a paging instruction rather than a filter. */
export const PAGING_PARAM_NAMES: ReadonlySet<string> = new Set([...OFFSET_NAMES, ...LIMIT_NAMES, ...PAGE_NAMES, ...CURSOR_NAMES]);

/** Property names whose presence in a response schema marks a cursor carried in the schema. */
const CURSOR_PROPERTIES = new Set(["nextpagetoken", "paginationtoken", "nexttoken", "cursor", "nextcursor"]);

/**
 * A collection's paging style from what its list operation declares (data-model.md §1). The same
 * precedence the list engine applies: page+size, then a cursor, then offset/limit.
 */
export function classifyPaging(listParams: ListParam[], responseProperties: string[] = []): PagingStyleKind {
  const declared = new Set(listParams.filter((p) => p.kind === "paging").map((p) => p.name.toLowerCase()));
  const has = (names: string[]): boolean => names.some((name) => declared.has(name));
  if (has(PAGE_NAMES) && has(LIMIT_NAMES)) return "page-size";
  if (has(CURSOR_NAMES) || responseProperties.some((p) => CURSOR_PROPERTIES.has(p.toLowerCase()))) return "cursor-in-schema";
  if (has(OFFSET_NAMES) || has(LIMIT_NAMES)) return "offset-limit";
  return "none-declared";
}
