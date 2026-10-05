/**
 * T038/T039 — the startup report as a first-class deliverable (FR-023, FR-024, SC-006).
 *
 * T038: given a derived model, the report carries *every* resource, *every* relationship
 * **with its `evidence`**, and *every* ambiguity; and a `convention`-sourced link is
 * rendered differently from a `configured` one, so a reader can tell an inference that is a
 * guess from one the user pinned.
 *
 * T039 is asserted here, not duplicated: the human-readable text and the single structured
 * log line are both rendered from the **same** `StartupReport` — the one the running mock
 * also exposes as `report` — so they cannot disagree.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createLogger, renderStartupReport, type Logger } from "../../src/logging.js";
import { loadSpec } from "../../src/spec/load.js";
import { collectOperations } from "../../src/spec/operations.js";
import { buildStartupReport } from "../../src/spec/report.js";
import { deriveModel } from "../../src/spec/resources.js";
import type { RelationshipEvidence } from "../../src/spec/types.js";
import { createMock, type RunningMock } from "../../src/index.js";
import { newStoreDir, storePath } from "../helpers/mock.js";

const fixture = (name: string): string => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

/** Every operation derivation-api.yaml declares, so the whole model is derived. */
async function deriveWholeFixture() {
  const loaded = await loadSpec(fixture("derivation-api.yaml"));
  const live = collectOperations(loaded.document);
  // A `configured` hint is supplied for one link only; the rest are inferred by the document's
  // own conventions, its x-understudy extension, and nesting. That mix is the point: SC-006 asks
  // the report to show *which* rule decided each link.
  const model = deriveModel(loaded.document, live, {
    configuredRelationships: [{ from: "Order", to: "Inventory", field: "inventoryId" }],
  });
  const report = buildStartupReport({ spec: loaded, live, notSelected: [], model });
  return { loaded, live, model, report };
}

describe("the startup report (FR-023, SC-006)", () => {
  it("carries every resource, every relationship with its evidence, and every ambiguity", async () => {
    const { report } = await deriveWholeFixture();

    // Every resource the derivation produced is in the report, by name.
    const reportNames = report.resources.map((resource) => resource.name).sort();
    expect(reportNames).toEqual(["Inventory", "Order", "OrderLine", "Ping", "Supplier", "Warehouse"]);

    // Every relationship carries its evidence — none is silently unlabelled.
    expect(report.relationships).toHaveLength(4);
    expect(report.relationships.every((relationship) => relationship.evidence.length > 0)).toBe(true);
    const evidenceByField = new Map(report.relationships.map((r) => [r.field, r.evidence]));
    expect(evidenceByField.get("inventoryId")).toBe("configured");
    expect(evidenceByField.get("warehouseId")).toBe("extension");
    expect(evidenceByField.get("supplierId")).toBe("convention");

    // Every ambiguity the model found is in the report too — none is dropped on the way.
    expect(report.ambiguities.length).toBeGreaterThan(0);
    expect(report.ambiguities.map((ambiguity) => ambiguity.kind)).toEqual(
      expect.arrayContaining(["route-without-resource", "no-representation-schema"]),
    );
  });

  it("renders every fact as text a human can act on, naming each relationship's evidence source", async () => {
    const { report } = await deriveWholeFixture();
    const text = renderStartupReport(report);

    for (const resource of report.resources) expect(text).toContain(resource.name);
    for (const relationship of report.relationships) {
      expect(text).toContain(`${relationship.from} -> ${relationship.to} via ${relationship.field}`);
      // The evidence source is printed for every link, not just the ones that are guesses.
      expect(text).toContain(`[${relationship.cardinality}, ${relationship.evidence}]`);
    }
    for (const ambiguity of report.ambiguities) {
      expect(text).toContain(ambiguity.kind);
      expect(text).toContain(ambiguity.detail);
    }
  });

  it("renders a convention-sourced link differently from a configured one (SC-006)", async () => {
    const { report } = await deriveWholeFixture();
    const text = renderStartupReport(report);
    const lines = text.split("\n");

    const configuredLine = lines.find((line) => line.includes("Order -> Inventory via inventoryId"));
    const conventionLine = lines.find((line) => line.includes("Order -> Supplier via supplierId"));
    expect(configuredLine, "the configured link must be rendered").toBeDefined();
    expect(conventionLine, "the convention link must be rendered").toBeDefined();

    // The two are told apart by their evidence tag...
    expect(configuredLine).toContain("[one, configured]");
    expect(conventionLine).toContain("[one, convention]");
    // ...so the rendering of a pinned link is not interchangeable with a guessed one.
    expect(configuredLine).not.toBe(conventionLine);
    expect(configuredLine).not.toContain("convention");
    expect(conventionLine).not.toContain("configured");
  });

  it("does not invent a relationship the conventions do not imply", async () => {
    // "hide others": OrderLine.sku links to nothing, Warehouse/Supplier/Inventory carry no
    // matching field — a report that emitted a link for these would be guessing silently.
    const { report } = await deriveWholeFixture();
    const fields = report.relationships.map((relationship) => relationship.field);
    expect(fields).not.toContain("sku");
    expect(fields).not.toContain("name");
    expect(report.relationships.every((relationship) => relationship.from !== relationship.to)).toBe(true);
  });

  it("emits the human text and the structured log line from one source (FR-024, T039)", async () => {
    const { report } = await deriveWholeFixture();

    const text = renderStartupReport(report);
    const logged: string[] = [];
    const logger: Logger = createLogger({ write: (line) => logged.push(line) });
    logger.info("startup report", { report });

    const reportLines = logged
      .map((line) => JSON.parse(line) as { message: string; level: string; report?: unknown })
      .filter((record) => record.message === "startup report");
    // Exactly one structured line, at info, carrying the same report object the text came from.
    expect(reportLines).toHaveLength(1);
    expect(reportLines[0]?.level).toBe("info");
    expect(reportLines[0]?.report).toEqual(report);

    // The facts the human text names are the facts the structured line carries — not a
    // second, independently-derived set that could drift.
    for (const relationship of report.relationships) {
      expect(text).toContain(`[${relationship.cardinality}, ${relationship.evidence}]`);
    }
    const evidenceInLog = new Set(
      report.relationships.map((relationship) => relationship.evidence as RelationshipEvidence),
    );
    for (const evidence of evidenceInLog) {
      expect(text).toContain(`, ${evidence}]`);
    }
  });
});

describe("the running mock emits both renderings from one report (FR-024)", () => {
  let mock: RunningMock | undefined;

  it("prints the report and logs the identical report object", async () => {
    const out: string[] = [];
    const logged: string[] = [];
    const dir = newStoreDir();
    const loaded = await loadSpec(fixture("derivation-api.yaml"));
    const operations = collectOperations(loaded.document).map(
      (operation) => `${operation.method} ${operation.path}`,
    );
    const configText = [
      `spec: ${fixture("derivation-api.yaml")}`,
      "operations:",
      ...operations.map((entry) => `  - ${entry}`),
      `storage: { driver: sqlite, path: ${JSON.stringify(storePath(dir))} }`,
    ].join("\n");
    const { parseConfig } = await import("../../src/config/load.js");
    const config = parseConfig(configText, `${dir}/understudy.yaml`);

    try {
      mock = await createMock(config, {
        port: 0,
        out: (text) => out.push(text),
        logger: createLogger({ write: (line) => logged.push(line) }),
      });

      const text = out.join("\n");
      const reportRecords = logged
        .map((line) => JSON.parse(line) as { message: string; report?: unknown })
        .filter((record) => record.message === "startup report");
      expect(reportRecords).toHaveLength(1);
      // The structured line carries the very report the mock exposes and the text was drawn from.
      expect(reportRecords[0]?.report).toEqual(mock.report);

      // The text names every relationship the report carries, with its evidence.
      for (const relationship of mock.report.relationships) {
        expect(text).toContain(`${relationship.from} -> ${relationship.to} via ${relationship.field}`);
        expect(text).toContain(`[${relationship.cardinality}, ${relationship.evidence}]`);
      }
      // ...and the inferred relationships the document's conventions/extension/nesting imply are
      // all present, so the "same source" claim is not vacuous.
      expect(mock.report.relationships.length).toBeGreaterThan(0);
      expect(text).toContain(`relationships inferred (${mock.report.relationships.length})`);
    } finally {
      await mock?.close();
      mock = undefined;
    }
  });
});
