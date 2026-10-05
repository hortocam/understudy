import type { DerivedModel } from "../../src/spec/types.js";

/**
 * The stable, golden-comparable view of a derived model: sorted, free of prose. The goldens it is
 * compared against are authored by hand from the spec's rules (FR-006, FR-015, FR-017), never
 * captured from the code that is under test.
 */
export function serialiseModel(model: DerivedModel): Record<string, unknown> {
  const bySubject = (a: { kind: string; subject?: string; path?: string }, b: typeof a): number =>
    `${a.kind}|${a.subject ?? a.path ?? ""}`.localeCompare(`${b.kind}|${b.subject ?? b.path ?? ""}`);
  return {
    resources: model.resources
      .map((r) => ({
        name: r.name,
        idField: r.idField,
        idType: r.idType,
        idSpace: r.idSpace,
        pagingStyle: r.pagingStyle,
        filterFields: r.filterFields,
        sortFields: r.sortFields,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    relationships: model.relationships
      .map((r) => ({
        from: r.from,
        to: r.to,
        field: r.field,
        evidence: r.evidence,
        status: r.status,
        ...(r.candidates !== undefined ? { candidates: r.candidates } : {}),
      }))
      .sort((a, b) => `${a.from}|${a.field}`.localeCompare(`${b.from}|${b.field}`)),
    ambiguities: model.ambiguities
      .map((a) => ({
        kind: a.kind,
        ...(a.subject !== undefined ? { subject: a.subject } : {}),
        ...(a.subject === undefined && a.path !== undefined ? { path: a.path } : {}),
      }))
      .sort(bySubject),
  };
}
