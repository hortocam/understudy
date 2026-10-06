/**
 * The generation plan (data-model.md §1): what generation will do, computed BEFORE any row is
 * written so it is reportable and golden-testable.
 *
 * Pure — no store, no clock, no randomness. The order is a function of the model alone:
 *  - edges are the DECIDED relationships only (an undetermined link is reported, never acted on);
 *  - strongly-connected components are found iteratively (a document may be large, and
 *    recursion would make the stack depth data-dependent);
 *  - components are emitted parents-first with ties broken by the smallest member NAME, never by
 *    declaration order, so adding an unrelated collection cannot move an existing one (SC-007);
 *  - a cycle is REPORTED with its members in name order and the links that point forward to a
 *    not-yet-generated member listed as unresolved (FR-008) — it never deadlocks.
 */
import type { LoadedRecipe } from "../config/layers/recipes.js";
import type { EntityConfig } from "../config/load.js";
import type { Refusal } from "../errors.js";
import type { DerivedModel, Relationship } from "../spec/types.js";

export interface PlanCycle {
  /** Members in the deterministic (name) order they are generated in. */
  members: string[];
  /** `Collection.field` links that point at a member not yet generated, left unresolved and reported. */
  unresolved: string[];
}

export type CountPlan =
  | { kind: "absolute"; n: number }
  | { kind: "perParent"; parent: string; field: string; range: [number, number]; distribution: "uniform" | "zipf" }
  | { kind: "import" };

export interface PlanLink {
  field: string;
  to: string;
  onDelete: "restrict" | "cascade" | "setNull";
}

export interface GenerationPlan {
  /** Every collection, parents first (fixtures and generation both follow it). */
  order: string[];
  cycles: PlanCycle[];
  /** Counts for the collections the selected recipe generates; a collection absent from it is not generated. */
  counts: Record<string, CountPlan>;
  /** The decided links of each collection, with their delete policy — the foreign keys the store creates. */
  links: Record<string, PlanLink[]>;
  /** Every reason generation must not proceed; non-empty means refuse to start (FR-005). */
  refusals: Refusal[];
}

export interface PlanInput {
  model: DerivedModel;
  recipe?: LoadedRecipe;
  /** For each decided link's `onDelete` (default `restrict`). */
  entities?: Record<string, EntityConfig>;
}

/** A minimal binary min-heap of strings, so a long chain does not cost a re-sort per step. */
class MinHeap {
  readonly #items: string[] = [];
  get size(): number {
    return this.#items.length;
  }
  push(value: string): void {
    const a = this.#items;
    a.push(value);
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if ((a[parent] as string) <= (a[i] as string)) break;
      [a[parent], a[i]] = [a[i] as string, a[parent] as string];
      i = parent;
    }
  }
  pop(): string {
    const a = this.#items;
    const top = a[0] as string;
    const last = a.pop() as string;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && (a[l] as string) < (a[m] as string)) m = l;
        if (r < a.length && (a[r] as string) < (a[m] as string)) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i] as string, a[m] as string];
        i = m;
      }
    }
    return top;
  }
}

/** Tarjan's strongly-connected components, iteratively. `parents` maps a node to the nodes it depends on. */
function components(nodes: string[], parents: Map<string, string[]>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  let counter = 0;
  for (const root of nodes) {
    if (index.has(root)) continue;
    const frames: Array<{ node: string; next: number }> = [{ node: root, next: 0 }];
    index.set(root, counter);
    low.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);
    while (frames.length > 0) {
      const frame = frames[frames.length - 1] as { node: string; next: number };
      const edges = parents.get(frame.node) ?? [];
      if (frame.next < edges.length) {
        const to = edges[frame.next] as string;
        frame.next += 1;
        if (!index.has(to)) {
          index.set(to, counter);
          low.set(to, counter);
          counter += 1;
          stack.push(to);
          onStack.add(to);
          frames.push({ node: to, next: 0 });
        } else if (onStack.has(to)) {
          low.set(frame.node, Math.min(low.get(frame.node) as number, index.get(to) as number));
        }
        continue;
      }
      if (low.get(frame.node) === index.get(frame.node)) {
        const members: string[] = [];
        for (;;) {
          const member = stack.pop() as string;
          onStack.delete(member);
          members.push(member);
          if (member === frame.node) break;
        }
        out.push(members.sort());
      }
      frames.pop();
      const parentFrame = frames[frames.length - 1];
      if (parentFrame) {
        low.set(parentFrame.node, Math.min(low.get(parentFrame.node) as number, low.get(frame.node) as number));
      }
    }
  }
  return out;
}

export function buildGenerationPlan(input: PlanInput): GenerationPlan {
  const names = input.model.resources.map((r) => r.name).sort();
  const known = new Set(names);
  const decided = input.model.relationships.filter((r) => r.status === "decided" && known.has(r.from) && known.has(r.to));

  const parents = new Map<string, string[]>();
  for (const name of names) parents.set(name, []);
  for (const r of decided) {
    const list = parents.get(r.from) as string[];
    if (!list.includes(r.to)) list.push(r.to);
  }
  for (const list of parents.values()) list.sort();

  const comps = components(names, parents);
  const compOf = new Map<string, number>();
  comps.forEach((members, i) => members.forEach((m) => compOf.set(m, i)));

  // Condensation: a component waits for the components its members reference.
  const waitingOn = comps.map(() => new Set<number>());
  const dependants = comps.map(() => new Set<number>());
  for (const r of decided) {
    const child = compOf.get(r.from) as number;
    const parent = compOf.get(r.to) as number;
    if (child === parent) continue;
    waitingOn[child]?.add(parent);
    dependants[parent]?.add(child);
  }
  const key = (i: number): string => (comps[i] as string[])[0] as string;
  const byKey = new Map(comps.map((_, i) => [key(i), i]));
  const ready = new MinHeap();
  comps.forEach((_, i) => {
    if ((waitingOn[i] as Set<number>).size === 0) ready.push(key(i));
  });
  const order: string[] = [];
  while (ready.size > 0) {
    const i = byKey.get(ready.pop()) as number;
    order.push(...(comps[i] as string[]));
    for (const child of dependants[i] as Set<number>) {
      const waiting = waitingOn[child] as Set<number>;
      waiting.delete(i);
      if (waiting.size === 0) ready.push(key(child));
    }
  }

  const position = new Map(order.map((name, i) => [name, i]));
  const cycles: PlanCycle[] = [];
  const selfLinked = new Set(decided.filter((r) => r.from === r.to).map((r) => r.from));
  for (const members of comps) {
    const selfLoop = members.length === 1 && selfLinked.has(members[0] as string);
    if (members.length < 2 && !selfLoop) continue;
    const inside = new Set(members);
    const unresolved = decided
      .filter((r) => inside.has(r.from) && inside.has(r.to) && (position.get(r.to) as number) >= (position.get(r.from) as number))
      .map((r) => `${r.from}.${r.field}`)
      .sort();
    cycles.push({ members: [...members].sort((a, b) => (position.get(a) as number) - (position.get(b) as number)), unresolved });
  }
  cycles.sort((a, b) => (a.members[0] as string).localeCompare(b.members[0] as string));

  const links: Record<string, PlanLink[]> = {};
  for (const r of decided) {
    if (r.cardinality !== "one") continue; // an array of references cannot be a foreign-key column
    const onDelete = input.entities?.[r.from]?.relations?.[r.field]?.onDelete ?? "restrict";
    (links[r.from] ??= []).push({ field: r.field, to: r.to, onDelete });
  }
  for (const list of Object.values(links)) list.sort((a, b) => a.field.localeCompare(b.field));

  const counts: Record<string, CountPlan> = {};
  const refusals: Refusal[] = [];
  const recipe = input.recipe;
  if (recipe) {
    for (const [name, entity] of Object.entries(recipe.entities)) {
      if (!known.has(name)) continue; // reconcile names it; the plan only plans what exists
      if (entity.source === "import") {
        counts[name] = { kind: "import" };
      } else if (entity.count !== undefined) {
        counts[name] = { kind: "absolute", n: entity.count };
      } else if (entity.perParent) {
        const parent = entity.perParent.entity;
        const candidates = decided.filter((r) => r.from === name && r.to === parent);
        const key = `entities.${name}.perParent.entity`;
        if (candidates.length === 0) {
          refusals.push({
            file: recipe.file,
            key,
            cause: `${name} has no decided link to ${parent}, so children cannot be attached to parents; pin the link with entities.${name}.relations.<field>: { to: ${parent}.<id> } (an undetermined link is reported, not acted on)`,
          });
        } else if (candidates.length > 1) {
          refusals.push({
            file: recipe.file,
            key,
            cause: `${name} has ${candidates.length} decided links to ${parent} (${candidates.map((c: Relationship) => c.field).sort().join(", ")}); the tool does not choose between them — leave one decided and pin the rest away`,
          });
        } else {
          counts[name] = {
            kind: "perParent",
            parent,
            field: (candidates[0] as Relationship).field,
            range: entity.perParent.range,
            distribution: entity.perParent.distribution ?? "uniform",
          };
        }
      }
    }
  }

  return { order, cycles, counts, links, refusals };
}
