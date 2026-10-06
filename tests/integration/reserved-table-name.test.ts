/**
 * FU — a derived resource whose name is exactly one of the tool's own table names
 * (`_understudy_meta`, `_requests`, `_id_ranges`) must be refused at startup, naming the
 * collision and the fact that the name is reserved by the tool (constitution VI: refuse
 * loudly, naming the cause).
 *
 * A resource's name becomes its table name. The tool's own tables are addressed by *exact*
 * name (`META_TABLES`, store/schema.ts). Before this fix a resource titled `_requests`
 * reached `ensureResource`, whose `CREATE TABLE IF NOT EXISTS "_requests"` silently no-opped
 * on the tool's existing request-log table and whose index DDL then died on a missing column —
 * a raw `SqliteError: no such column: origin` that names neither the collision nor the cause.
 *
 * This is a refusal, so it carries a negative control: the `Note` resource derived from the
 * same document (and a `_`-prefixed resource that is NOT reserved) still starts, so a green
 * run cannot be mistaken for a mock that refuses everything underscore-prefixed.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReservedTableNameError, UnderstudyError } from "../../src/errors.js";
import type { RunningMock } from "../../src/index.js";
import { createSqliteStore } from "../../src/store/sqlite.js";
import { fixturePath, start } from "../helpers/mock.js";

const RESERVED_OPERATIONS = ["GET /widgets", "POST /widgets", "GET /widgets/{id}", "GET /notes"] as const;

let mock: RunningMock | undefined;

afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

describe("a resource named exactly a tool table is refused, naming the reserved name (constitution VI)", () => {
  it("refuses to start, names the colliding collection and says the name is reserved by the tool", async () => {
    let out = "";
    const error = await start({
      spec: fixturePath("reserved-table-api.yaml"),
      operations: RESERVED_OPERATIONS,
      storeDir: mkdtempSync(join(tmpdir(), "understudy-reserved-")),
      out: (text: string) => {
        out += `${text}\n`;
      },
    }).catch((e: unknown) => e);

    // Not a raw driver error: the refusal is one of the taxonomy's, with a stable code.
    expect(error).toBeInstanceOf(UnderstudyError);
    expect(error).toBeInstanceOf(ReservedTableNameError);
    expect((error as ReservedTableNameError).code).toBe("RESERVED_TABLE_NAME");

    const message = (error as Error).message;
    // It NAMES the collision: the collection and the reserved table it would collide with.
    expect(message).toContain("_requests");
    expect(message).toContain("reserved");
    // ...and it does NOT surface as the old opaque SQL failure.
    expect(message).not.toContain("no such column");

    // The human-facing startup output carries the same refusal, so `ustdy up` reads plainly.
    expect(out).toContain("refusing to start");
    expect(out).toContain("_requests");
  });

  it("the reservation covers every tool table, not just _requests", async () => {
    for (const reserved of ["_understudy_meta", "_requests", "_id_ranges"]) {
      const dir = mkdtempSync(join(tmpdir(), "understudy-reserved-"));
      const store = createSqliteStore({ path: join(dir, "state.db") });
      store.open();
      expect(() => store.ensureResource(reserved, { foreignKeys: [], indexes: [] })).toThrow(ReservedTableNameError);
      store.close();
    }
  });

  it("negative control: the ordinary resource from the same document still starts", async () => {
    // `_requests` is refused, but a normal resource must not be collateral damage. Start a
    // mock whose live set derives only `Note`, and prove it serves.
    mock = await start({
      spec: fixturePath("reserved-table-api.yaml"),
      operations: ["GET /notes", "POST /notes"],
      storeDir: mkdtempSync(join(tmpdir(), "understudy-reserved-")),
    });
    expect(mock.report.resources.map((r) => r.name)).toContain("Note");
    const response = await fetch(`${mock.baseUrl}/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "still here" }),
    });
    expect(response.status).toBe(201);
  });

  it("negative control: a `_`-prefixed resource that is NOT a tool table is still allowed", () => {
    // The guard keys off the exact reserved set, never off a `_` prefix: `_event` is a
    // legitimate collection name and its table must be creatable (HANDOFF-p5-p7 §5 item 4).
    const dir = mkdtempSync(join(tmpdir(), "understudy-reserved-"));
    const store = createSqliteStore({ path: join(dir, "state.db") });
    store.open();
    expect(() => store.ensureResource("_event", { foreignKeys: [], indexes: [] })).not.toThrow();
    store.insert("_event", "1", { id: 1 }, "runtime");
    expect(store.list("_event")).toHaveLength(1);
    store.close();
  });
});
