/**
 * Project initialisation (FR-020): scaffold the four configuration layers and an `understudy.yaml`
 * for a specification, and print the tool's inferred collection report — so the developer starts
 * from the tool's understanding of the document rather than a blank directory.
 *
 * `init` is a local act, the same class as `up` (it writes files); it contains NO generation logic.
 * It runs the same derivation pipeline the server runs at startup and renders the same report.
 * No network is touched unless the specification itself is a URL the user supplied.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createClock } from "./clock.js";
import { buildGenerationPlan } from "./data/plan.js";
import { InitConflictError } from "./errors.js";
import { renderStartupReport } from "./logging.js";
import { loadSpec } from "./spec/load.js";
import { collectOperations, selectOperations } from "./spec/operations.js";
import { buildStartupReport } from "./spec/report.js";
import { deriveModel } from "./spec/resources.js";
import type { DerivedModel } from "./spec/types.js";

export interface InitOptions {
  /** A path or URL of the OpenAPI document. */
  spec: string;
  /** The project directory (created if absent). */
  dir: string;
  /** Replace files that already exist. */
  force?: boolean;
}

export interface InitResult {
  /** Files written, relative to the project directory. */
  written: string[];
  /** The report text followed by what was written. */
  report: string;
}

const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;
const FOLDERS = ["static/lookups", "static/entities", "imports", "dynamic", "behavior"];

/** The selection `init` writes: every tag when the document tags every operation, else every `METHOD /path`. */
function defaultSelection(operations: ReturnType<typeof collectOperations>): string[] {
  const tagsOf = (o: (typeof operations)[number]): string[] => (Array.isArray(o.operation.tags) ? (o.operation.tags as string[]) : []);
  if (operations.length > 0 && operations.every((o) => tagsOf(o).length > 0)) {
    const tags = [...new Set(operations.flatMap(tagsOf))].sort();
    const normalised = tags.map((t) => t.trim().replace(/\s+/g, "_"));
    if (new Set(normalised).size === tags.length) return normalised;
  }
  return operations.map((o) => `${o.method} ${o.path}`);
}

/** A starter recipe from the tool's own understanding: parents by `count`, children `perParent` along decided links. */
function starterRecipe(model: DerivedModel): string {
  const probePlan = buildGenerationPlan({ model });
  const inCycle = new Set(probePlan.cycles.flatMap((c) => c.members));
  const decided = model.relationships.filter((r) => r.status === "decided" && r.cardinality === "one");
  const excluded = new Set(inCycle);
  // A collection that links to an excluded one could not attach; leave it out too (transitively).
  for (let changed = true; changed; ) {
    changed = false;
    for (const r of decided) {
      if (excluded.has(r.to) && !excluded.has(r.from)) {
        excluded.add(r.from);
        changed = true;
      }
    }
  }
  const lines = [
    "# A starter recipe written by `ustdy init` from the links the tool inferred (see its report).",
    "# Edit freely: raise a count, add `fields:` rules, state `constraints:`. Apply it with",
    "#   ustdy up --recipe starter        or        ustdy generate --recipe starter",
    "seed: 0",
    "entities:",
  ];
  const skipped: string[] = [];
  for (const resource of model.resources.map((r) => r.name).sort()) {
    if (excluded.has(resource)) {
      skipped.push(resource);
      continue;
    }
    const parentLinks = decided.filter((r) => r.from === resource && r.to !== resource);
    const targets = [...new Set(parentLinks.map((r) => r.to))];
    const first = targets.length === 1 ? targets[0] : undefined;
    const single = first !== undefined && parentLinks.filter((r) => r.to === first).length === 1;
    lines.push(single ? `  ${resource}: { perParent: { entity: ${first}, range: [2, 5] } }` : `  ${resource}: { count: 10 }`);
  }
  if (skipped.length > 0) {
    lines.push("", `# Left out (they sit in, or link into, a relationship cycle — see "generation order" in the report): ${skipped.join(", ")}`);
  }
  return `${lines.join("\n")}\n`;
}

const EXAMPLES: Record<string, string> = {
  "static/lookups/inventory-statuses.yaml.example": `# Rename to inventory-statuses.yaml to load it. A lookup table: small named codes that fixture
# and generated records reference ('lookup: InventoryStatus' in a recipe). Applied identically
# on every run and never mutated by generation (principle IV).
entity: InventoryStatus
idField: id
rows:
  - { id: 1, code: available }
  - { id: 2, code: held }
  - { id: 3, code: sold }
`,
  "static/entities/venues.yaml.example": `# Rename to venues.yaml to load it. Fixed records with fixed identities; generation attaches children to them.
# Keep their identities BELOW ids.generatedStart (default 100000) — an overlap refuses to start.
entity: Venue
rows:
  - { id: 1, name: "Test Arena", city: "Boston", state: "MA" }
`,
  "dynamic/ci-small.yaml.example": `# Rename to ci-small.yaml. A named recipe: apply with \`ustdy up --recipe ci-small\`.
seed: 42
entities:
  Event: { count: 5 }
  Inventory:
    perParent: { entity: Event, range: [10, 50], distribution: zipf }
    fields:
      row:      { faker: "string.alpha", length: 1, casing: upper }
      quantity: { faker: "number.int", min: 2, max: 8 }
      price:    { expr: "cost * $uniform(1.1, 2.5)" }
    constraints:
      - "price >= cost"
`,
  "behavior/webhooks.yaml.example": `# Rename to webhooks.yaml. PARSED AND VALIDATED in this release, ACTED ON in a later one (webhook delivery).
# \${NAME:-default} is kept as text; secrets come from the environment, never this file.
targets:
  pos:
    url: \${USTDY_WEBHOOK_POS_URL:-http://localhost:9000/hooks/pos}
`,
  "imports/events.mapping.yaml.example": `# Rename to events.mapping.yaml. The SHAPE is validated now; import execution arrives in a later release.
source: { file: ./data/events.json, format: json }
targets:
  - entity: Event
    upsertKey: externalId
    fields:
      externalId: "$.id"
      name: "$.title"
`,
};

function configText(spec: string, selection: string[]): string {
  return `# understudy project — written by \`ustdy init\`. Every key is optional except spec and operations.
spec: ${JSON.stringify(spec)}   # a path (relative to this file) or a URL; a URL is the only network call the tool makes

# The operations to make live. Everything else answers 501 "not implemented". An entry is a tag,
# \`METHOD /path\`, or an operationId — three peers; a tag containing a space is written with '_'.
operations:
${selection.map((entry) => `  - ${JSON.stringify(entry)}`).join("\n")}

storage: { driver: sqlite, path: ./.understudy/state.db }
server: { port: 8080 }

# --- Slice 2: configuration and generation ---------------------------------------------------
# recipe: starter     # apply dynamic/starter.yaml at start (or \`ustdy up --recipe starter\`)
# seed: 0             # the global seed (default 0); a recipe's own seed wins, \`--seed\` overrides both
# clock: { mode: real, start: "2026-01-01T00:00:00Z" }   # pin time so a seeded run is byte-reproducible
#
# Pin what the tool reported as undetermined (see "undetermined links" in the report above):
# entities:
#   Order:
#     relations:
#       eventId: { to: Event.id, onDelete: restrict }   # restrict | cascade | setNull
#     ids: { generatedStart: 500000 }                    # an integer identity space; or reserved: "EVT-1..EVT-9"
#
# Naming-convention rules for link inference (defaults shown):
# inference: { idSuffixes: [Id, _id], ambiguousNames: [externalId, referenceId, refId, parentId] }
`;
}

export async function scaffoldProject(options: InitOptions): Promise<InitResult> {
  const loaded = await loadSpec(options.spec);
  const operations = collectOperations(loaded.document);
  const selection = defaultSelection(operations);
  const resolved = selectOperations(loaded.document, selection);
  const model = deriveModel(loaded.document, resolved.live);
  const plan = buildGenerationPlan({ model });
  const report = buildStartupReport({
    spec: loaded,
    live: resolved.live,
    notSelected: resolved.notImplemented,
    model,
    selection: resolved,
    clock: createClock(),
    plan,
  });

  const dir = resolve(options.dir);
  const specValue = URL_LIKE.test(options.spec) ? options.spec : relative(dir, isAbsolute(options.spec) ? options.spec : resolve(options.spec)) || options.spec;
  const files: Record<string, string> = {
    "understudy.yaml": configText(specValue, selection),
    "dynamic/starter.yaml": starterRecipe(model),
    ...EXAMPLES,
  };

  const clashes = Object.keys(files).filter((rel) => existsSync(join(dir, rel)));
  if (clashes.length > 0 && !options.force) throw new InitConflictError(clashes);

  for (const folder of FOLDERS) mkdirSync(join(dir, folder), { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  const written = Object.keys(files).sort();
  const text = [
    renderStartupReport(report),
    "",
    `wrote ${written.length} files under ${dir}:`,
    ...written.map((rel) => `  wrote ${join(dir, rel)}`),
    "",
    "next: review the report above, pin anything undetermined in understudy.yaml, then `ustdy up --recipe starter`.",
  ].join("\n");
  return { written, report: text };
}
