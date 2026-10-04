/**
 * T021 — SC-004 / FR-003: a known-but-unselected operation answers with the exported
 * `NOT_IMPLEMENTED` constant, and that status is NEVER the document's declared not-found
 * status. The fixture declares 404 on GET /inventory/{id}; the assertion reads that
 * declared status out of the document rather than hard-coding a 404.
 *
 * The body must match the tool's own `NotImplementedBody` schema and name the
 * unimplemented operation. The 501 literal must not appear here — the constant is the
 * single home for the value (amendment A1).
 */
import { afterEach, describe, expect, it } from "vitest";
import { NOT_IMPLEMENTED } from "../../src/mock/errors.js";
import type { RunningMock } from "../../src/index.js";
import { loadSpec } from "../../src/spec/load.js";
import { INVENTORY_OPERATIONS, fixturePath, start } from "../helpers/mock.js";
import type { NotImplementedBody } from "../../src/mock/errors.js";

let mock: RunningMock | undefined;

afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

/** The not-found status the fixture declares on GET /inventory/{id}, read from the document. */
async function declaredNotFoundStatus(): Promise<number> {
  const loaded = await loadSpec(fixturePath("inventory-api.yaml"));
  const responses = ((loaded.document.paths as Record<string, unknown>)["/inventory/{id}"] as Record<string, unknown>)
    .get as Record<string, unknown>;
  const declared = Object.keys(responses.responses as Record<string, unknown>)
    .map(Number)
    .filter((code) => code >= 400 && code < 500);
  if (declared.length === 0) {
    throw new Error("the fixture declares no client-error status; the assertion would be vacuous");
  }
  return Math.min(...declared);
}

describe("not implemented (SC-004, FR-003)", () => {
  it("answers a known-but-unselected operation with NOT_IMPLEMENTED", async () => {
    mock = await start({ spec: fixturePath("inventory-api.yaml"), operations: INVENTORY_OPERATIONS });
    const response = await fetch(`${mock.baseUrl}/events`);

    expect(response.status).toBe(NOT_IMPLEMENTED);

    // The fixture declares its own not-found status; 501 must never equal it.
    const notFound = await declaredNotFoundStatus();
    expect(NOT_IMPLEMENTED).not.toBe(notFound);
    expect(response.status).not.toBe(notFound);
  });

  it("names the unimplemented operation in a NotImplementedBody shape", async () => {
    mock = await start({ spec: fixturePath("inventory-api.yaml"), operations: INVENTORY_OPERATIONS });
    const response = await fetch(`${mock.baseUrl}/events`);
    const body = (await response.json()) as NotImplementedBody;

    expect(body.error).toBe("not_implemented");
    expect(body.method).toBe("GET");
    expect(body.path).toBe("/events");
    expect(body.operationId).toBe("listEvents");
    expect(body.detail).toContain("GET /events");
    expect(body.detail).toContain("listEvents");
  });

  it("answers an unimplemented non-selected write operation distinctly from a missing record", async () => {
    // /events is the only deliberately-unselected operation in this fixture; the
    // distinction the spec demands is 501 vs the *declared* not-found status.
    mock = await start({ spec: fixturePath("inventory-api.yaml"), operations: INVENTORY_OPERATIONS });
    const notImplemented = await fetch(`${mock.baseUrl}/events`);
    const missing = await fetch(`${mock.baseUrl}/inventory/999999`);

    expect(notImplemented.status).toBe(NOT_IMPLEMENTED);
    expect(missing.status).toBe(await declaredNotFoundStatus());
    expect(notImplemented.status).not.toBe(missing.status);
  });

  it("answers a path the document does not declare at all with a plain HTTP 404", async () => {
    // A path with no operation in the document has no declared status to render, so
    // the normal HTTP not-found is correct — distinct from the 501 for a known path.
    mock = await start({ spec: fixturePath("inventory-api.yaml"), operations: INVENTORY_OPERATIONS });
    const response = await fetch(`${mock.baseUrl}/not-in-the-document`);
    expect(response.status).toBe(404);
    expect(response.status).not.toBe(NOT_IMPLEMENTED);
  });
});
