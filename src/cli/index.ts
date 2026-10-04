#!/usr/bin/env node
/**
 * The `ustdy` entrypoint (FR-019, FR-020).
 *
 * This module is a client of the control API and nothing else: it must not import
 * `src/mock/`, `src/store/` or `src/spec/`, which `tests/unit/architecture.test.ts`
 * enforces. The lifecycle commands (`up`, `down`, `reset`, `ops`) land with the
 * control plane in a later card; Phase 1+2 ships the shared spine only, so this
 * program currently just presents itself.
 */
import { Command } from "commander";

const program = new Command();

program
  .name("ustdy")
  .description("Declarative, stateful mocking of third-party APIs and webhook events from an OpenAPI spec.")
  .version("0.1.0");

program.parse();