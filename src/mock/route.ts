/**
 * The mocked surface: match a request against the live operations derived from the
 * document, dispatch it to the CRUD engine, and answer everything else honestly
 * (FR-002, FR-003, FR-005, FR-008; amendment A1).
 *
 * A single catch-all route does the matching by hand. That is deliberate: the spec
 * distinguishes three outcomes — a live operation, a *declared but unselected* operation
 * (`NOT_IMPLEMENTED`), and a path the document does not declare at all (plain 404) — and a
 * framework's own router can only express two of them without inventing a fourth.
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { DerivedModel, DocumentOperation, Resource, ResourceOperations } from "../spec/types.js";
import type { CrudContext } from "./crud.js";
import { createRecord, deleteRecord, readRecord, updateRecord } from "./crud.js";
import { listRecords, ListCursorError } from "./list.js";
import { collectOperations } from "../spec/operations.js";
import { declaredClientStatus, NOT_IMPLEMENTED, notImplementedBody, renderDeclaredError, unboundOperationBody } from "./errors.js";
import { validateBody, validateParameters } from "./validate.js";
import { ReferenceViolationError } from "../store/index.js";

export interface RouteContext {
  document: Record<string, unknown>;
  model: DerivedModel;
  live: DocumentOperation[];
  crud: CrudContext;
  /** Prefix every mocked route behind this path (config `server.basePath`). */
  basePath: string;
  /** Called once per mocked-surface request, after the response (FR-016). Absent: nothing is recorded. */
  recordRequest?: (entry: {
    method: string;
    path: string;
    status: number;
    live: boolean;
    durationMs: number;
    at: string;
  }) => void;
}

const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "head", "options"] as const;

interface PathRoute {
  template: string;
  regex: RegExp;
  paramNames: string[];
  methods: Set<string>;
  /** Segment count, for specificity when two templates both match. */
  depth: number;
  /** Length of the template's literal characters, the second specificity tiebreak. */
  literalLength: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compilePath(template: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const parts = template.split("/").map((segment) => {
    const match = /^\{([^}]+)\}$/.exec(segment);
    if (match) {
      paramNames.push(match[1] as string);
      return "([^/]+)";
    }
    return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  return { regex: new RegExp(`^${parts.join("/")}$`), paramNames };
}

function buildPathRoutes(document: Record<string, unknown>): PathRoute[] {
  const paths = document.paths;
  if (!isObject(paths)) return [];
  const routes: PathRoute[] = [];
  for (const [template, pathItem] of Object.entries(paths)) {
    if (!isObject(pathItem)) continue;
    const methods = new Set<string>();
    for (const method of HTTP_METHODS) {
      if (isObject(pathItem[method])) methods.add(method.toUpperCase());
    }
    if (methods.size === 0) continue;
    const { regex, paramNames } = compilePath(template);
    routes.push({
      template,
      regex,
      paramNames,
      methods,
      depth: template.split("/").filter((segment) => segment.length > 0).length,
      literalLength: template.replace(/\{[^}]+\}/g, "").length,
    });
  }
  return routes;
}

interface OperationBinding {
  resource: Resource;
  kind: keyof ResourceOperations;
  operation: DocumentOperation;
}

function bindOperations(model: DerivedModel, live: DocumentOperation[]): Map<string, OperationBinding> {
  const bindings = new Map<string, OperationBinding>();
  const byKey = new Map(live.map((operation) => [`${operation.method} ${operation.path}`, operation]));
  for (const resource of model.resources) {
    const entries = Object.entries(resource.operations) as Array<
      [keyof ResourceOperations, { method: string; path: string }]
    >;
    for (const [kind, ref] of entries) {
      const operation = byKey.get(`${ref.method} ${ref.path}`);
      if (operation) bindings.set(`${ref.method} ${ref.path}`, { resource, kind, operation });
    }
  }
  return bindings;
}

function declaredSuccess(operation: DocumentOperation): number {
  const responses = operation.operation.responses;
  if (!isObject(responses)) return 200;
  const codes = Object.keys(responses)
    .map(Number)
    .filter((code) => code >= 200 && code < 300)
    .sort((a, b) => a - b);
  return codes[0] ?? 200;
}

/** The status and body for a missing record: the document's declared error status (FR-005). */
function missingRecord(resource: Resource, operation: DocumentOperation, identity: string): { status: number; body: unknown } {
  const message = `no ${resource.name} with identity ${identity}`;
  const rendered = renderDeclaredError(operation.operation, declaredClientStatus(operation.operation, 404) ?? 404, {
    code: "not_found",
    message,
  });
  return rendered ?? { status: 404, body: { error: "not_found", message } };
}

/** The body when a request violates the document: the declared status and error shape (FR-008). */
function invalidRequest(operation: DocumentOperation): { status: number; body: unknown } {
  const message = "the request does not match the operation's declared schema";
  const rendered = renderDeclaredError(operation.operation, declaredClientStatus(operation.operation, 400) ?? 400, {
    code: "invalid_request",
    message,
  });
  return rendered ?? { status: 400, body: { error: "invalid_request", message } };
}

/**
 * A write that broke a foreign key, answered in the document's own declared error vocabulary:
 * a missing parent is a bad request (400), a delete of a still-referenced parent is a conflict
 * (409); each falls back to the first client error the operation declares, and only to our own
 * status when it declares none (FR-005, FR-008). The mock states the cause rather than a bare 500.
 */
function referenceViolation(operation: DocumentOperation, error: ReferenceViolationError): { status: number; body: unknown } {
  const preferred = error.kind === "referenced" ? 409 : 400;
  const message =
    error.kind === "referenced"
      ? `${error.resource} cannot be deleted: other records still reference it`
      : `${error.resource} references a record that does not exist`;
  const rendered = renderDeclaredError(operation.operation, declaredClientStatus(operation.operation, preferred) ?? preferred, {
    code: error.kind === "referenced" ? "conflict" : "invalid_reference",
    message,
  });
  return rendered ?? { status: preferred, body: { error: error.kind === "referenced" ? "conflict" : "invalid_reference", message } };
}

interface ParsedBody {
  value: unknown;
  ok: boolean;
}

function parseJsonBody(body: unknown): ParsedBody {
  if (body === undefined || body === null) return { value: undefined, ok: true };
  if (typeof body !== "string") return { value: body, ok: true };
  if (body.trim().length === 0) return { value: undefined, ok: true };
  try {
    return { value: JSON.parse(body) as unknown, ok: true };
  } catch {
    return { value: undefined, ok: false };
  }
}

export function buildMockServer(context: RouteContext): FastifyInstance {
  const server = Fastify({ logger: false });
  const markers = new WeakMap<FastifyRequest, { live: boolean }>();

  // Bodies are read as text and parsed here, so a malformed JSON body produces the
  // document's declared error rather than the framework's own error envelope (FR-008).
  server.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    done(null, body);
  });

  const pathRoutes = buildPathRoutes(context.document);
  const liveKeys = new Set(context.live.map((operation) => `${operation.method} ${operation.path}`));
  const declaredByKey = new Map(
    collectOperations(context.document).map((operation) => [`${operation.method} ${operation.path}`, operation]),
  );
  const bindings = bindOperations(context.model, context.live);
  const basePath = context.basePath.replace(/\/+$/, "");

  // FR-016: the request log covers the mocked surface only. `handle()` sets a marker, so a
  // request that never reaches it (hijacked control traffic) is never logged.
  const { recordRequest } = context;
  if (recordRequest) {
    const started = new WeakMap<FastifyRequest, { at: string; clock: number }>();
    server.addHook("onRequest", (request, _reply, done) => {
      started.set(request, { at: new Date().toISOString(), clock: performance.now() });
      done();
    });
    server.addHook("onResponse", (request, reply, done) => {
      const start = started.get(request);
      const marker = markers.get(request);
      if (start && marker) {
        recordRequest({
          method: request.method.toUpperCase(),
          path: request.url.split("?")[0] ?? request.url,
          status: reply.statusCode,
          live: marker.live,
          durationMs: Math.round(performance.now() - start.clock),
          at: start.at,
        });
      }
      done();
    });
  }

  const handle = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const marker = { live: false };
    markers.set(request, marker);
    const rawPath = request.url.split("?")[0] ?? request.url;
    if (basePath.length > 0 && rawPath !== basePath && !rawPath.startsWith(`${basePath}/`)) {
      return reply.code(404).send({ error: "not_found", message: `no operation is declared for ${rawPath}` });
    }
    const path = basePath.length > 0 ? rawPath.slice(basePath.length) || "/" : rawPath;

    // Most specific template first: an all-literal path beats a templated one.
    const route = pathRoutes
      .filter((candidate) => candidate.regex.test(path))
      .sort((a, b) => a.depth - b.depth || b.literalLength - a.literalLength)[0];
    const method = request.method.toUpperCase();

    if (!route || !route.methods.has(method)) {
      // No operation exists for this method+path, so there is no declared answer to render.
      return reply.code(404).send({ error: "not_found", message: `no operation is declared for ${method} ${path}` });
    }

    const key = `${method} ${route.template}`;
    if (!liveKeys.has(key)) {
      // The operation exists in the document but was not selected (FR-003, SC-004).
      return reply.code(NOT_IMPLEMENTED).send(notImplementedBody(declaredByKey.get(key) ?? { method, path: route.template }));
    }

    const binding = bindings.get(key);
    if (!binding) {
      // A *live* operation the model could not bind to CRUD semantics (a route with no
      // resource): it has no declared representation to serve and inventing `200 {}` would be
      // a silent lie (constitution VI). Refuse loudly, naming the operation, exactly as for a
      // known-but-unselected one.
      const declared = declaredByKey.get(key);
      return reply
        .code(NOT_IMPLEMENTED)
        .send(unboundOperationBody(declared ?? { method, path: route.template }));
    }

    marker.live = true;
    const params: Record<string, string> = {};
    const match = route.regex.exec(path);
    if (match) {
      route.paramNames.forEach((name, index) => {
        params[name] = match[index + 1] as string;
      });
    }
    const identity = params[binding.resource.idField] ?? Object.values(params)[0] ?? "";

    switch (binding.kind) {
      case "list": {
        const query = request.query as Record<string, string | undefined>;
        const declared = Array.isArray(binding.operation.operation.parameters)
          ? binding.operation.operation.parameters
          : [];
        const check = validateParameters(declared, "query", query);
        if (!check.valid) {
          const error = invalidRequest(binding.operation);
          return reply.code(error.status).send(error.body);
        }
        try {
          return reply.code(declaredSuccess(binding.operation)).send(listRecords(context.crud, binding.resource, { query }));
        } catch (error) {
          if (error instanceof ListCursorError) {
            // FR-007: an unrecognised cursor is the document's declared client error, not a
            // silent empty page (data loss dressed up as success).
            const rendered = renderDeclaredError(
              binding.operation.operation,
              declaredClientStatus(binding.operation.operation, 400) ?? 400,
              { code: "invalid_cursor", message: error.message },
            );
            const fallback = { error: "invalid_cursor", message: error.message };
            return reply.code(rendered?.status ?? 400).send(rendered?.body ?? fallback);
          }
          throw error;
        }
      }
      case "create": {
        const parsed = parseJsonBody(await request.body);
        const check = parsed.ok ? validateBody(binding.operation.operation, parsed.value) : { valid: false, messages: [] };
        if (!check.valid) {
          const error = invalidRequest(binding.operation);
          return reply.code(error.status).send(error.body);
        }
        let record: Record<string, unknown>;
        try {
          record = createRecord(context.crud, binding.resource, parsed.value);
        } catch (error) {
          if (error instanceof ReferenceViolationError) {
            const refused = referenceViolation(binding.operation, error);
            return reply.code(refused.status).send(refused.body);
          }
          throw error;
        }
        const status = declaredSuccess(binding.operation);
        return reply.code(status).send(status === 204 ? undefined : record);
      }
      case "read": {
        const found = readRecord(context.crud, binding.resource, identity);
        if (!found) {
          const error = missingRecord(binding.resource, binding.operation, identity);
          return reply.code(error.status).send(error.body);
        }
        return reply.code(declaredSuccess(binding.operation)).send(found);
      }
      case "update":
      case "replace": {
        // FR-006: the *operation* decides the style — PATCH merges, PUT replaces.
        const mode = binding.operation.method === "PUT" ? "replace" : "merge";
        const parsed = parseJsonBody(await request.body);
        const check = parsed.ok ? validateBody(binding.operation.operation, parsed.value) : { valid: false, messages: [] };
        if (!check.valid) {
          const error = invalidRequest(binding.operation);
          return reply.code(error.status).send(error.body);
        }
        let updated: Record<string, unknown> | undefined;
        try {
          updated = updateRecord(context.crud, binding.resource, identity, parsed.value, mode);
        } catch (error) {
          if (error instanceof ReferenceViolationError) {
            const refused = referenceViolation(binding.operation, error);
            return reply.code(refused.status).send(refused.body);
          }
          throw error;
        }
        if (!updated) {
          const error = missingRecord(binding.resource, binding.operation, identity);
          return reply.code(error.status).send(error.body);
        }
        return reply.code(declaredSuccess(binding.operation)).send(updated);
      }
      case "delete": {
        let removed: boolean;
        try {
          removed = deleteRecord(context.crud, binding.resource, identity);
        } catch (error) {
          if (error instanceof ReferenceViolationError) {
            const refused = referenceViolation(binding.operation, error);
            return reply.code(refused.status).send(refused.body);
          }
          throw error;
        }
        if (!removed) {
          const error = missingRecord(binding.resource, binding.operation, identity);
          return reply.code(error.status).send(error.body);
        }
        const status = declaredSuccess(binding.operation);
        return reply.code(status).send(status === 204 ? undefined : {});
      }
      default: {
        return reply.code(declaredSuccess(binding.operation)).send({});
      }
    }
  };

  server.all("/*", handle);
  server.all("/", handle);
  server.setErrorHandler((error, _request, reply) => {
    reply.code(500).send({ error: "internal_error", message: error instanceof Error ? error.message : String(error) });
  });

  return server;
}
