/**
 * The behaviour layer: `behavior/*.yaml` — webhook targets and subscriptions, actions, reactions
 * and simulations. PARSED AND VALIDATED here and consumed nowhere: slices 4–5 add behaviour, not
 * plumbing, and a typo in a webhook target fails at the same moment as every other config error
 * (FR-005) instead of the first time slice 4 reads it.
 *
 * Inert by construction: `${VAR:-default}` strings are kept as text (the library never reads the
 * environment — secrets come from there, never from a file), and no socket is opened.
 */
import { ConfigLayerInvalidError } from "../../errors.js";
import { parseExpression } from "./recipes.js";
import { listLayerFiles, readLayerFile, validateLayerFile, type LayerFile } from "./files.js";

export interface BehaviorSet {
  targets: Record<string, unknown>;
  subscriptions: unknown[];
  actions: Record<string, unknown>;
  reactions: unknown[];
  simulations: Record<string, unknown>;
}

type Obj = Record<string, unknown>;

const isObj = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);

/** A template that is a file reference (`./x.jsonata`) is not parsed in this slice. */
function isFileReference(template: string): boolean {
  return /^(\.{0,2}\/|[^\s{]+\.jsonata$)/.test(template.trim());
}

function checkJsonata(file: LayerFile, key: string, expression: unknown): void {
  if (typeof expression !== "string") return;
  try {
    parseExpression(expression);
  } catch (error) {
    throw new ConfigLayerInvalidError(
      "behavior",
      file.rel,
      key,
      `not a valid JSONata expression: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function checkTemplate(file: LayerFile, key: string, template: unknown): void {
  if (typeof template === "string" && !isFileReference(template)) checkJsonata(file, key, template);
}

function checkExpressions(file: LayerFile, body: Obj): void {
  const subscriptions = Array.isArray(body.subscriptions) ? body.subscriptions : [];
  subscriptions.forEach((subscription, index) => {
    if (!isObj(subscription)) return;
    checkJsonata(file, `subscriptions[${index}].when`, subscription.when);
    checkTemplate(file, `subscriptions[${index}].template`, subscription.template);
  });
  for (const [name, action] of Object.entries(isObj(body.actions) ? body.actions : {})) {
    const steps = isObj(action) && Array.isArray(action.steps) ? action.steps : [];
    steps.forEach((step, index) => {
      if (!isObj(step)) return;
      const base = `actions.${name}.steps[${index}]`;
      if (isObj(step.select)) {
        checkJsonata(file, `${base}.select.where`, step.select.where);
        checkJsonata(file, `${base}.select.id`, step.select.id);
      }
      if (isObj(step.webhook)) checkTemplate(file, `${base}.webhook.template`, step.webhook.template);
    });
  }
}

/** Load and validate the behaviour layer. A missing folder is not an error. */
export function loadBehavior(dir: string, baseDir: string): BehaviorSet {
  const set: BehaviorSet = { targets: {}, subscriptions: [], actions: {}, reactions: [], simulations: {} };
  const origin = new Map<string, string>();
  const claim = (kind: string, name: string, file: LayerFile): void => {
    const id = `${kind}\u0000${name}`;
    const earlier = origin.get(id);
    if (earlier !== undefined) {
      throw new ConfigLayerInvalidError("behavior", file.rel, `${kind}.${name}`, `already declared in ${earlier}`);
    }
    origin.set(id, file.rel);
  };

  for (const file of listLayerFiles(dir, baseDir)) {
    const value = readLayerFile(file) ?? {};
    validateLayerFile("BehaviorFile", "behavior", file, value);
    const body = value as Obj;
    checkExpressions(file, body);
    for (const [name, target] of Object.entries(isObj(body.targets) ? body.targets : {})) {
      claim("targets", name, file);
      set.targets[name] = target;
    }
    for (const [name, action] of Object.entries(isObj(body.actions) ? body.actions : {})) {
      claim("actions", name, file);
      set.actions[name] = action;
    }
    for (const [name, simulation] of Object.entries(isObj(body.simulations) ? body.simulations : {})) {
      claim("simulations", name, file);
      set.simulations[name] = simulation;
    }
    for (const subscription of Array.isArray(body.subscriptions) ? body.subscriptions : []) {
      if (isObj(subscription) && typeof subscription.name === "string") claim("subscriptions", subscription.name, file);
      set.subscriptions.push(subscription);
    }
    for (const reaction of Array.isArray(body.reactions) ? body.reactions : []) {
      if (isObj(reaction) && typeof reaction.name === "string") claim("reactions", reaction.name, file);
      set.reactions.push(reaction);
    }
  }
  return set;
}
