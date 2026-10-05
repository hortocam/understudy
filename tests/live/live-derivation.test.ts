/**
 * Scenario 9 / research §0 — the derivation run against the REAL vendor document, opt-in and never
 * CI-blocking: `USTDY_LIVE_SPEC=<url-or-path> npm run test:live`.
 *
 * The StubHub Point of Sale document (docs/05-target-apis.md §1: 165 paths, 224 operations, OpenAPI
 * 3.0.1) is NOT vendored — its redistribution terms are unsettled — so it is fetched on demand
 * (the one network call the tool permits: a spec URL the user supplied), and CI never depends on it.
 *
 * It selects by TAG (the document declares no operationId at all), derives collections, links,
 * identity spaces and paging, and prints how much PINNING the document needs. Set
 * `USTDY_LIVE_REPORT=<file>` to also write the measured outcome as Markdown.
 */
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildGenerationPlan } from "../../src/data/plan.js";
import { loadSpec } from "../../src/spec/load.js";
import { collectOperations, selectOperations } from "../../src/spec/operations.js";
import { deriveModel } from "../../src/spec/resources.js";

const SOURCE = process.env.USTDY_LIVE_SPEC;
/** docs/05-target-apis.md §1 — the recorded size/sha of the document the measurements describe. */
const RECORDED_SHA256 = "2209392493d38a6f2a401a69537df01795adc32609e272c62ccb0b78e1c0af90";
const MEASURED = { paths: 165, operations: 224, tags: 28, ids: { int64: 78, string: 36, int32: 30, uuid: 29 }, cursor: 21, maxPageSize: 18 };

const tally = <T>(items: T[], key: (item: T) => string): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
};

describe.skipIf(SOURCE === undefined)("live derivation (opt-in)", () => {
  it("derives collections, links, identity spaces and paging from the real document, selected by tag, and reports the pinning it needs", async () => {
    const loaded = await loadSpec(SOURCE as string);
    const document = loaded.document as { paths?: Record<string, unknown> };
    const operations = collectOperations(loaded.document);
    const tags = [...new Set(operations.flatMap((o) => (Array.isArray(o.operation.tags) ? (o.operation.tags as string[]) : [])))].sort();
    const withOperationId = operations.filter((o) => o.operationId !== undefined).length;

    // select by tag — every tag, `Market Orders` written with `_` — when every operation is tagged;
    // a document that is not fully tagged falls back to `METHOD /path` (a stand-in document in a local run)
    const allTagged = operations.length > 0 && operations.every((o) => Array.isArray(o.operation.tags) && (o.operation.tags as unknown[]).length > 0);
    const entries = allTagged ? tags.map((t) => t.trim().replace(/\s+/g, "_")) : operations.map((o) => `${o.method} ${o.path}`);
    const selection = selectOperations(loaded.document, entries);
    const model = deriveModel(loaded.document, selection.live);
    const plan = buildGenerationPlan({ model });

    const decided = model.relationships.filter((r) => r.status === "decided");
    const undetermined = model.relationships.filter((r) => r.status === "undetermined");
    const ties = new Set(undetermined.filter((r) => r.to !== "").map((r) => `${r.from}->${r.to}`));
    const external = undetermined.filter((r) => r.to === "");
    const idSpaces = tally(model.resources, (r) => r.idSpace);
    const paging = tally(model.resources, (r) => r.pagingStyle);
    const byEvidence = tally(decided, (r) => r.evidence);
    const ambiguityKinds = tally(model.ambiguities, (a) => a.kind);
    // One pin decides one tie (sibling properties to the same parent); each known-ambiguous name that is
    // really a link needs its own pin. This is an UPPER bound on the pinning needed to decide everything.
    const pinsUpperBound = ties.size + external.length;

    const lines = [
      `source: ${SOURCE} (sha256 ${loaded.contentHash}${loaded.contentHash === RECORDED_SHA256 ? " — matches docs/05" : " — DIFFERS from the sha recorded in docs/05; the vendor document has moved or this is another document"})`,
      `document: OpenAPI ${loaded.sourceVersion}, ${Object.keys(document.paths ?? {}).length} paths, ${operations.length} operations, ${withOperationId} with an operationId, ${tags.length} tags`,
      `selection: ${entries.length} ${allTagged ? "tag" : "METHOD /path"} entries -> ${selection.live.length} live operations (forms: ${selection.forms.join(", ")})`,
      `collections derived: ${model.resources.length}`,
      `identity spaces: ${JSON.stringify(idSpaces)}`,
      `paging styles: ${JSON.stringify(paging)}`,
      `links decided: ${decided.length} ${JSON.stringify(byEvidence)}`,
      `links undetermined: ${undetermined.length} (${ties.size} sibling ties to a single parent; ${external.length} known-ambiguous names with no single target)`,
      `generation order: ${plan.order.length} collections; cycles: ${plan.cycles.length}${plan.cycles.map((c) => ` [${c.members.join(", ")}]`).join("")}`,
      `ambiguities by kind: ${JSON.stringify(ambiguityKinds)}`,
      `PINNING needed to decide every undetermined link: at most ${pinsUpperBound} pins (${ties.size} ties + ${external.length} ambiguous names)`,
      `recorded in docs/05 for comparison: ${MEASURED.paths} paths, ${MEASURED.operations} operations, ${MEASURED.tags} tags, identity types ${JSON.stringify(MEASURED.ids)}, paginationToken x${MEASURED.cursor}, maxPageSize x${MEASURED.maxPageSize}`,
    ];
    console.log(`\n${lines.join("\n")}\n`);
    if (process.env.USTDY_LIVE_REPORT) {
      writeFileSync(process.env.USTDY_LIVE_REPORT, `# Live derivation outcome\n\n${lines.map((l) => `- ${l}`).join("\n")}\n`);
    }

    expect(model.resources.length).toBeGreaterThan(0);
    expect(model.relationships.every((r) => r.evidence !== undefined)).toBe(true);
    expect(plan.order).toHaveLength(model.resources.length);
  });
});
