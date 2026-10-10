/** Provides request-scoped GraphQL execution telemetry without exposing query contents. */
import { getOperationAST, type DocumentNode } from "graphql";
import type { Plugin } from "graphql-yoga";
import type { AppBindings } from "../bindings";

/** Mutable state isolated to one GraphQL HTTP request. */
export interface GraphQLRequestTelemetry {
  /** Whether Yoga recognized this request as carrying GraphQL parameters. */
  isGraphQLRequest: boolean;
  /** The selected parsed operation name, or undefined for an anonymous operation. */
  operationName: string | undefined;
  /** Returns the number of D1 statements prepared during this request. */
  statementCount(): number;
}

/** Yoga's per-request server context, including the wrapped D1 binding. */
export interface GraphQLServerContext {
  /** Worker bindings whose DB binding counts every prepare call. */
  env: AppBindings;
  /** Request-local telemetry populated while Yoga parses and executes the operation. */
  telemetry: GraphQLRequestTelemetry;
}

/**
 * Wraps a D1 binding so each prepared statement increments this request's counter.
 *
 * @param database - The original D1 binding.
 * @returns The wrapped database and a function that reads its request-local count.
 */
function createCountingDatabase(database: D1Database): {
  database: D1Database;
  statementCount: () => number;
} {
  let statementCount = 0;
  const countedDatabase = new Proxy(database, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string): D1PreparedStatement => {
          statementCount += 1;
          return target.prepare(query);
        };
      }

      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return { database: countedDatabase, statementCount: () => statementCount };
}

/**
 * Creates bindings and telemetry that are safe to use for exactly one GraphQL request.
 *
 * @param bindings - The Worker's unwrapped bindings.
 * @returns Yoga server context containing the wrapped D1 binding.
 */
export function createGraphQLServerContext(
  bindings: AppBindings,
): GraphQLServerContext {
  const countedDatabase = createCountingDatabase(bindings.DB);

  return {
    env: { ...bindings, DB: countedDatabase.database },
    telemetry: {
      isGraphQLRequest: false,
      operationName: undefined,
      statementCount: countedDatabase.statementCount,
    },
  };
}

/**
 * Records request metadata from Yoga's parsed GraphQL document without reading the HTTP body.
 *
 * @returns A Yoga plugin that updates only the current request's telemetry.
 */
export function createGraphQLTelemetryPlugin(): Plugin<
  GraphQLServerContext,
  GraphQLServerContext
> {
  return {
    onParams({ context }) {
      context.telemetry.isGraphQLRequest = true;
    },
    onParse({ context }) {
      return ({ result }) => {
        if (result instanceof Error || result === null) {
          return;
        }

        context.telemetry.operationName = getOperationAST(
          result as DocumentNode,
          context.params.operationName,
        )?.name?.value;
      };
    },
  };
}
