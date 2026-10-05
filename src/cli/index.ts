#!/usr/bin/env node
/**
 * The `ustdy` entrypoint (FR-019, FR-020): wires the process to the command set in
 * `program.ts`. The CLI is a client of the control API; `tests/unit/architecture.test.ts`
 * forbids any file under `src/cli/` from importing `src/mock/`, `src/store/` or `src/spec/`.
 */
import { runCli } from "./program.js";

process.exitCode = await runCli(process.argv, {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
  env: process.env,
});
