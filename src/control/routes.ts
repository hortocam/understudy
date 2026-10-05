/**
 * The control plane's operations (T029, T032; FR-012–FR-016, FR-018), exactly as declared in
 * `contracts/control-api.openapi.json`: health, operations, reset, requests, openapi.json,
 * and the "unknown control operation" answer for anything else under the reserved prefix.
 *
 * Every answer is JSON. A failure is a `ControlError` — `{ error, message, field? }` — that
 * names the offending input, never the framework's own envelope.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  ConfigRefusedError,
  GenerationMarkerMismatchError,
  GenerationRefusedError,
  IdentityRangeOverlapError,
  IdentitySpaceExhaustedError,
  InvariantViolatedError,
  RecipeNotFoundError,
  UnknownGeneratorError,
} from "../errors.js";
import type { OperationRef, Resource } from "../spec/types.js";
import { ORIGINS, ReferenceViolationError, type Origin, type RequestLogEntry, type Store } from "../store/index.js";
import { CONTROL_API_CONTENT_TYPE } from "./openapi.js";

/** What a generation run reports; structurally satisfied by `data/generate.ts`'s summary. */
export interface GenerateAnswer {
  recipe: string;
  seed: number;
  regenerated: boolean;
  created: Record<string, Partial<Record<Origin, number>>>;
  counts: Record<string, Partial<Record<Origin, number>>>;
  provenance: Record<string, Record<string, Record<string, number>>>;
  redraws: number;
  instant?: string;
}

export interface ControlContext {
  /** The reserved prefix, e.g. `/__understudy`; no trailing slash. */
  prefix: string;
  store: Store;
  live: OperationRef[];
  notImplemented: OperationRef[];
  /** The derived resources: reset scope and the identity counters to rewind. */
  resources: Resource[];
  /** `config.ids.generatedStart`: where a rewound counter starts again. */
  idsStart: number;
  /** Per-collection API-identity start (an entity's own `generatedStart`, or a formatted range's start). */
  idStarts?: Record<string, number>;
  /** Apply a recipe to the running mock (FR-021). The same code path `up --recipe` uses. */
  generate: (options: { recipe?: string; seed?: number }) => Promise<GenerateAnswer>;
  /** The clock in force, reported with each generation (FR-019). */
  clock: { mode: string; pinned: boolean };
  /** The inlined contract text, served verbatim. */
  openapiBytes: string;
  /** Shut the running mock down. Idempotent. */
  onTeardown: () => void;
}

export interface ControlError {
  error: string;
  message: string;
  field?: string;
}

const DEFAULT_REQUEST_LIMIT = 100;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformed(reply: FastifyReply, message: string, field: string): FastifyReply {
  const body: ControlError = { error: "malformed_request", message, field };
  return reply.code(400).send(body);
}

/** Read the reset body: tolerates a missing or empty one, refuses text that is not JSON. */
function readJsonBody(raw: unknown): { ok: true; value: unknown } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== "string") return { ok: true, value: raw };
  if (raw.trim().length === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false };
  }
}

const INTEGER = /^-?\d+$/;

type QueryValue = string | string[] | undefined;

interface RequestFilter {
  method?: string;
  path?: string;
  status?: number;
  live?: boolean;
  limit: number;
}

/** Parse the `requests` query, or name the offending parameter. */
function readRequestFilter(query: Record<string, QueryValue>): { filter: RequestFilter } | { message: string; field: string } {
  const filter: RequestFilter = { limit: DEFAULT_REQUEST_LIMIT };
  for (const field of ["method", "path", "status", "live", "limit"] as const) {
    const value = query[field];
    if (value === undefined) continue;
    if (typeof value !== "string") return { message: `query parameter "${field}" was given more than once`, field };
    switch (field) {
      case "method":
        filter.method = value.toUpperCase();
        break;
      case "path":
        filter.path = value;
        break;
      case "status":
        if (!INTEGER.test(value)) return { message: `query parameter "status" must be an integer, got "${value}"`, field };
        filter.status = Number(value);
        break;
      case "live":
        if (value !== "true" && value !== "false") {
          return { message: `query parameter "live" must be "true" or "false", got "${value}"`, field };
        }
        filter.live = value === "true";
        break;
      case "limit":
        if (!INTEGER.test(value) || Number(value) < 0) {
          return { message: `query parameter "limit" must be a non-negative integer, got "${value}"`, field };
        }
        filter.limit = Number(value);
        break;
    }
  }
  return { filter };
}

function matches(entry: RequestLogEntry, filter: RequestFilter): boolean {
  if (filter.method !== undefined && entry.method.toUpperCase() !== filter.method) return false;
  if (filter.path !== undefined && entry.path !== filter.path) return false;
  if (filter.status !== undefined && entry.status !== filter.status) return false;
  if (filter.live !== undefined && entry.live !== filter.live) return false;
  return true;
}

/**
 * Wipe (data-model.md §3): remove every record whose origin is not `static`, and rewind each
 * affected resource's identity counter so a wiped mock starts counting where it began.
 */
function wipe(ctx: ControlContext, scope: Resource[]): Record<string, number> {
  const removed: Record<string, number> = {};
  const doomed = new Map<string, string[]>();
  for (const resource of scope) {
    const identities = ctx.store
      .list(resource.name)
      .filter((record) => record.origin !== "static")
      .map((record) => record.identity);
    doomed.set(resource.name, identities);
    removed[resource.name] = identities.length;
  }

  // One transaction: a reset is all-or-nothing, and foreign-key checks wait for the commit so a
  // parent and its children can be reset together.
  ctx.store.transaction(() => {
    if (scope.length === ctx.resources.length) {
      // Everything is in scope, so the store-wide removal is exactly the wipe.
      for (const origin of ORIGINS) {
        if (origin !== "static") ctx.store.removeByOrigin(origin);
      }
    } else {
      // `removeByOrigin` is store-wide; a scoped reset deletes only the named resources' records.
      for (const [name, identities] of doomed) {
        for (const identity of identities) ctx.store.delete(name, identity);
      }
    }

    for (const resource of scope) {
      ctx.store.setMeta(`id_seq:${resource.name}`, String(ctx.idStarts?.[resource.name] ?? ctx.idsStart));
      ctx.store.rewindRange(resource.name); // wipe + regenerate must allocate the same identities
    }
  });
  return removed;
}

export function buildControlRoutes(instance: FastifyInstance, ctx: ControlContext): void {
  const prefix = ctx.prefix;

  instance.get(`${prefix}/health`, async () => {
    try {
      ctx.store.getMeta("schema_version");
      return { status: "ok", store: { reachable: true, path: ctx.store.path } };
    } catch (error) {
      return {
        status: "ok",
        store: { reachable: false, path: ctx.store.path, error: error instanceof Error ? error.message : String(error) },
      };
    }
  });

  instance.get(`${prefix}/operations`, async () => ({ live: ctx.live, notImplemented: ctx.notImplemented }));

  instance.post(`${prefix}/reset`, async (request, reply) => {
    const parsed = readJsonBody(request.body);
    if (!parsed.ok) return malformed(reply, "the request body is not valid JSON", "body");
    if (parsed.value !== undefined && !isObject(parsed.value)) {
      return malformed(reply, "the request body must be a JSON object", "body");
    }
    const body = parsed.value ?? {};

    const mode = body.mode;
    if (mode !== undefined && mode !== "wipe") {
      return malformed(reply, `unsupported reset mode ${JSON.stringify(mode)}; the only mode is "wipe"`, "mode");
    }

    let scope = ctx.resources;
    const entities = body.entities;
    if (entities !== undefined) {
      if (!Array.isArray(entities) || !entities.every((name) => typeof name === "string")) {
        return malformed(reply, "entities must be an array of resource names", "entities");
      }
      const known = new Map(ctx.resources.map((resource) => [resource.name, resource]));
      const picked: Resource[] = [];
      for (const name of new Set(entities as string[])) {
        const resource = known.get(name);
        if (!resource) {
          return malformed(reply, `unknown entity "${name}"; known entities: ${[...known.keys()].join(", ")}`, "entities");
        }
        picked.push(resource);
      }
      scope = picked;
    }

    try {
      return { ok: true, mode: "wipe", removed: wipe(ctx, scope) };
    } catch (error) {
      // A scoped reset of a parent while records of another collection still reference it is
      // refused by the store's foreign key (restrict): say which, rather than answer a bare 500.
      if (error instanceof ReferenceViolationError) {
        return malformed(
          reply,
          `cannot reset ${scope.map((r) => r.name).join(", ")} on its own: other records still reference ${scope.length === 1 ? "it" : "them"} (onDelete: restrict); include the referencing collections in the reset, or reset them all`,
          "entities",
        );
      }
      throw error;
    }
  });

  instance.post(`${prefix}/generate`, async (request, reply) => {
    const parsed = readJsonBody(request.body);
    if (!parsed.ok) return malformed(reply, "the request body is not valid JSON", "body");
    if (parsed.value !== undefined && !isObject(parsed.value)) return malformed(reply, "the request body must be a JSON object", "body");
    const body = parsed.value ?? {};
    for (const key of Object.keys(body)) {
      if (key !== "recipe" && key !== "seed") return malformed(reply, `unknown field "${key}"; the body takes only "recipe" and "seed"`, key);
    }
    if (body.recipe !== undefined && (typeof body.recipe !== "string" || body.recipe.length === 0)) {
      return malformed(reply, "recipe must be a non-empty string", "recipe");
    }
    if (body.seed !== undefined && (typeof body.seed !== "number" || !Number.isInteger(body.seed))) {
      return malformed(reply, "seed must be an integer", "seed");
    }
    try {
      const answer = await ctx.generate({
        ...(body.recipe !== undefined ? { recipe: body.recipe as string } : {}),
        ...(body.seed !== undefined ? { seed: body.seed as number } : {}),
      });
      return {
        ok: true,
        recipe: answer.recipe,
        seed: answer.seed,
        regenerated: answer.regenerated,
        clock: { mode: ctx.clock.mode, pinned: ctx.clock.pinned, ...(answer.instant ? { instant: answer.instant } : {}) },
        created: answer.created,
        counts: answer.counts,
        provenance: answer.provenance,
        redraws: answer.redraws,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof RecipeNotFoundError) {
        const refused: ControlError = { error: "unknown_recipe", message, field: "recipe" };
        return reply.code(404).send(refused);
      }
      if (error instanceof GenerationMarkerMismatchError) {
        const refused: ControlError = { error: "generation_conflict", message };
        return reply.code(409).send(refused);
      }
      if (
        error instanceof ConfigRefusedError ||
        error instanceof InvariantViolatedError ||
        error instanceof GenerationRefusedError ||
        error instanceof IdentitySpaceExhaustedError ||
        error instanceof IdentityRangeOverlapError ||
        error instanceof UnknownGeneratorError
      ) {
        const refused: ControlError = { error: "generation_refused", message };
        return reply.code(422).send(refused);
      }
      throw error;
    }
  });

  instance.get(`${prefix}/requests`, async (request, reply) => {
    const read = readRequestFilter(request.query as Record<string, QueryValue>);
    if ("message" in read) return malformed(reply, read.message, read.field);
    const matching = ctx.store.listRequests().filter((entry) => matches(entry, read.filter));
    // The store lists oldest first; the contract answers newest first.
    const requests = matching.reverse();
    return { total: requests.length, requests: requests.slice(0, read.filter.limit) };
  });

  instance.get(`${prefix}/openapi.json`, async (_request, reply) =>
    reply.type(CONTROL_API_CONTENT_TYPE).send(ctx.openapiBytes),
  );

  // Registered last: anything else under the reserved prefix is an unknown CONTROL operation
  // and is never routed into the mocked surface (FR-012).
  const unknown = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const path = request.url.split("?")[0] ?? request.url;
    const body: ControlError = {
      error: "unknown_control_operation",
      message: `no control operation ${request.method} ${path}`,
      field: path,
    };
    return reply.code(404).send(body);
  };
  instance.all(prefix, unknown);
  instance.all(`${prefix}/*`, unknown);
  instance.setNotFoundHandler(unknown);
}
