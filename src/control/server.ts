/**
 * The control plane's own Fastify instance (T031, T033; FR-012, FR-017).
 *
 * It is a separate instance from the mocked surface so the mocked surface's catch-all can
 * never shadow, or be shadowed by, a control operation. `createMock` either mounts it under the
 * reserved prefix on the mock's port or listens it on `control.port`.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { buildControlRoutes, type ControlContext, type ControlError } from "./routes.js";

export function buildControlInstance(ctx: ControlContext): FastifyInstance {
  const control = Fastify({ logger: false });

  // Bodies are read as text and parsed in the handler, so malformed JSON produces the declared
  // 400 `ControlError` rather than the framework's own error envelope.
  control.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    done(null, body);
  });

  buildControlRoutes(control, ctx);

  // Idempotent (FR-017): the answer is the same however many times it is asked, and the
  // shutdown runs once. It starts after the reply has flushed, so the caller sees the 200.
  let shuttingDown = false;
  control.post(`${ctx.prefix}/teardown`, async () => {
    if (!shuttingDown) {
      shuttingDown = true;
      setImmediate(() => ctx.onTeardown());
    }
    return { ok: true };
  });

  control.setErrorHandler((error, _request, reply) => {
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === "number" ? (error as { statusCode: number }).statusCode : 500;
    const message = error instanceof Error ? error.message : String(error);
    const body: ControlError =
      statusCode >= 400 && statusCode < 500
        ? { error: "malformed_request", message }
        : { error: "internal_error", message };
    reply.code(statusCode >= 400 && statusCode < 500 ? statusCode : 500).send(body);
  });

  return control;
}
