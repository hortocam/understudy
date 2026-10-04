/**
 * The startup report, as data (data-model.md §1, FR-023).
 *
 * `spec/report.ts` builds the structure; `logging.ts` renders it. Keeping the data
 * separate from the rendering is what lets the same facts be printed for a human
 * and emitted as structured logs (FR-024).
 */
import type {
  DerivedModel,
  DocumentOperation,
  LoadedSpec,
  OperationRef,
  ResolvedSelectionEntry,
  SelectionResult,
  SelectorForm,
  StartupReport,
} from "./types.js";

export interface BuildReportInput {
  spec: LoadedSpec;
  live: DocumentOperation[];
  notSelected: DocumentOperation[];
  model: DerivedModel;
  /**
   * How the configured selection resolved. Optional so a caller that already holds the
   * two operation sets can build a report without re-running selection; absent, the report
   * carries no form data (FR-023's form obligation is met when it is supplied).
   */
  selection?: SelectionResult;
}

function operationRef(operation: DocumentOperation): OperationRef {
  const ref: OperationRef = { method: operation.method, path: operation.path };
  if (operation.operationId !== undefined) ref.operationId = operation.operationId;
  return ref;
}

const EMPTY_FORMS: SelectorForm[] = [];

export function buildStartupReport(input: BuildReportInput): StartupReport {
  const resolved: ResolvedSelectionEntry[] = input.selection ? input.selection.resolved : [];
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
    selection: {
      mixed: input.selection ? input.selection.mixed : false,
      forms: input.selection ? input.selection.forms : EMPTY_FORMS,
      resolved,
    },
    resources: input.model.resources,
    relationships: input.model.relationships,
    ambiguities: input.model.ambiguities,
  };
}