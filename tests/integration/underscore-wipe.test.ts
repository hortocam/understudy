/**
 * Regression: the unscoped wipe must not skip a resource whose table name begins with `_`
 * (HANDOFF-p5-p7 §5 item 4; SC-002).
 *
 * `_events` is a legitimate collection path segment, so `deriveModel` names its resource
 * `_event` and the store creates a table named `_event`. The store's resource-table
 * enumeration used a `'\_%'` prefix filter to skip the tool's own `_understudy_meta` and
 * `_requests` tables — which swallowed `_event` too. The unscoped wipe (the default
 * `{"mode":"wipe"}`) then silently left those rows behind, and the `removed` report did not
 * even name the entity. `/notes` is the positive control that a normal-named resource is
 * still wiped. The scoped-wipe path (deleting by resource name) is asserted to still work.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { RunningMock } from "../../src/index.js";
import { fixturePath, start, storePath } from "../helpers/mock.js";

const UNDERSCORE_OPERATIONS = [
  "POST /notes",
  "GET /notes",
  "GET /notes/{id}",
  "POST /_events",
  "GET /_events",
  "GET /_events/{id}",
] as const;

let mock: RunningMock | undefined;

afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

function underscoreMock(storeDir?: string): RunningMock | Promise<RunningMock> {
  return start({
    spec: fixturePath("underscore-api.yaml"),
    operations: UNDERSCORE_OPERATIONS,
    ...(storeDir ? { storeDir } : {}),
  });
}

async function create(url: string, collection: string, body: Record<string, unknown>): Promise<{ id: number }> {
  const response = await fetch(`${url}${collection}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: number };
}

async function reset(running: RunningMock, body: Record<string, unknown>): Promise<{
  ok: boolean;
  removed: Record<string, number>;
}> {
  const response = await fetch(`${running.controlUrl}${running.controlPrefix}/reset`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { ok: boolean; removed: Record<string, number> };
}

describe("unscoped wipe reaches underscore-named resource tables (SC-002)", () => {
  it("derives the underscore-named resource from a path segment (the precondition)", async () => {
    // If the derivation did not yield a `_`-named resource, the rest of this file would be
    // testing nothing. Pin the precondition explicitly.
    mock = await underscoreMock();
    const names = mock.report.resources.map((resource) => resource.name);
    expect(names).toContain("_event");
    expect(names).toContain("Note");
  });

  it("removes a record written to a `_`-named collection on an unscoped wipe, and names it in `removed`", async () => {
    const running = await underscoreMock();

    // One record over the API per collection: the `_`-named resource and the control.
    const underscore = await create(running.baseUrl, "/_events", { kind: "boom" });
    const control = await create(running.baseUrl, "/notes", { text: "hello" });

    // The record is readable before the wipe — so a 404 afterwards is removal, not a
    // never-written record.
    expect((await fetch(`${running.baseUrl}/_events/${underscore.id}`)).status).toBe(200);
    expect((await fetch(`${running.baseUrl}/notes/${control.id}`)).status).toBe(200);

    const body = await reset(running, { mode: "wipe" });

    // The defect: `_event` was silently absent from the report, and its row survived.
    expect(body.removed).toHaveProperty("_event");
    expect(body.removed._event).toBeGreaterThanOrEqual(1);
    // Positive control: the ordinary resource is still wiped.
    expect(body.removed.Note).toBeGreaterThanOrEqual(1);

    // The `_`-named record is gone: the document's declared not-found status (404).
    expect((await fetch(`${running.baseUrl}/_events/${underscore.id}`)).status).toBe(404);
    expect(await (await fetch(`${running.baseUrl}/_events`)).json()).toEqual([]);
    // ...and the ordinary resource with it.
    expect((await fetch(`${running.baseUrl}/notes/${control.id}`)).status).toBe(404);
    expect(await (await fetch(`${running.baseUrl}/notes`)).json()).toEqual([]);
  });

  it("leaves no rows in the `_`-named table after an unscoped wipe (reads the SQLite file directly)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "understudy-underscore-"));
    const running = await underscoreMock(dir);
    await create(running.baseUrl, "/_events", { kind: "boom" });
    await create(running.baseUrl, "/notes", { text: "hello" });

    await reset(running, { mode: "wipe" });
    await running.close();
    mock = undefined;

    // Inspect the raw store: the derived table, named after the resource, must be empty.
    const db = new Database(storePath(dir), { readonly: true });
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const names = tables.map((table) => table.name);
    expect(names).toContain("_event");
    const rows = db.prepare('SELECT COUNT(*) AS n FROM "_event"').get() as { n: number };
    expect(rows.n).toBe(0);
    db.close();
  });

  it("still wipes a `_`-named resource through the scoped path", async () => {
    const running = await underscoreMock();
    const underscore = await create(running.baseUrl, "/_events", { kind: "boom" });
    const control = await create(running.baseUrl, "/notes", { text: "hello" });

    const body = await reset(running, { mode: "wipe", entities: ["_event"] });

    expect(body.removed._event).toBeGreaterThanOrEqual(1);
    expect((await fetch(`${running.baseUrl}/_events/${underscore.id}`)).status).toBe(404);
    // The scoped wipe leaves the un-named resource alone.
    expect((await fetch(`${running.baseUrl}/notes/${control.id}`)).status).toBe(200);
  });
});
