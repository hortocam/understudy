import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**", ".specify/**", "specs/**", ".worktrees/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: { console: "readonly", process: "readonly" },
    },
  },
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // FR-019: the CLI is a thin client of the control plane. A *computed* dynamic-import
    // specifier cannot be resolved by static analysis (the architecture test reads the
    // source text), so a specifier that is neither a string literal nor a backtick literal
    // with no substitutions is refused outright here. A backtick *literal* is allowed: it is
    // statically resolvable and the architecture test extracts it.
    files: ["src/cli/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            'ImportExpression:not([source.type="Literal"]):not([source.type="TemplateLiteral"][source.expressions.length=0])',
          message:
            "src/cli may not use a dynamic import() whose specifier is computed: the module-boundary check (FR-019) reads the source text and cannot verify a computed specifier. Use a literal string or a backtick literal with no substitutions.",
        },
      ],
    },
  },
);
