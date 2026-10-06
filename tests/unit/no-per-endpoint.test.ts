/**
 * SC-001 / constitution "Prohibited": one data-driven code path, NO per-endpoint or per-collection
 * handlers. A structural guard: the engine (`src/data/`, `src/mock/`) must contain no string literal
 * that is a collection title or a camelCase property name drawn from any fixture document — i.e. no
 * `if (name === "Event")` and no field special-cased by its name — and the same engine code must
 * generate conforming data for several different documents.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { conformanceErrors } from "../../src/spec/conform.js";
import { allocateIdentity, typedIdentityValue } from "../../src/spec/identity.js";
import { loadSpec } from "../../src/spec/load.js";
import { collectOperations } from "../../src/spec/operations.js";
import { deriveModel } from "../../src/spec/resources.js";
import { propertiesOf } from "../../src/spec/schema-util.js";
import { fixturePath } from "../helpers/mock.js";
import { makeEnv } from "../helpers/env.js";
import { generateRecord } from "../../src/data/record.js";

const srcDir = fileURLToPath(new URL("../../src", import.meta.url));
const DOCS = ["shop-api.yaml", "collisions-api.yaml", "cycle-api.yaml", "spaces-api.yaml", "cursor-schema-api.yaml", "tags-api.yaml", "inventory-api.yaml", "open-quantifier-api.yaml"];

const tsFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? tsFiles(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));

/** The string literals of a source text, found by the TypeScript parser (comments and apostrophes cannot confuse it). */
function literals(source: string): string[] {
  const out: string[] = [];
  const file = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

/** Document-specific vocabulary: collection titles and camelCase property names. */
async function vocabulary(): Promise<Set<string>> {
  const words = new Set<string>();
  for (const doc of DOCS) {
    const loaded = await loadSpec(fixturePath(doc));
    const model = deriveModel(loaded.document, collectOperations(loaded.document));
    for (const resource of model.resources) {
      words.add(resource.name);
      for (const field of Object.keys(propertiesOf(resource))) if (/^[a-z]+[A-Z]/.test(field)) words.add(field);
    }
  }
  return words;
}

function offenders(files: Array<{ file: string; source: string }>, words: Set<string>): string[] {
  return files.flatMap(({ file, source }) =>
    literals(source)
      .filter((lit) => words.has(lit))
      .map((lit) => `${file}: "${lit}"`),
  );
}

describe("no per-endpoint / per-collection code (SC-001)", () => {
  it("src/data and src/mock contain no literal naming a collection or a document-specific property", async () => {
    const words = await vocabulary();
    expect(words.size).toBeGreaterThan(20); // a real vocabulary, so a pass is not vacuous
    const files = [...tsFiles(join(srcDir, "data")), ...tsFiles(join(srcDir, "mock"))].map((file) => ({ file: file.slice(srcDir.length + 1), source: readFileSync(file, "utf8") }));
    expect(offenders(files, words)).toEqual([]);
  });

  it("the scanner can fail: a special-cased collection or field in a copy of the engine is flagged", async () => {
    const words = await vocabulary();
    const flagged = offenders(
      [
        { file: "data/generate.ts", source: 'if (name === "Event") { rows.reverse(); }' },
        { file: "data/precedence.ts", source: "const hint = field === 'venueId' ? 1 : 2;" },
        { file: "mock/crud.ts", source: "const t = `Inventory`;" },
      ],
      words,
    );
    expect(flagged).toHaveLength(3);
  });

  it("the SAME engine code generates conforming data for several different documents", async () => {
    let collections = 0;
    for (const doc of ["shop-api.yaml", "collisions-api.yaml", "spaces-api.yaml", "cursor-schema-api.yaml"]) {
      const loaded = await loadSpec(fixturePath(doc));
      const model = deriveModel(loaded.document, collectOperations(loaded.document));
      for (const resource of model.resources) {
        const env = await makeEnv({ collection: resource.name });
        for (let i = 1; i <= 25; i += 1) {
          const identity = typedIdentityValue(resource, allocateIdentity(resource, 100000 + i));
          const { record } = await generateRecord({ resource }, env, identity);
          expect(conformanceErrors(resource, record), `${doc} ${resource.name}`).toEqual([]);
        }
        collections += 1;
      }
    }
    expect(collections).toBeGreaterThanOrEqual(15);
  });
});
