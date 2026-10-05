import Database from "better-sqlite3";

/**
 * A DRIVER-LEVEL probe (T083): wraps `better-sqlite3`'s `Database#prepare` and records, for every
 * statement the process runs, its SQL text, bound parameters and how many rows crossed from SQLite
 * into JavaScript. This is below the `Store` interface, so it sees what a counting decorator at the
 * interface cannot: a store that reads the WHOLE collection through the driver and slices it in JS
 * returns a perfectly small page to its caller and still materialises everything.
 */
export interface ProbedStatement {
  sql: string;
  params: unknown[];
  method: "all" | "get" | "iterate" | "run";
  /** Rows delivered to JavaScript by this call. */
  rows: number;
}

export interface SqlProbe {
  statements: ProbedStatement[];
  /** Forget what has been recorded so far (e.g. after seeding a collection). */
  clear(): void;
  restore(): void;
}

type Prepare = (this: Database.Database, sql: string) => Database.Statement;

export function installSqlProbe(): SqlProbe {
  const proto = Database.prototype as unknown as { prepare: Prepare };
  const original = proto.prepare;
  const statements: ProbedStatement[] = [];

  proto.prepare = function patched(this: Database.Database, sql: string): Database.Statement {
    const statement = original.call(this, sql);
    return new Proxy(statement, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, target) as unknown;
        if (typeof value !== "function") return value;
        if (property === "all" || property === "get" || property === "run") {
          return (...params: unknown[]): unknown => {
            const result = (value as (...a: unknown[]) => unknown).apply(target, params);
            const rows = property === "all" ? (result as unknown[]).length : property === "get" ? (result === undefined ? 0 : 1) : 0;
            statements.push({ sql, params, method: property, rows });
            return result;
          };
        }
        if (property === "iterate") {
          return (...params: unknown[]): Iterable<unknown> => {
            const entry: ProbedStatement = { sql, params, method: "iterate", rows: 0 };
            statements.push(entry);
            const inner = (value as (...a: unknown[]) => Iterable<unknown>).apply(target, params);
            return (function* () {
              for (const row of inner) {
                entry.rows += 1;
                yield row;
              }
            })();
          };
        }
        return (value as (...a: unknown[]) => unknown).bind(receiver === statement ? target : target);
      },
    });
  };

  return {
    statements,
    clear: () => void statements.splice(0),
    restore: () => {
      proto.prepare = original;
    },
  };
}

/** The statements that read rows of `resource`'s table. */
export function readsOf(statements: ProbedStatement[], resource: string): ProbedStatement[] {
  return statements.filter((s) => s.method !== "run" && new RegExp(`FROM "${resource}"`).test(s.sql));
}
