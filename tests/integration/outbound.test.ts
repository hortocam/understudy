/**
 * T042 — no outbound traffic beyond a URL-supplied spec (SC-008, FR-022, constitution VIII).
 *
 * The whole lifecycle is run against a spec supplied as a **local file**, with an outbound
 * spy installed at the layers a call can pass through (global `fetch`, `node:http(s)`, the
 * `node:net` socket layer, `node:dns`). Loopback destinations are allowed through — the
 * harness itself talks to the running mock over 127.0.0.1 — so `report.external` is the
 * precise violation set: any recorded destination whose host is not loopback.
 *
 * The suite is not vacuous: a positive control proves the spy observes a real fetch (a spec
 * served by a loopback HTTP server is recorded), and a negative control proves it refuses an
 * external one. Without both, "no outbound traffic" could just mean "the spy saw nothing".
 */
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createMock, type RunningMock } from "../../src/index.js";
import { SpecUnreadableError } from "../../src/errors.js";
import { loadSpec } from "../../src/spec/load.js";
import { createLogger } from "../../src/logging.js";
import { parseConfig } from "../../src/config/load.js";
import { fixturePath, newStoreDir, storePath } from "../helpers/mock.js";
import { withOutboundSpy } from "../helpers/outbound.js";

let mock: RunningMock | undefined;
let specServer: Server | undefined;

afterEach(async () => {
  await mock?.close();
  mock = undefined;
  if (specServer) {
    await new Promise<void>((resolve) => specServer?.close(() => resolve()));
    specServer = undefined;
  }
});

function configFor(spec: string, storeDir: string) {
  return parseConfig(
    [
      `spec: ${spec}`,
      "operations:",
      "  - POST /inventory",
      "  - GET  /inventory",
      "  - GET  /inventory/{id}",
      `storage: { driver: sqlite, path: ${JSON.stringify(storePath(storeDir))} }`,
    ].join("\n"),
    `${storeDir}/understudy.yaml`,
  );
}

describe("no hidden outbound calls (SC-008, FR-022)", () => {
  it("runs the whole lifecycle against a file spec with zero external destinations", async () => {
    const dir = newStoreDir();
    const { report } = await withOutboundSpy(async () => {
      mock = await createMock(configFor(fixturePath("inventory-api.yaml"), dir), {
        port: 0,
        out: () => {},
        logger: createLogger({ write: () => {} }),
      });
      const base = mock.baseUrl;

      // The full slice-1 lifecycle: create, read, list, filter, page, update, delete,
      // a not-implemented answer, an invalid body, and the control plane (health, reset,
      // operations, requests, openapi.json, teardown) — then a close.
      const created = await fetch(`${base}/inventory`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sku: "GA-100", quantity: 4 }),
      });
      expect(created.status).toBe(201);
      const record = (await created.json()) as { id: number };

      await fetch(`${base}/inventory/${record.id}`);
      await fetch(`${base}/inventory?sku=GA-100&limit=1`);
      await fetch(`${base}/inventory/${record.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ quantity: 9 }),
      });
      await fetch(`${base}/inventory/${record.id}`, { method: "DELETE" });
      await fetch(`${base}/events`); // not-implemented
      await fetch(`${base}/inventory`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sku: "GA-100", quantity: "lots" }),
      });

      const control = `${mock.controlUrl}${mock.controlPrefix}`;
      await fetch(`${control}/health`);
      await fetch(`${control}/operations`);
      await fetch(`${control}/requests`);
      await fetch(`${control}/openapi.json`);
      await fetch(`${control}/reset`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "wipe" }),
      });
      await mock.close();
      mock = undefined;
    });

    expect(report.external).toEqual([]);
    // The spec was supplied as a file, so no fetch ever named it: every fetch the spy saw is
    // the harness's own loopback traffic to the mock, never a fetch of the document.
    expect(report.records.filter((entry) => /inventory-api\.yaml/.test(entry.target))).toEqual([]);
  });

  it("positive control: the spy observes a spec fetched over HTTP", async () => {
    // Serve the fixture over loopback so the URL-spec path is exercised without leaving the box.
    const bytes = readFileSync(fixturePath("inventory-api.yaml"));
    specServer = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/yaml" });
      response.end(bytes);
    });
    const port = await new Promise<number>((resolve) => {
      specServer?.listen(0, "127.0.0.1", () => {
        const address = specServer?.address();
        resolve(typeof address === "object" && address ? address.port : 0);
      });
    });

    const { result, report } = await withOutboundSpy(() =>
      loadSpec(`http://127.0.0.1:${port}/inventory-api.yaml`),
    );

    expect(result.sourceVersion).toBe("3.1.0");
    // The spy saw the fetch: it is the ONLY outbound call slice 1 permits.
    expect(report.records.some((entry) => entry.kind === "fetch")).toBe(true);
    expect(report.external).toEqual([]); // loopback, so not a violation
  });

  it("negative control: the spy refuses a non-loopback fetch", async () => {
    // `loadSpec` wraps any fetch failure in `SpecUnreadableError`; the spy has already
    // recorded the external attempt and refused it, so the refusal is observable both in the
    // wrapped error's message and in the report.
    const { result, report } = await withOutboundSpy(async () => {
      try {
        await loadSpec("https://example.test/openapi.json");
        return "no-error" as const;
      } catch (error) {
        return error;
      }
    });

    expect(result).toBeInstanceOf(SpecUnreadableError);
    expect((result as Error).message).toContain("the spy refused a non-loopback fetch");
    expect(report.external).toHaveLength(1);
    expect(report.external[0]?.kind).toBe("fetch");
  });
});
