/**
 * FU — a resource whose name is a *case-variant* of one of the tool's own table names
 * (`_understudy_meta`, `_requests`, `_id_ranges`) must be refused at startup for the same
 * reason an exact match is: SQLite table identity is case-insensitive, so a schema `title` of
 * `_Requests` used verbatim as the table name collides with the tool's `_requests` table even
 * though the string is not an exact match.
 *
 * The guard t_0f95d192 added (`META_TABLES.has(resource)`, store/sqlite.ts) matched by exact
 * case, so `_Requests` slipped through: `CREATE TABLE IF NOT EXISTS "_Requests"` silently
 * no-opped onto the tool's `_requests` table and the index DDL then died on a missing column —
 * the same raw `SqliteError: no such column: origin` the reservation exists to replace.
 *
 * The reservation folds case, exactly as SQLite does; it still does NOT widen to a `_` prefix:
 * a legitimate `_event` collection remains creatable.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReservedTableNameError, UnderstudyError } from "../../src/errors.js";
import type { RunningMock } from "../../src/index.js";
import { renderRefusal } from "../../src/logging.js";
import { createSqliteStore } from "../../src/store/sqlite.js";
import { fixturePath, start } from "../helpers/mock.js";

const CASE_VARIANT_OPERATIONS = ["GET /widgets", "GET /notes", "POST /notes"] as const;

let mock: RunningMock | undefined;

afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

describe("a resource named a case-variant of a tool table is refused, naming the collision (constitution VI)", () => {
  it("refuses to start on a `_Requests` title, naming the reserved table and folding case", async () => {
    let out = "";
    const error = await start({
      spec: fixturePath("reserved-table-case-api.yaml"),
      operations: CASE_VARIANT_OPERATIONS,
      storeDir: mkdtempSync(join(tmpdir(), "understudy-reserved-case-")),
      out: (text: string) => {
        out += `${text}\n`;
      },
    }).catch((e: unknown) => e);

    // Not a raw driver error: the refusal is one of the taxonomy's, with a stable code.
    expect(error).toBeInstanceOf(UnderstudyError);
    expect(error).toBeInstanceOf(ReservedTableNameError);
    expect((error as ReservedTableNameError).code).toBe("RESERVED_TABLE_NAME");

    const message = (error as Error).message;
    // It names the colliding collection and the reserved table it folds onto.
    expect(message).toContain("_Requests");
    expect(message).toContain("_requests");
    expect(message).toContain("reserved");
    // ...and it does NOT surface as the old opaque SQL failure.
    expect(message).not.toContain("no such column");

    // The human rendering is produced at the process boundary, not by the library: #25 moved
    // it to `renderRefusal` (src/logging.ts) and the CLI prints it once from the thrown error
    // (refusals.test.ts). Assert both halves so this cannot regress to the old contract:
    // the library's `out` sink stays empty, and the boundary rendering names the refusal.
    const rendered = renderRefusal(error);
    expect(rendered).toContain("refusing to start");
    expect(rendered).toContain("_Requests");
    expect(out).toBe("");
  });

  it("the case-folded reservation covers every tool table, not just _requests", async () => {
    for (const variant of ["_Understudy_Meta", "_REQUESTS", "_Id_Ranges", "_ID_RANGES"]) {
      const dir = mkdtempSync(join(tmpdir(), "understudy-reserved-case-"));
      const store = createSqliteStore({ path: join(dir, "state.db") });
      store.open();
      expect(() => store.ensureResource(variant, { foreignKeys: [], indexes: [] })).toThrow(ReservedTableNameError);
      store.close();
    }
  });

  it("negative control: the ordinary resource from the same document still starts and serves", async () => {
    mock = await start({
      spec: fixturePath("reserved-table-case-api.yaml"),
      operations: ["GET /notes", "POST /notes"],
      storeDir: mkdtempSync(join(tmpdir(), "understudy-reserved-case-")),
    });
    expect(mock.report.resources.map((r) => r.name)).toContain("Note");
    const response = await fetch(`${mock.baseUrl}/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "still here" }),
    });
    expect(response.status).toBe(201);
  });

  it("negative control: case-folding must not widen into a `_`-prefix refusal", () => {
    // `_event` is a legitimate collection name and its table must stay creatable.
    const dir = mkdtempSync(join(tmpdir(), "understudy-reserved-case-"));
    const store = createSqliteStore({ path: join(dir, "state.db") });
    store.open();
    expect(() => store.ensureResource("_event", { foreignKeys: [], indexes: [] })).not.toThrow();
    store.insert("_event", "1", { id: 1 }, "runtime");
    expect(store.list("_event")).toHaveLength(1);
    store.close();
  });
});
