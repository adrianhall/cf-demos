/**
 * @file Adapts the `DATA_SERVICE` binding's envelope-returning RPC methods to the throwing
 *   {@link DataService} contract the API codes against. Two failure kinds are distinguished:
 *
 *   - An **answered failure** (`{ ok: false, error }`) is re-thrown as a service error with the Data
 *     Worker's code, so `FORBIDDEN` stays a 403 and `NOT_FOUND` a 404.
 *   - A **transport failure** — the Data Worker is unreachable, threw past its envelope, or timed out
 *     — becomes a retryable `DEPENDENCY_FAILURE`, which the API reports as 503. Its detail is
 *     logged, never returned.
 */

import { serviceError, type ServiceErrorValue } from '../shared/common/errors.ts';
import type {
  CrmPort,
  DataService,
  Enveloped,
  PermissionsPort,
  ProjectsPort,
  RpcResult
} from '../shared/data-service/contract.ts';

/**
 * The envelope view of the Data Worker that the binding presents.
 */
export interface DataRpc {
  /**
   * Health.
   */
  health(): Promise<RpcResult<Awaited<ReturnType<DataService['health']>>>>;
  /**
   * Actor resolution.
   */
  resolveActor(
    email: string,
    requestId: string
  ): Promise<RpcResult<Awaited<ReturnType<DataService['resolveActor']>>>>;
  /**
   * User lookup.
   */
  resolveUser(userId: string): Promise<RpcResult<Awaited<ReturnType<DataService['resolveUser']>>>>;
  /**
   * Authorization.
   */
  authorize(
    request: Parameters<DataService['authorize']>[0]
  ): Promise<RpcResult<Awaited<ReturnType<DataService['authorize']>>>>;
  /**
   * The CRM module target.
   */
  crm(): Enveloped<CrmPort>;
  /**
   * The Projects module target.
   */
  projects(): Enveloped<ProjectsPort>;
  /**
   * The Permissions module target.
   */
  permissions(): Enveloped<PermissionsPort>;
}

/**
 * Default upper bound for one Data Worker call.
 */
export const DEFAULT_RPC_TIMEOUT_MS = 10_000;

/**
 * Rebuild a throwable service error from an envelope's error value.
 *
 * @param value The error value.
 * @returns The error.
 */
function rethrow(value: ServiceErrorValue): Error {
  return serviceError(value.code, value.message, {
    requestId: value.requestId,
    retryable: value.retryable,
    ...(value.fields === undefined ? {} : { fields: value.fields })
  });
}

/**
 * Await one RPC call, unwrapping its envelope.
 *
 * @param call The call.
 * @param timeoutMs Upper bound before the call is treated as a dependency failure.
 * @param onTransportError Receives transport failures for logging.
 * @returns The value.
 * @throws {Error} The Data Worker's service error, or a retryable `DEPENDENCY_FAILURE`.
 */
export async function unwrap<T>(
  call: () => Promise<RpcResult<T>>,
  timeoutMs: number,
  onTransportError: (error: unknown) => void
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: RpcResult<T>;
  try {
    result = await Promise.race([
      call(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Data Worker call exceeded ${timeoutMs} ms`)),
          timeoutMs
        );
      })
    ]);
  } catch (error) {
    onTransportError(error);
    throw serviceError('DEPENDENCY_FAILURE', 'The data service is temporarily unavailable.', {
      retryable: true
    });
  } finally {
    clearTimeout(timer);
  }
  if (!result.ok) {
    throw rethrow(result.error);
  }
  return result.value;
}

/**
 * Options for {@link createDataClient}.
 */
export interface DataClientOptions {
  /**
   * Upper bound per call.
   */
  readonly timeoutMs?: number;
  /**
   * Receives transport failures for logging.
   */
  readonly onTransportError?: (error: unknown) => void;
}

/**
 * Wrap an envelope-returning port in its throwing form.
 *
 * @param target Factory for the module target (called per operation so each call pipelines).
 * @param timeoutMs Upper bound per call.
 * @param onError Transport failure sink.
 * @returns The throwing port.
 */
function unwrapPort<T extends object>(
  target: () => Enveloped<T>,
  timeoutMs: number,
  onError: (error: unknown) => void
): T {
  return new Proxy({} as T, {
    get(_object, property) {
      return (...args: unknown[]) =>
        unwrap(
          () => {
            // Call as a member expression. The module target is an `RpcPromise` (pipelined stub);
            // `Function.prototype.apply` would pass that stub as `this`, which workerd then tries —
            // and fails — to serialize as an argument.
            const port = target() as Record<
              PropertyKey,
              (...rest: unknown[]) => Promise<RpcResult<unknown>>
            >;
            return port[property as string]!(...args);
          },
          timeoutMs,
          onError
        );
    }
  });
}

/**
 * Build the throwing data service over the binding.
 *
 * @param rpc The `DATA_SERVICE` binding (or any {@link DataRpc}).
 * @param options Timeout and logging.
 * @returns The data service.
 */
export function createDataClient(rpc: DataRpc, options: DataClientOptions = {}): DataService {
  const timeoutMs = options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  const onError = options.onTransportError ?? (() => undefined);
  return {
    health: () => unwrap(() => rpc.health(), timeoutMs, onError),
    resolveActor: (email, requestId) =>
      unwrap(() => rpc.resolveActor(email, requestId), timeoutMs, onError),
    resolveUser: (userId) => unwrap(() => rpc.resolveUser(userId), timeoutMs, onError),
    authorize: (request) => unwrap(() => rpc.authorize(request), timeoutMs, onError),
    crm: unwrapPort<CrmPort>(() => rpc.crm(), timeoutMs, onError),
    projects: unwrapPort<ProjectsPort>(() => rpc.projects(), timeoutMs, onError),
    permissions: unwrapPort<PermissionsPort>(() => rpc.permissions(), timeoutMs, onError)
  };
}
