/**
 * Scenario 5 and US4.1–5 (FR-006, FR-007, FR-008, SC-005): the startup report tells the truth
 * about inference, a pin changes the outcome, a cycle never deadlocks — and the foreign keys the
 * report promises are real (decided links are enforced; undetermined links are not).
 */
import { afterEach, describe, expect, it } from "vitest";
import type { RunningMock } from "../../src/index.js";
import { fixturePath } from "../helpers/mock.js";
import { allOperations, startProject } from "../helpers/project.js";

let mock: RunningMock | undefined;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

async function startOn(fixture: string, config = "", out?: string[]): Promise<RunningMock> {
  const spec = fixturePath(fixture);
  const started = await startProject(
    {},
    { spec, operations: await allOperations(spec), config, ...(out ? { mock: { out: (t: string) => out.push(t) } } : {}) },
  );
  return started.mock;
}

describe("US4 — the report shows its working", () => {
  it("lists collections, decided links with evidence, and undetermined links with candidates (US4.1–4.3)", async () => {
    const out: string[] = [];
    mock = await startOn("collisions-api.yaml", "", out);
    const text = out.join("\n");
    expect(mock.report.resources.map((r) => r.name).sort()).toEqual(["Customer", "Event", "Listing", "Order", "Venue"]);
    expect(text).toContain("Event -> Venue via venueId [one, convention]");
    expect(text).toContain("undetermined links (8)");
    expect(text).toMatch(/Order\.eventId .*candidates: eventId, primaryEventId, viagogoEventId/);
    expect(text).toContain("clock: real, unpinned");
  });

  it("a link pinned in configuration wins, and the report says it was configured, not inferred (US4.4)", async () => {
    const out: string[] = [];
    mock = await startOn(
      "collisions-api.yaml",
      "entities:\n  Order:\n    relations:\n      eventId: { to: Event.id }\n",
      out,
    );
    const text = out.join("\n");
    expect(text).toContain("Order -> Event via eventId [one, configured]");
    expect(mock.report.relationships.filter((r) => r.from === "Order" && r.to === "Event")).toHaveLength(1);
    expect(text).toContain("undetermined links (5)"); // the three Order/Event siblings resolved; externalId x4 + referenceId remain
  });

  it("a document whose collections form a cycle starts, reports the cycle, and does not deadlock (US4.5)", async () => {
    const started = Date.now();
    mock = await startOn("cycle-api.yaml");
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(mock.report.plan?.cycles).toEqual([{ members: ["Alpha", "Beta", "Gamma"], unresolved: ["Alpha.betaId", "Beta.gammaId"] }]);
    expect(mock.report.plan?.order).toEqual(["Alpha", "Beta", "Gamma", "Delta", "Omega"]);
    // and it serves
    const response = await fetch(`${mock.baseUrl}/alphas`);
    expect(response.status).toBe(200);
  });
});

describe("decided links are enforced; undetermined links are not (data-model.md §3)", () => {
  async function post(path: string, body: unknown): Promise<Response> {
    return fetch(`${(mock as RunningMock).baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("an orphan write is refused with the document's declared client error, and a valid parent is accepted", async () => {
    mock = await startOn("shop-api.yaml");
    const venue = (await (await post("/venues", { name: "Arena" })).json()) as { id: number };
    expect((await post("/events", { name: "Gig", venueId: venue.id })).status).toBe(201);
    const orphan = await post("/events", { name: "Ghost gig", venueId: 999 });
    expect(orphan.status).toBe(400); // the operation declares 400
    expect(((await orphan.json()) as { error: string }).error).toBe("invalid_reference");
  });

  it("deleting a still-referenced parent is a declared conflict (restrict, the default); then it succeeds", async () => {
    mock = await startOn("shop-api.yaml");
    const venue = (await (await post("/venues", { name: "Arena" })).json()) as { id: number };
    const event = (await (await post("/events", { name: "Gig", venueId: venue.id })).json()) as { id: number };
    const base = (mock as RunningMock).baseUrl;
    expect((await fetch(`${base}/venues/${venue.id}`, { method: "DELETE" })).status).toBe(409);
    expect((await fetch(`${base}/events/${event.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await fetch(`${base}/venues/${venue.id}`, { method: "DELETE" })).status).toBe(204);
  });

  it("onDelete: cascade is honoured when pinned", async () => {
    mock = await startOn("shop-api.yaml", "entities:\n  Event:\n    relations:\n      venueId: { to: Venue.id, onDelete: cascade }\n");
    const venue = (await (await post("/venues", { name: "Arena" })).json()) as { id: number };
    const event = (await (await post("/events", { name: "Gig", venueId: venue.id })).json()) as { id: number };
    const base = (mock as RunningMock).baseUrl;
    expect((await fetch(`${base}/venues/${venue.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await fetch(`${base}/events/${event.id}`)).status).toBe(404);
  });

  it("an UNDETERMINED link has no constraint: the mock does not enforce what it could not decide", async () => {
    mock = await startOn("collisions-api.yaml");
    const orphan = await post("/orders", { id: 1, eventId: 424242, viagogoEventId: 1, primaryEventId: 2 });
    expect(orphan.status).toBe(201);
  });
});
