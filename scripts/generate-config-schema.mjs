// Generates src/config/schema.generated.ts from the checked-in config contract.
//
// The contract lives at specs/001-slice-1-core/contracts/config.schema.yaml and is
// a JSON document (despite the .yaml extension) so it can be the single source of
// truth with no YAML dependency at build time. We inline a generated copy rather
// than reading the file at runtime because the published package does not ship the
// specs/ tree; the drift test in tests/unit/config.test.ts keeps the copy honest.
//
// Run with: npm run generate
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contractPath = resolve(root, "specs/001-slice-1-core/contracts/config.schema.yaml");
const outPath = resolve(root, "src/config/schema.generated.ts");

const raw = readFileSync(contractPath, "utf8");
const schema = JSON.parse(raw);

const header = [
  "// GENERATED FILE — do not edit by hand.",
  "// Source: specs/001-slice-1-core/contracts/config.schema.yaml",
  "// Regenerate with: npm run generate",
  "",
].join("\n");

const body = `${header}export const configSchema: Record<string, unknown> = ${JSON.stringify(
  schema,
  null,
  2,
)};\n`;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, body);
console.log(`wrote ${outPath}`);