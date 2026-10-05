// Generates src/control/openapi.generated.ts from the checked-in control-API contract.
//
// The contract lives at specs/002-data-layer/contracts/control-api.openapi.json and is
// genuine JSON, so the control plane can serve it byte-for-byte (FR-018) under the
// `application/json` content type it declares — the bytes and the declared type agree, and a
// consumer can parse the served document directly. (It was YAML served as application/json
// before the 2026-10-05 contract reconciliation; the declared type was the contract's own and
// the bytes could not satisfy it.) We inline a copy rather than reading the file at runtime
// because the published package does not ship the specs/ tree; the drift test in
// tests/integration/control.test.ts compares the served bytes with the checked-in file.
//
// Run with: npm run generate
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contractPath = resolve(root, "specs/002-data-layer/contracts/control-api.openapi.json");
const outPath = resolve(root, "src/control/openapi.generated.ts");

const raw = readFileSync(contractPath, "utf8");

const header = [
  "// GENERATED FILE — do not edit by hand.",
  "// Source: specs/002-data-layer/contracts/control-api.openapi.json",
  "// Regenerate with: npm run generate",
  "",
].join("\n");

const body = `${header}export const controlApiDocument: string = ${JSON.stringify(raw)};\n`;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, body);
console.log(`wrote ${outPath}`);
