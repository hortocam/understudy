import { createHash } from "node:crypto";
import type { Origin, Store } from "../../src/store/index.js";

/** JSON with every object's keys sorted, so equal states serialise to equal bytes. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export interface SerialiseOptions {
  /** Only these origins (default: all). */
  origins?: Origin[];
  /** Only these resources (default: every resource that holds rows). */
  resources?: string[];
  /** Include created_at / updated_at (default true — a pinned clock makes them reproducible). */
  timestamps?: boolean;
}

const naturalOrder = (a: string, b: string): number => {
  const na = /^\d+$/.test(a) ? Number(a) : NaN;
  const nb = /^\d+$/.test(b) ? Number(b) : NaN;
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
};

/**
 * The deterministic serialisation SC-002/SC-003/SC-007 are asserted over (the shipped export is
 * slice 3's): one line per record, sorted by resource then identity, keys sorted.
 */
export function serialiseStore(store: Store, options: SerialiseOptions = {}): string {
  const resources = (options.resources ?? Object.keys(store.countByOrigin())).slice().sort();
  const lines: string[] = [];
  for (const resource of resources) {
    const rows = store
      .list(resource)
      .filter((r) => !options.origins || options.origins.includes(r.origin))
      .sort((a, b) => naturalOrder(a.identity, b.identity));
    for (const r of rows) {
      lines.push(
        canonicalJson({
          resource: r.resource,
          identity: r.identity,
          origin: r.origin,
          data: r.data,
          ...(options.timestamps === false ? {} : { createdAt: r.createdAt, updatedAt: r.updatedAt }),
        }),
      );
    }
  }
  return lines.join("\n");
}

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
