/**
 * The startup report, as data (data-model.md §1, FR-023).
 *
 * `spec/report.ts` builds the structure; `logging.ts` renders it. Keeping the data
 * separate from the rendering is what lets the same facts be printed for a human
 * and emitted as structured logs (FR-024).
 */
import { propertiesOf } from "./schema-util.js";
import type { Clock } from "../clock.js";
import type {
  Ambiguity,
  DerivedModel,
  IndexReason,
  PlanSummary,
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
  /** The clock in force (slice 2); absent keeps slice 1's `{ mode: "real" }`. */
  clock?: Clock;
  seed?: number;
  recipe?: string;
  plan?: PlanSummary;
  origins?: StartupReport["origins"];
}

/**
 * The properties worth an index, and why (data-model.md §3): a filter parameter's own name, and
 * the enum values of a sort parameter, kept to properties the schema declares. The reason names
 * the declared list parameter that caused the index, so it is explainable from the report.
 */
export function indexReasons(model: DerivedModel): IndexReason[] {
  const out: IndexReason[] = [];
  for (const resource of model.resources) {
    const properties = propertiesOf(resource);
    const seen = new Set<string>();
    for (const param of resource.listParams) {
      const fields = param.kind === "filter" ? [param.name] : param.kind === "sort" ? (param.values ?? []).map((v) => v.replace(/^[+-]/, "")) : [];
      for (const field of fields) {
        if (seen.has(field) || properties[field] === undefined) continue;
        seen.add(field);
        out.push({
          resource: resource.name,
          field,
          reason: param.kind === "filter" ? `filter parameter "${param.name}"` : `sort parameter "${param.name}"`,
        });
      }
    }
  }
  return out;
}

function operationRef(operation: DocumentOperation): OperationRef {
  const ref: OperationRef = { method: operation.method, path: operation.path };
  if (operation.operationId !== undefined) ref.operationId = operation.operationId;
  return ref;
}

const EMPTY_FORMS: SelectorForm[] = [];

export function buildStartupReport(input: BuildReportInput): StartupReport {
  const resolved: ResolvedSelectionEntry[] = input.selection ? input.selection.resolved : [];
  const ambiguities: Ambiguity[] = [...input.model.ambiguities];
  if (input.clock && !input.clock.pinned) {
    ambiguities.push({
      kind: "clock-unpinned",
      subject: "clock",
      detail:
        "the real clock is not pinned, so time-derived values and record timestamps differ between runs; set clock.start to make a seeded run reproducible",
    });
  }
  return {
    spec: {
      source: input.spec.source,
      version: input.spec.version,
      sourceVersion: input.spec.sourceVersion,
      contentHash: input.spec.contentHash,
    },
    clock: input.clock
      ? { mode: input.clock.mode as "real", pinned: input.clock.pinned, ...(input.clock.pinned ? { instant: input.clock.now().toISOString() } : {}) }
      : { mode: "real" },
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
    ...(input.recipe !== undefined ? { recipe: input.recipe } : {}),
    ...(input.plan !== undefined ? { plan: input.plan } : {}),
    ...(input.origins !== undefined ? { origins: input.origins } : {}),
    indexes: indexReasons(input.model),
    live: input.live.map(operationRef),
    notSelected: input.notSelected.map(operationRef),
    selection: {
      mixed: input.selection ? input.selection.mixed : false,
      forms: input.selection ? input.selection.forms : EMPTY_FORMS,
      resolved,
    },
    resources: input.model.resources,
    relationships: input.model.relationships,
    ambiguities,
  };
}