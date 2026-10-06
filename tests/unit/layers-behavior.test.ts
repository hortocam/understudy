import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadBehavior } from "../../src/config/layers/behavior.js";
import { loadImportMappings } from "../../src/config/layers/imports.js";
import { ConfigLayerInvalidError, ConfigUnparseableError } from "../../src/errors.js";
import { makeProject } from "../helpers/project.js";
import { withOutboundSpy } from "../helpers/outbound.js";
import { actionsFile, mappingFile, simulationsFile, webhooksFile } from "../fixtures/layers/docs03-examples.js";

function load(files: Record<string, string>): ReturnType<typeof loadBehavior> {
  const dir = makeProject(files);
  return loadBehavior(join(dir, "behavior"), dir);
}

function refusal(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a refusal");
}

describe("behaviour layer — parsed and validated, not acted on (spec boundary)", () => {
  it("docs/03's webhooks, actions and simulations files validate and are merged inertly", () => {
    const set = load({
      "behavior/webhooks.yaml": webhooksFile,
      "behavior/actions.yaml": actionsFile,
      "behavior/simulations.yaml": simulationsFile,
    });
    expect(Object.keys(set.targets)).toEqual(["pos"]);
    expect(set.subscriptions.map((s) => (s as { name: string }).name)).toEqual(["inventory-sold", "inventory-created"]);
    expect(Object.keys(set.actions)).toEqual(["marketplace-order"]);
    expect(set.reactions).toHaveLength(1);
    expect(Object.keys(set.simulations)).toEqual(["steady-orders"]);
  });

  it("a missing behavior/ folder is not an error", () => {
    expect(load({ "x.txt": "" }).subscriptions).toEqual([]);
  });

  it("an unknown key refuses naming file and key, in the same `file: key — cause` shape as every layer", () => {
    const error = refusal(() => load({ "behavior/webhooks.yaml": "targets:\n  pos:\n    url: http://x\n    bogus: 1\n" }));
    expect(error).toBeInstanceOf(ConfigLayerInvalidError);
    expect(error.message).toContain("behavior/webhooks.yaml: targets.pos.bogus");
    expect(error.message).toContain('unknown key "bogus"');
  });

  it("unparseable YAML refuses naming the file", () => {
    expect(refusal(() => load({ "behavior/w.yaml": "targets: [unclosed\n" }))).toBeInstanceOf(ConfigUnparseableError);
  });

  it("a JSONata when/where/id/inline-template that does not parse refuses naming the key", () => {
    const when = refusal(() =>
      load({ "behavior/w.yaml": "subscriptions:\n  - { name: n, on: A.created, target: t, when: \"a and\" }\n" }),
    );
    expect(when.message).toContain("subscriptions[0].when");
    const where = refusal(() =>
      load({
        "behavior/a.yaml":
          "actions:\n  go:\n    steps:\n      - select: { as: x, entity: A, where: \"status =\" }\n",
      }),
    );
    expect(where.message).toContain("actions.go.steps[0].select.where");
    const template = refusal(() =>
      load({ "behavior/w.yaml": "subscriptions:\n  - { name: n, on: A.created, target: t, template: '{ \"a\": ' }\n" }),
    );
    expect(template.message).toContain("subscriptions[0].template");
  });

  it("a ./path template is a file reference, not parsed", () => {
    expect(() =>
      load({ "behavior/w.yaml": "subscriptions:\n  - { name: n, on: A.created, target: t, template: ./t/x.jsonata }\n" }),
    ).not.toThrow();
  });

  it("two files declaring the same target refuse naming both", () => {
    const error = refusal(() =>
      load({
        "behavior/a.yaml": "targets:\n  pos: { url: http://a }\n",
        "behavior/b.yaml": "targets:\n  pos: { url: http://b }\n",
      }),
    );
    expect(error.message).toContain("a.yaml");
    expect(error.message).toContain("b.yaml");
  });

  it("${VAR:-default} stays inert text: no environment read, no socket opened", async () => {
    process.env.USTDY_WEBHOOK_POS_URL = "http://sentinel.invalid/should-not-appear";
    try {
      const { result, report } = await withOutboundSpy(async () => load({ "behavior/webhooks.yaml": webhooksFile }));
      expect((result.targets.pos as { url: string }).url).toBe("${USTDY_WEBHOOK_POS_URL:-http://localhost:9000/hooks/pos}");
      expect(report.records).toEqual([]);
    } finally {
      delete process.env.USTDY_WEBHOOK_POS_URL;
    }
  });
});

describe("imports layer — shape validated, never read (slice 3 consumes it)", () => {
  it("a docs/03 mapping validates; the data file it names is never opened", () => {
    const dir = makeProject({ "imports/events.mapping.yaml": mappingFile });
    expect(loadImportMappings(join(dir, "imports"), dir)).toEqual(["imports/events.mapping.yaml"]);
  });

  it("a bad mapping refuses naming file and key", () => {
    const dir = makeProject({ "imports/e.mapping.yaml": "source: { file: x.json }\ntargets: []\n" });
    const error = refusal(() => loadImportMappings(join(dir, "imports"), dir));
    expect(error.message).toContain("imports/e.mapping.yaml");
  });
});
