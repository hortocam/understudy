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

/**
 * The three specifier shapes the source-text extractor understands:
 *  - `import ... from`, `export ... from` (static, incl. `import type`)
 *  - bare `import "..."` (side effect)
 *  - `import("...")` / `import(`...`)` (dynamic with a *literal* argument)
 * The quote class includes the backtick: a backtick specifier with no substitutions is a
 * literal too, and it is the shape a contributor reaches for when lazy-loading.
 */
const specifierPatterns = [
  /(?:import|export)\s[^;]*?from\s+["'`]([^"'`]+)["'`]/g,
  /\bimport\s+["'`]([^"'`]+)["'`]/g,
  /import\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
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
  return specifiersOf(readFileSync(file, "utf8"));
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
  for (const pattern of specifierPatterns) {
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

  // A synthetic src/cli source that reaches for the store; the checker must flag every
  // statically-resolvable spelling. The backtick-literal case is the one that used to be missed
  // (a backtick specifier with no substitutions is statically resolvable and must be caught).
  const plant = (source: string): string[] =>
    violations([{ file: join(cliDir, "planted.ts"), source }], SLICE2_RULES);

  it("flags every statically-resolvable spelling of an engine import, backtick literals included", () => {
    const shapes: Array<[string, string]> = [
      ["static import", 'import { Store } from "../store/index.js";'],
      ["side-effect import", 'import "../store/index.js";'],
      ["dynamic string literal", 'await import("../store/index.js");'],
      ["dynamic backtick literal", "await import(`../store/index.js`);"],
      ["re-export", 'export * from "../store/index.js";'],
      ["type-only import", 'import type { Store } from "../store/index.js";'],
    ];
    for (const [label, source] of shapes) {
      expect(plant(source), `${label} should be flagged`).toEqual(["src/cli/planted.ts -> ../store/index.js"]);
    }
  });

  it("does not flag a legitimately unrelated module", () => {
    expect(plant('import { helper } from "../control/client.js";')).toEqual([]);
    expect(plant('const x = await import("node:fs");')).toEqual([]);
  });

  // Negative control: the extractor is genuinely blind to a *computed* specifier (that is why the
  // lint gate below exists). If this ever starts extracting, the assertion fails loudly rather
  // than the gate quietly becoming redundant.
  it("is blind to a computed specifier by construction — the eslint gate covers that shape", () => {
    expect(plant('const p = "../store/index.js"; await import(p);')).toEqual([]);
  });
});

/**
 * The computed-specifier half of FR-019. Extracting a computed specifier in general is
 * undecidable, so it is refused outright by an eslint `no-restricted-syntax` rule scoped to
 * `src/cli/` rather than guessed at. These tests run the repository's REAL eslint config (not a
 * re-spelled copy of the selector), so the guard is machine-checked against the file it protects.
 */
describe("module boundary (FR-019) — computed dynamic import is refused by lint", () => {
  async function lintAsCli(source: string, filePath = join(cliDir, "client.ts")): Promise<string[]> {
    const { loadESLint } = await import("eslint");
    const FlatESLint = await loadESLint({ useFlatConfig: true });
    const eslint = new FlatESLint({ cwd: repoRoot });
    const results = await eslint.lintText(source, { filePath });
    return results
      .flatMap((result) => result.messages)
      .filter((message) => message.ruleId === "no-restricted-syntax")
      .map((message) => message.message);
  }

  it("fires on a computed specifier (identifier and substituted template)", async () => {
    expect(await lintAsCli('const p = "../store/index.js";\nawait import(p);')).toHaveLength(1);
    expect(await lintAsCli('const p = "../store";\nawait import(`${p}/index.js`);')).toHaveLength(1);
  });

  it("does not fire on a literal specifier (string or backtick)", async () => {
    expect(await lintAsCli('await import("../store/index.js");')).toEqual([]);
    expect(await lintAsCli("await import(`../store/index.js`);")).toEqual([]);
  });
});
