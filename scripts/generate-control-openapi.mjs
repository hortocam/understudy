// Generates src/control/openapi.generated.ts from the checked-in control-API contract.
//
// The contract lives at specs/001-slice-1-core/contracts/control-api.openapi.yaml and is
// genuine YAML. The control plane serves it byte-for-byte (FR-018), so the generated copy
// carries the file's exact text as one string. We inline a copy rather than reading the file
// at runtime because the published package does not ship the specs/ tree; the drift test in
// tests/integration/control.test.ts compares the served bytes with the checked-in file.
//
// Run with: npm run generate
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contractPath = resolve(root, "specs/001-slice-1-core/contracts/control-api.openapi.yaml");
const outPath = resolve(root, "src/control/openapi.generated.ts");

const raw = readFileSync(contractPath, "utf8");

const header = [
  "// GENERATED FILE — do not edit by hand.",
  "// Source: specs/001-slice-1-core/contracts/control-api.openapi.yaml",
  "// Regenerate with: npm run generate",
  "",
].join("\n");

const body = `${header}export const controlApiDocument: string = ${JSON.stringify(raw)};\n`;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, body);
console.log(`wrote ${outPath}`);
