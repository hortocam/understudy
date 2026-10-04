/**
 * F-A (converge round 1, HIGH — FR-005/FR-006) — a resource whose instance path declares
 * BOTH update styles must honour each one: PATCH merges, PUT replaces. The defect was that
 * `deriveResource` kept a single `update` slot (`findMethod(instanceOps, "PATCH") ??
 * findMethod(instanceOps, "PUT")`), so PUT was live but unbound and the no-CRUD fallback
 * answered a silent `200 {}` that changed nothing.
 *
 * It also asserts the second half of the finding: a live operation the model could not bind
 * to CRUD must refuse loudly (constitution VI) rather than answer a silent empty 2xx.
 *
 * The fixture declares its own not-found status on the instance path, so the missing-record
 * assertions read that from the document rather than hard-coding 404.
 */
import { afterEach, describe, expect, it } from "vitest";
import { NOT_IMPLEMENTED } from "../../src/mock/errors.js";
import type { RunningMock } from "../../src/index.js";
import { loadSpec } from "../../src/spec/load.js";
import { fixturePath, start } from "../helpers/mock.js";

let mock: RunningMock | undefined;

afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

const UPDATE_STYLES_OPERATIONS = [
  "createGadget",
  "readGadget",
  "mergeGadget",
  "replaceGadget",
  "getReport",
] as const;

async function startGadgets(): Promise<string> {
  mock = await start({
    spec: fixturePath("update-styles-api.yaml"),
    operations: UPDATE_STYLES_OPERATIONS,
  });
  return mock.baseUrl;
}

async function json(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  return text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};
}

describe("both declared update styles are honoured (FR-006)", () => {
  it("merges on PATCH and replaces the whole representation on PUT when both are live", async () => {
    const base = await startGadgets();

    const created = await fetch(`${base}/gadgets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ colour: "red", finish: "matte", label: "one" }),
    });
    expect(created.status).toBe(201);
    const gadget = await json(created);
    expect(typeof gadget.id).toBe("number");

    // PATCH is a merge: the untouched fields survive.
    const patched = await fetch(`${base}/gadgets/${gadget.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ colour: "blue" }),
    });
    expect(patched.status).toBe(200);
    expect(await json(patched)).toEqual({
      id: gadget.id,
      colour: "blue",
      finish: "matte",
      label: "one",
    });

    // PUT is a replace: `label` is absent from the body, so it must be gone.
    const put = await fetch(`${base}/gadgets/${gadget.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ colour: "green", finish: "gloss" }),
    });
    expect(put.status).toBe(200);
    const replaced = await json(put);
    expect(replaced).toEqual({ id: gadget.id, colour: "green", finish: "gloss" });
    expect("label" in replaced).toBe(false);

    // The replacement is what persisted, not a no-op on top of the merge.
    const read = await fetch(`${base}/gadgets/${gadget.id}`);
    expect(await json(read)).toEqual({ id: gadget.id, colour: "green", finish: "gloss" });
  });

  it("answers the document's declared not-found status for PUT against a missing record", async () => {
    const base = await startGadgets();
    const notFound = await declaredNotFoundStatus();

    const response = await fetch(`${base}/gadgets/999999`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ colour: "ghost", finish: "ghost" }),
    });
    expect(response.status).toBe(notFound);
    expect(response.status).not.toBe(NOT_IMPLEMENTED);
    const body = await json(response);
    expect(typeof body.error).toBe("string");
    expect(typeof body.message).toBe("string");
  });

  it("answers the document's declared not-found status for PATCH against a missing record", async () => {
    const base = await startGadgets();
    const notFound = await declaredNotFoundStatus();

    const response = await fetch(`${base}/gadgets/999999`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ colour: "ghost" }),
    });
    expect(response.status).toBe(notFound);
    expect(response.status).not.toBe(NOT_IMPLEMENTED);
  });

  it("refuses a live operation with no derivable CRUD semantics loudly, never a silent 200", async () => {
    const base = await startGadgets();

    // `/reports/{year}/{month}` is live but matches no resource (two path parameters); the
    // startup report names it `route-without-resource`. The mock must not pretend success.
    const response = await fetch(`${base}/reports/2026/05`);
    expect(response.status).toBe(NOT_IMPLEMENTED);
    expect(response.status).not.toBe(200);
    const body = await json(response);
    expect(body.error).toBe("not_implemented");
    expect(body.detail).toContain("GET /reports/{year}/{month}");
    expect(String(body.detail)).toContain("CRUD");
  });
});

/** The not-found status the fixture declares on the gadget instance path, read from the document. */
async function declaredNotFoundStatus(): Promise<number> {
  const loaded = await loadSpec(fixturePath("update-styles-api.yaml"));
  const operation = ((loaded.document.paths as Record<string, unknown>)["/gadgets/{id}"] as Record<string, unknown>)
    .get as Record<string, unknown>;
  const declared = Object.keys(operation.responses as Record<string, unknown>)
    .map(Number)
    .filter((code) => code >= 400 && code < 500);
  if (declared.length === 0) {
    throw new Error("the fixture declares no client-error status; the assertion would be vacuous");
  }
  return Math.min(...declared);
}
