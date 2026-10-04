/**
 * The tool's own error contract for the mock surface (amendment A1).
 *
 * This is NOT the mocked surface: the mocked surface is derived from the user's OpenAPI
 * document and must not gain tool-specific schemas. What lives here is the one answer the
 * tool produces on its own behalf — the not-implemented response (FR-003, SC-004).
 *
 * `NOT_IMPLEMENTED` is the single home for the status (RFC 9110 §15.6.2); the body shape
 * is `NotImplementedBody`, mirrored in `contracts/mock-errors.schema.yaml`. Nothing else
 * in the codebase may hard-code the literal.
 */
export const NOT_IMPLEMENTED = 501;

export interface NotImplementedBody {
  error: "not_implemented";
  method: string;
  path: string;
  operationId?: string;
  detail: string;
}

/** Build the `NotImplementedBody` for a known-but-unselected operation, naming it. */
export function notImplementedBody(
  operation: {
    method: string;
    path: string;
    operationId?: string;
  },
  reason?: string,
): NotImplementedBody {
  const named = `${operation.method} ${operation.path}${operation.operationId ? ` (${operation.operationId})` : ""}`;
  const body: NotImplementedBody = {
    error: "not_implemented",
    method: operation.method,
    path: operation.path,
    detail:
      reason ??
      `operation ${named} is in the document but was not selected; this mock does not implement it`,
  };
  if (operation.operationId !== undefined) body.operationId = operation.operationId;
  return body;
}

/**
 * The refusal for a *live* operation the model could not bind to CRUD semantics (a route
 * with no resource). It is not a record-not-found and it is not a success: the mock has
 * nothing honest to serve, so it says so loudly rather than answering an invented `200 {}`
 * (constitution VI). Same body shape as `NotImplementedBody` — one tool-owned error contract.
 */
export function unboundOperationBody(operation: {
  method: string;
  path: string;
  operationId?: string;
}): NotImplementedBody {
  const named = `${operation.method} ${operation.path}${operation.operationId ? ` (${operation.operationId})` : ""}`;
  return notImplementedBody(
    operation,
    `operation ${named} is live but this mock derived no CRUD semantics for it (reported at startup as a route without a resource); this mock does not implement it`,
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The first 2xx status an operation declares, or undefined. */
export function successStatus(operation: Record<string, unknown>): number | undefined {
  const responses = operation.responses;
  if (!isObject(responses)) return undefined;
  const codes = Object.keys(responses)
    .map(Number)
    .filter((code) => code >= 200 && code < 300)
    .sort((a, b) => a - b);
  return codes[0];
}

/** The declared response body schema for a status code, if the document declares one. */
export function declaredResponseSchema(operation: Record<string, unknown>, status: number): unknown {
  const responses = operation.responses;
  if (!isObject(responses)) return undefined;
  const response = responses[String(status)];
  if (!isObject(response)) return undefined;
  const content = response.content;
  if (!isObject(content)) return undefined;
  const json = isObject(content["application/json"]) ? content["application/json"] : Object.values(content)[0];
  if (isObject(json) && isObject(json.schema)) return json.schema;
  return undefined;
}

/** Every status the operation declares, as numbers. */
export function declaredStatuses(operation: Record<string, unknown>): number[] {
  const responses = operation.responses;
  if (!isObject(responses)) return [];
  return Object.keys(responses)
    .map(Number)
    .filter((code) => Number.isInteger(code));
}

/**
 * The status the document declares for a client error, preferring `preferred` and
 * otherwise the first 4xx it declares (FR-005: render the document's status, not ours).
 * Returns undefined when the document declares no client-error response at all.
 */
export function declaredClientStatus(
  operation: Record<string, unknown>,
  preferred: number,
): number | undefined {
  const statuses = declaredStatuses(operation);
  if (statuses.includes(preferred)) return preferred;
  const clientErrors = statuses.filter((code) => code >= 400 && code < 500).sort((a, b) => a - b);
  return clientErrors[0];
}


export interface ErrorRender {
  status: number;
  body: unknown;
}

/**
 * Synthesise a body conforming to a declared schema, from `{ code, message }`.
 *
 * The document declares its own error shape (our fixture declares `{ error, message }`);
 * the tool must render *that* shape rather than its own (FR-008). Property names are
 * matched loosely so a document naming the fields differently still gets a valid body.
 */
function synthesise(schema: unknown, context: { code: string; message: string }): unknown {
  if (!isObject(schema)) return undefined;
  const properties = isObject(schema.properties) ? schema.properties : undefined;
  if (!properties) {
    // No object shape declared: emit a body that satisfies the common error schemas.
    return { error: context.code, message: context.message };
  }
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : Object.keys(properties);
  const body: Record<string, unknown> = {};
  for (const key of Object.keys(properties)) {
    const property = properties[key];
    const type = isObject(property) ? property.type : undefined;
    const isString = type === "string" || (Array.isArray(type) && type.includes("string"));
    let value: unknown;
    if (/^(error|code|type|reason)$/i.test(key)) value = context.code;
    else if (/^(message|detail|description|title)$/i.test(key)) value = context.message;
    else if (isString) value = context.message;
    else if (type === "integer" || type === "number") value = 0;
    else if (type === "boolean") value = false;
    else value = null;
    if (value !== null && value !== undefined) body[key] = value;
    else if (required.includes(key)) body[key] = isString ? context.message : value;
  }
  return body;
}

/**
 * Render the document's *declared* error response for `status` (FR-005, FR-008), or
 * undefined when the operation declares no such response.
 */
export function renderDeclaredError(
  operation: Record<string, unknown>,
  status: number,
  context: { code: string; message: string },
): ErrorRender | undefined {
  const responses = operation.responses;
  if (!isObject(responses) || !isObject(responses[String(status)])) return undefined;
  const schema = declaredResponseSchema(operation, status);
  const body = synthesise(schema, context);
  return { status, body: body ?? { error: context.code, message: context.message } };
}
