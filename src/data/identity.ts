/**
 * Reserved identity ranges across the four identity spaces (FR-017, FR-018, SC-006).
 *
 * A "range" is a span over whatever identity space the document declares — the measured target mixes
 * integer, uuid, prefixed-string and opaque identities within ONE document, so an integer-only
 * reservation would silently collide on the others. The space comes from the declared identity
 * field (`planIdentity`), a reserved span is kept disjoint from fixture identities (a collision is
 * a startup refusal naming the collection), and an allocator hands identities out of it.
 *
 *  - integer   `ids.generatedStart` upward (an entity's own start wins over the global one)
 *  - formatted the declared pattern's numeric run: from the global start, or `ids.reserved:
 *              "EVT-100000..EVT-199999"`; the span exhausts by name, it never wraps
 *  - uuid      v4-shaped identities drawn from the collection's stream; `ids.reserved:
 *              "a0000000..afffffff"` constrains the leading eight hex digits
 *  - opaque    no range can be reserved (reported, never guessed); identities stay distinct from
 *              every other row by a membership check
 *
 * Everything the allocator issues is also checked against the table, so generated, fixture and
 * API-written identities cannot collide even if a range was never reserved for one of them.
 */
import type { EntityConfig } from "../config/load.js";
import { IdentitySpaceExhaustedError, type Refusal } from "../errors.js";
import { allocateIdentity, identityCounter, identityRenderer } from "../spec/identity.js";
import type { IdSpaceKind, Resource } from "../spec/types.js";
import type { Store } from "../store/index.js";
import type { Stream } from "./seed.js";

export interface IdentityPlan {
  resource: string;
  space: IdSpaceKind;
  /** The configured or derived range, as written (`generatedStart=100000`, `EVT-1..EVT-9`, `opaque`). */
  declared: string;
  /** The span generation allocates within, `<from>..<to>` (an open end is empty). */
  reserved: string;
  /** First counter (integer and formatted spaces). */
  start: number;
  /** Last counter, inclusive, when the span is bounded. */
  end?: number;
  /** The span of the leading eight hex digits (uuid space with an explicit span). */
  uuidSpan?: [number, number];
  /** True when no range can be reserved in this space (reported, never guessed). */
  unreservable: boolean;
}

export interface PlanIdentityInput {
  resource: Resource;
  entity?: EntityConfig | undefined;
  /** `ids.generatedStart`: the default start for integer and formatted spaces. */
  globalStart: number;
  /** The identities the fixtures declare for this collection. */
  fixtureIds: string[];
}

const CONFIG_FILE = "understudy.yaml";
const HEX8 = /^[0-9a-f]{8}$/;

export function planIdentity(input: PlanIdentityInput): { plan: IdentityPlan; refusals: Refusal[] } {
  const { resource, entity } = input;
  const refusals: Refusal[] = [];
  const key = `entities.${resource.name}.ids.reserved`;
  const refuse = (cause: string): void => void refusals.push({ file: CONFIG_FILE, key, cause });
  const reserved = entity?.ids?.reserved;
  const base = { resource: resource.name, unreservable: false };

  if (resource.idSpace === "integer") {
    const start = entity?.ids?.generatedStart ?? input.globalStart;
    return { plan: { ...base, space: "integer", declared: `generatedStart=${start}`, reserved: `${start}..`, start }, refusals };
  }

  if (resource.idSpace === "uuid") {
    let span: [number, number] | undefined;
    if (reserved !== undefined) {
      const [from, to, ...rest] = reserved.split("..");
      if (from === undefined || to === undefined || rest.length > 0 || !HEX8.test(from) || !HEX8.test(to)) {
        refuse(`${resource.name}: "${reserved}" is not a span of the leading eight hex digits written '<from>..<to>' (e.g. a0000000..afffffff)`);
      } else if (Number.parseInt(from, 16) > Number.parseInt(to, 16)) {
        refuse(`${resource.name}: the span ${reserved} is inverted (from is greater than to)`);
      } else {
        span = [Number.parseInt(from, 16), Number.parseInt(to, 16)];
        for (const id of input.fixtureIds) {
          const lead = Number.parseInt(id.slice(0, 8), 16);
          if (!Number.isNaN(lead) && lead >= span[0] && lead <= span[1]) {
            refuse(`${resource.name}: fixture identity ${id} lies inside the generated span ${reserved}; the ranges overlap`);
          }
        }
      }
    }
    return {
      plan: {
        ...base,
        space: "uuid",
        declared: reserved ?? "uuid",
        reserved: reserved ?? "00000000..ffffffff",
        start: 0,
        ...(span ? { uuidSpan: span } : {}),
      },
      refusals,
    };
  }

  if (resource.idSpace === "formatted" && identityRenderer(resource)) {
    const render = identityRenderer(resource) as (n: number) => string;
    let start = input.globalStart;
    let end: number | undefined;
    let declared = `generatedStart=${start}`;
    let span = `${render(start)}..`;
    if (reserved !== undefined) {
      const [from, to, ...rest] = reserved.split("..");
      const a = from === undefined ? undefined : identityCounter(resource, from);
      const b = to === undefined ? undefined : identityCounter(resource, to);
      if (rest.length > 0 || a === undefined || b === undefined) {
        refuse(`${resource.name}: "${reserved}" is not a span of identities matching ${resource.idPattern} written '<from>..<to>'`);
      } else if (a > b) {
        refuse(`${resource.name}: the span ${reserved} is inverted (from is greater than to)`);
      } else if (render(a) !== from || render(b) !== to) {
        refuse(`${resource.name}: the span ${reserved} is not in the form the pattern ${resource.idPattern} renders (expected ${render(a)}..${render(b)})`);
      } else {
        start = a;
        end = b;
        declared = reserved;
        span = reserved;
      }
    }
    for (const id of input.fixtureIds) {
      const counter = identityCounter(resource, id);
      if (counter !== undefined && counter >= start && (end === undefined || counter <= end)) {
        refuse(`${resource.name}: fixture identity ${id} lies inside the generated range ${span}; the ranges overlap`);
      }
    }
    return { plan: { ...base, space: "formatted", declared, reserved: span, start, ...(end !== undefined ? { end } : {}) }, refusals };
  }

  // Opaque — or a formatted identity whose pattern the generator cannot satisfy (already reported
  // as `identity-pattern-unsupported`): no range can be reserved, so none is guessed.
  if (reserved !== undefined) refuse(`${resource.name}: no span can be reserved in an opaque identity space`);
  return {
    plan: { ...base, space: "opaque", declared: "opaque", reserved: "(unreservable)", start: input.globalStart, unreservable: true },
    refusals,
  };
}

export interface IdentityAllocatorOptions {
  store: Store;
  resource: Resource;
  plan: IdentityPlan;
  /** The collection's own stream (uuid draws consume it, in generation order). */
  stream: Stream;
}

/**
 * Hands identities out of a collection's reserved range, in order. `next()` is in-memory so a
 * whole collection can be allocated inside one transaction; `commit()` persists the cursor in
 * `_id_ranges` in that same transaction (the identity advance and the rows commit together).
 */
export class IdentityAllocator {
  readonly #store: Store;
  readonly #resource: Resource;
  readonly #plan: IdentityPlan;
  readonly #stream: Stream;
  readonly #issued = new Set<string>();
  #counter: number;

  constructor(options: IdentityAllocatorOptions) {
    this.#store = options.store;
    this.#resource = options.resource;
    this.#plan = options.plan;
    this.#stream = options.stream;
    const stored = options.store.readRange(options.resource.name)?.next;
    const resumed = stored !== undefined && options.plan.space !== "uuid" ? Number(stored) : Number.NaN;
    this.#counter = Number.isFinite(resumed) && resumed >= options.plan.start ? resumed : options.plan.start;
  }

  #taken(id: string): boolean {
    return this.#issued.has(id) || this.#store.readOne(this.#resource.name, id) !== undefined;
  }

  next(): string {
    const { plan } = this;
    if (plan.space === "uuid") return this.#nextUuid();
    for (;;) {
      if (plan.end !== undefined && this.#counter > plan.end) {
        throw new IdentitySpaceExhaustedError(this.#resource.name, this.#resource.idPattern ?? plan.reserved);
      }
      const id = allocateIdentity(this.#resource, this.#counter);
      this.#counter += 1;
      if (!this.#taken(id)) {
        this.#issued.add(id);
        return id;
      }
    }
  }

  get plan(): IdentityPlan {
    return this.#plan;
  }

  #nextUuid(): string {
    const { faker, rng } = this.#stream;
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      let id = faker.string.uuid();
      if (this.#plan.uuidSpan) {
        const [from, to] = this.#plan.uuidSpan;
        id = `${rng.int(from, to).toString(16).padStart(8, "0")}${id.slice(8)}`;
      }
      if (!this.#taken(id)) {
        this.#issued.add(id);
        return id;
      }
    }
    throw new IdentitySpaceExhaustedError(this.#resource.name, this.#plan.reserved);
  }

  /** Persist the cursor (inside the caller's transaction). */
  commit(): void {
    if (this.#plan.space === "uuid") return;
    this.#store.advanceRange(this.#resource.name, String(this.#counter));
  }
}
