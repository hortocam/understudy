/**
 * T042 — an outbound-traffic spy (SC-008, FR-022, constitution VIII).
 *
 * The tool must make no outbound network call other than fetching a spec the user
 * supplied by URL. This helper installs the spy at the layers an outbound call can
 * pass through — the global `fetch` the loader uses for a URL spec, plus the
 * `node:http`/`node:https`/`node:net`/`node:dns` APIs a future implementation might
 * reach for — records every destination, and lets loopback traffic through so the
 * test harness can still drive the running mock over HTTP.
 *
 * The spy never reaches the network for a non-loopback destination: it records the
 * attempt and raises `OutboundAttemptError` instead, so a test that catches a violation
 * cannot itself become the outbound call it is testing. `external` is therefore the
 * precise SC-008 violation set: every recorded destination whose host is not loopback.
 */
import { createRequire } from "node:module";

export type OutboundKind = "fetch" | "http" | "https" | "net" | "dns";

export interface OutboundRecord {
  kind: OutboundKind;
  /** A URL for `fetch`/`http`/`https`, `host:port` for `net`, a hostname for `dns`. */
  target: string;
}

export interface OutboundReport {
  /** Every outbound destination observed, in order, including loopback. */
  records: OutboundRecord[];
  /** Destinations whose host is not loopback — the SC-008 violations. */
  external: OutboundRecord[];
}

/** A sentinel raised in place of a real non-loopback connection attempt. */
export class OutboundAttemptError extends Error {
  readonly record: OutboundRecord;
  constructor(record: OutboundRecord) {
    super(`the spy refused a non-loopback ${record.kind} to ${record.target}`);
    this.name = "OutboundAttemptError";
    this.record = record;
  }
}

/** Loopback hosts: anything a test harness legitimately talks to. */
export function isLoopbackHost(host: string): boolean {
  const lowered = host.toLowerCase();
  if (lowered === "localhost" || lowered === "::1" || lowered === "[::1]" || lowered === "0.0.0.0") return true;
  return /^127\./.test(lowered);
}

function hostOf(target: string): string | undefined {
  // `new URL("localhost:8080")` parses as a URL with an EMPTY hostname, so a bare
  // `host:port` must be handled before trusting the URL parse, and an empty hostname must
  // never be read as a host (it would make a loopback `net`/`http` call look external).
  const withoutPort = target.replace(/:\d+$/, "");
  try {
    const hostname = new URL(target).hostname;
    if (hostname.length > 0) return hostname;
  } catch {
    // Not URL-shaped: fall through to the colon-split form.
  }
  return withoutPort.length > 0 ? withoutPort : undefined;
}

function isExternal(target: string): boolean {
  const host = hostOf(target);
  return host === undefined ? false : !isLoopbackHost(host);
}

/* eslint-disable @typescript-eslint/no-explicit-any -- the spy wraps heterogeneous builtin signatures. */
type AnyFunction = (...args: any[]) => any;

/**
 * Run `fn` with the spy installed; restore every patched function afterwards, even on
 * throw. Returns fn's value plus the recorded traffic.
 */
export async function withOutboundSpy<T>(fn: () => Promise<T>): Promise<{ result: T; report: OutboundReport }> {
  const records: OutboundRecord[] = [];
  const record = (kind: OutboundKind, target: string): OutboundRecord => {
    const entry: OutboundRecord = { kind, target };
    records.push(entry);
    return entry;
  };

  const restores: Array<() => void> = [];
  const patch = (holder: Record<string, unknown>, key: string, wrap: (original: AnyFunction) => AnyFunction): void => {
    const original = holder[key] as AnyFunction | undefined;
    if (typeof original !== "function") return;
    holder[key] = wrap(original);
    restores.push(() => {
      holder[key] = original;
    });
  };

  // 1. global fetch — the loader's outbound path for a URL spec.
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: any, init?: any): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input?.url ?? input);
    const entry = record("fetch", url);
    if (isExternal(url)) return Promise.reject(new OutboundAttemptError(entry));
    return realFetch(input, init);
  }) as typeof globalThis.fetch;
  restores.push(() => {
    globalThis.fetch = realFetch;
  });

  // 2. node:http / node:https request functions — a non-fetch implementation would land here.
  const require = createRequire(import.meta.url);
  for (const moduleName of ["node:http", "node:https"] as const) {
    const protocol = moduleName === "node:http" ? "http" : "https";
    const mod = require(moduleName) as Record<string, unknown>;
    for (const key of ["request", "get"] as const) {
      patch(mod, key, (original) =>
        function patched(this: unknown, ...args: any[]): unknown {
          const first = args[0];
          const target =
            typeof first === "string"
              ? first
              : first instanceof URL
                ? first.href
                : first?.host
                  ? `${protocol}://${String(first.host)}`
                  : `${protocol}://unknown`;
          const entry = record(protocol, target);
          if (isExternal(target)) throw new OutboundAttemptError(entry);
          return original.apply(this as never, args);
        } as AnyFunction,
      );
    }
  }

  // 3. node:net connect — the socket layer underneath every HTTP client.
  const net = require("node:net") as Record<string, unknown>;
  for (const key of ["connect", "createConnection"] as const) {
    patch(net, key, (original) =>
      function patched(this: unknown, ...args: any[]): unknown {
        const options = args[0];
        const rawHost = typeof options === "string" ? options : (options?.host ?? options?.path ?? "unknown");
        const port = typeof options === "object" && options ? options.port : args[1];
        const target = `${String(rawHost)}:${String(port ?? "")}`;
        const entry = record("net", target);
        if (isExternal(target)) throw new OutboundAttemptError(entry);
        return original.apply(this as never, args);
      } as AnyFunction,
    );
  }

  // 4. node:dns lookup — a hostname that is not loopback resolves only to leave the box.
  const dns = require("node:dns") as Record<string, unknown>;
  patch(dns, "lookup", (original) =>
    function patched(this: unknown, ...args: any[]): unknown {
      const hostname = String(args[0] ?? "unknown");
      const entry = record("dns", hostname);
      if (!isLoopbackHost(hostname)) {
        const callback = args.find((arg) => typeof arg === "function") as
          | ((error: Error) => void)
          | undefined;
        if (callback) {
          callback(new OutboundAttemptError(entry));
          return undefined;
        }
        throw new OutboundAttemptError(entry);
      }
      return original.apply(this as never, args);
    } as AnyFunction,
  );

  try {
    const result = await fn();
    return { result, report: { records, external: records.filter((entry) => isExternal(entry.target)) } };
  } finally {
    for (const restore of restores.reverse()) restore();
  }
}
