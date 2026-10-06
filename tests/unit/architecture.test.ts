import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const cliDir = join(repoRoot, "src", "cli");
const forbidden = [
  join(repoRoot, "src", "mock"),
  join(repoRoot, "src", "store"),
  join(repoRoot, "src", "spec"),
];

function tsFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...tsFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) found.push(full);
  }
  return found;
}

function importSpecifiers(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const specifiers: string[] = [];
  const patterns = [
    /(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g,
    /\bimport\s+["']([^"']+)["']/g,
    /import\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const specifier = match[1];
      if (specifier) specifiers.push(specifier);
    }
  }
  return specifiers;
}

function isInside(target: string, dir: string): boolean {
  return target === dir || target.startsWith(`${dir}/`);
}

/** Import edges `from -> to` (relative specifiers only) that cross a forbidden boundary. */
export function violations(
  files: Array<{ file: string; source: string }>,
  rules: Array<{ from: string; to: string[] }>,
): string[] {
  const offenders: string[] = [];
  for (const { file, source } of files) {
    const rule = rules.find((r) => isInside(file, r.from));
    if (!rule) continue;
    for (const specifier of specifiersOf(source)) {
      if (!specifier.startsWith(".")) continue;
      const target = resolve(dirname(file), specifier);
      if (rule.to.some((dir) => isInside(target, dir))) offenders.push(`${relative(repoRoot, file)} -> ${specifier}`);
    }
  }
  return offenders;
}

function specifiersOf(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g,
    /\bimport\s+["']([^"']+)["']/g,
    /import\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) if (match[1]) specifiers.push(match[1]);
  }
  return specifiers;
}

const src = (name: string): string => join(repoRoot, "src", name);
const SLICE2_RULES = [
  { from: src("spec"), to: [src("data")] },
  { from: src("cli"), to: [src("data"), src("spec"), src("store"), src("mock")] },
  { from: src("data"), to: [src("cli"), src("mock"), src("control")] },
];

describe("slice-2 module boundaries (plan Structure Decision)", () => {
  it("spec/ never imports data/; cli/ imports no engine module; data/ imports no surface module", () => {
    const files = tsFiles(join(repoRoot, "src")).map((file) => ({ file, source: readFileSync(file, "utf8") }));
    expect(violations(files, SLICE2_RULES)).toEqual([]);
  });

  it("the checker can fail: a synthetic violating import is flagged", () => {
    const flagged = violations(
      [
        { file: join(src("spec"), "x.ts"), source: 'import { a } from "../data/generate.js";' },
        { file: join(src("cli"), "y.ts"), source: 'import("../data/seed.js");' },
        { file: join(src("data"), "z.ts"), source: 'export * from "../mock/crud.js";' },
      ],
      SLICE2_RULES,
    );
    expect(flagged).toHaveLength(3);
  });

  it("no library source reads process.env (the CLI entry is the one process boundary that hands env in)", () => {
    const readers = tsFiles(join(repoRoot, "src"))
      .filter((file) => file !== join(src("cli"), "index.ts"))
      .filter((file) => /process\.env/.test(readFileSync(file, "utf8")));
    expect(readers.map((f) => relative(repoRoot, f))).toEqual([]);
  });
});

describe("module boundary (FR-019)", () => {
  it("no file under src/cli imports src/mock, src/store or src/spec", () => {
    const offenders: string[] = [];
    for (const file of tsFiles(cliDir)) {
      for (const specifier of importSpecifiers(file)) {
        if (!specifier.startsWith(".")) continue;
        const target = resolve(dirname(file), specifier);
        if (forbidden.some((dir) => isInside(target, dir))) {
          offenders.push(`${relative(repoRoot, file)} -> ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});