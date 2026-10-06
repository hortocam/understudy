/**
 * The thin HTTP client for the control plane (T035; FR-019).
 *
 * One method per control operation the CLI offers, each issuing exactly one request and
 * returning the decoded answer. There is deliberately no fallback: when the control plane is
 * unreachable the call fails with a `ControlConnectionError`; it never reads the store or does
 * the work locally, which is what would make the CLI a second implementation (constitution II).
 */

export class ControlConnectionError extends Error {
  constructor(
    readonly baseUrl: string,
    cause: string,
  ) {
    super(
      `cannot reach the control plane at ${baseUrl} (${cause}); is the mock running? start it with "ustdy up", or point at it with --control-url`,
    );
    this.name = "ControlConnectionError";
  }
}

/** The control plane answered, but with a `ControlError` (or an unexpected status). */
export class ControlRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ControlRequestError";
  }
}

export interface OperationRef {
  method: string;
  path: string;
  operationId?: string;
}

export interface OperationsAnswer {
  live: OperationRef[];
  notImplemented: OperationRef[];
}

export interface ResetRequest {
  mode: string;
  entities?: string[];
}

export interface ResetAnswer {
  ok: boolean;
  mode: string;
  removed: Record<string, number>;
}

export interface GenerateRequest {
  recipe?: string;
  seed?: number;
}

export interface GenerateAnswer {
  ok: boolean;
  recipe: string;
  seed: number;
  regenerated: boolean;
  clock: { mode: string; pinned: boolean; instant?: string };
  created: Record<string, Record<string, number>>;
  counts?: Record<string, Record<string, number>>;
  redraws?: number;
}

export interface RequestsQuery {
  method?: string;
  status?: string;
  live?: boolean;
  limit?: string;
}

export interface RequestLogEntry {
  method: string;
  path: string;
  status: number;
  live: boolean;
  durationMs: number;
  at: string;
}

export interface RequestsAnswer {
  total: number;
  requests: RequestLogEntry[];
}

function describeCause(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause instanceof Error) {
      const code = (cause as Error & { code?: string }).code;
      return code ?? cause.message;
    }
    return error.message;
  }
  return String(error);
}

export class ControlClient {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async health(): Promise<unknown> {
    return this.#call("GET", "/health");
  }

  async operations(): Promise<OperationsAnswer> {
    return (await this.#call("GET", "/operations")) as OperationsAnswer;
  }

  async reset(request: ResetRequest): Promise<ResetAnswer> {
    return (await this.#call("POST", "/reset", request)) as ResetAnswer;
  }

  async generate(request: GenerateRequest): Promise<GenerateAnswer> {
    return (await this.#call("POST", "/generate", request)) as GenerateAnswer;
  }

  async requests(query: RequestsQuery): Promise<RequestsAnswer> {
    const params = new URLSearchParams();
    if (query.method !== undefined) params.set("method", query.method);
    if (query.status !== undefined) params.set("status", query.status);
    if (query.live) params.set("live", "true");
    if (query.limit !== undefined) params.set("limit", query.limit);
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return (await this.#call("GET", `/requests${suffix}`)) as RequestsAnswer;
  }

  async teardown(): Promise<void> {
    await this.#call("POST", "/teardown");
  }

  /** True once nothing answers at the control URL any more (used by `down` and `up`). */
  async isGone(): Promise<boolean> {
    try {
      await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(1000) });
      return false;
    } catch {
      return true;
    }
  }

  async #call(method: string, path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new ControlConnectionError(this.baseUrl, describeCause(error));
    }
    const text = await response.text();
    let decoded: unknown;
    try {
      decoded = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      throw new ControlRequestError(response.status, `${method} ${path} answered ${response.status} with a body that is not JSON`);
    }
    if (!response.ok) {
      const message =
        typeof decoded === "object" && decoded !== null && "message" in decoded
          ? String((decoded as { message: unknown }).message)
          : `${method} ${path} answered ${response.status}`;
      throw new ControlRequestError(response.status, message);
    }
    return decoded;
  }
}
