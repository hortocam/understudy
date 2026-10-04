/**
 * The startup report, as data (data-model.md §1, FR-023).
 *
 * `spec/report.ts` builds the structure; `logging.ts` renders it. Keeping the data
 * separate from the rendering is what lets the same facts be printed for a human
 * and emitted as structured logs (FR-024).
 */
import type { DerivedModel, DocumentOperation, LoadedSpec, OperationRef, StartupReport } from "./types.js";

export interface BuildReportInput {
  spec: LoadedSpec;
  live: DocumentOperation[];
  notSelected: DocumentOperation[];
  model: DerivedModel;
}

function operationRef(operation: DocumentOperation): OperationRef {
  const ref: OperationRef = { method: operation.method, path: operation.path };
  if (operation.operationId !== undefined) ref.operationId = operation.operationId;
  return ref;
}

export function buildStartupReport(input: BuildReportInput): StartupReport {
  return {
    spec: {
      source: input.spec.source,
      version: input.spec.version,
      sourceVersion: input.spec.sourceVersion,
      contentHash: input.spec.contentHash,
    },
    clock: { mode: "real" },
    live: input.live.map(operationRef),
    notSelected: input.notSelected.map(operationRef),
    resources: input.model.resources,
    relationships: input.model.relationships,
    ambiguities: input.model.ambiguities,
  };
}