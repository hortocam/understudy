/**
 * Generic CRUD semantics over the `Store` seam (FR-005, FR-006, FR-009, FR-011).
 *
 * One code path, driven entirely by the derived `Resource` — there are no per-endpoint
 * handlers (SC-001). Every write is a single store call, which is the shape slice 4's
 * transactional outbox will join (constitution V).
 */
import type { IdsConfig } from "../config/load.js";
import type { Store, StoredRecord } from "../store/index.js";
import type { Resource } from "../spec/types.js";

export interface CrudContext {
  store: Store;
  ids: IdsConfig;
}

/** Coerce a record identity back to the type the document declares (FR-009, FR-011). */
export function typedIdentity(resource: Resource, identity: string): string | number {
  if (resource.idType === "integer") {
    const value = Number.parseInt(identity, 10);
    return Number.isNaN(value) ? identity : value;
  }
  return identity;
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/**
 * Present a stored row in the document's own shape (FR-009): the identity is typed, and
 * nothing the document does not declare is added.
 */
export function present(resource: Resource, record: StoredRecord): Record<string, unknown> {
  return { ...asObject(record.data), [resource.idField]: typedIdentity(resource, record.identity) };
}

export function createRecord(
  context: CrudContext,
  resource: Resource,
  body: unknown,
): Record<string, unknown> {
  const identity = String(context.store.nextIdentity(resource.name, context.ids.generatedStart));
  const data = { ...asObject(body), [resource.idField]: typedIdentity(resource, identity) };
  const record = context.store.insert(resource.name, identity, data, "runtime");
  return present(resource, record);
}

export function readRecord(
  context: CrudContext,
  resource: Resource,
  identity: string,
): Record<string, unknown> | undefined {
  const record = context.store.readOne(resource.name, identity);
  return record ? present(resource, record) : undefined;
}

/**
 * Update one record.
 *
 * - `merge` (PATCH) applies only the fields present in the body, preserving the rest
 *   (FR-006). A body of `{"notes": null}` explicitly clears `notes`; an empty body leaves
 *   the record unchanged, which is the honest reading of "merge with nothing to merge".
 *   The identity is never taken from the body.
 * - `replace` (PUT) swaps the whole representation.
 *
 * Returns undefined when the record does not exist; the caller decides whether that is a
 * declared 404 or a declared create (PUT-create is a slice-2 concern and is not invented
 * here).
 */
export function updateRecord(
  context: CrudContext,
  resource: Resource,
  identity: string,
  body: unknown,
): Record<string, unknown> | undefined {
  const existing = context.store.readOne(resource.name, identity);
  if (!existing) return undefined;

  const patch = asObject(body);
  const next: Record<string, unknown> =
    resource.updateMode === "replace" ? { ...patch } : { ...asObject(existing.data), ...patch };
  next[resource.idField] = typedIdentity(resource, identity);

  const record = context.store.update(resource.name, identity, next);
  return record ? present(resource, record) : undefined;
}

export function deleteRecord(context: CrudContext, resource: Resource, identity: string): boolean {
  return context.store.delete(resource.name, identity);
}
