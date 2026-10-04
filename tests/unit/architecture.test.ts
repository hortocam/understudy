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