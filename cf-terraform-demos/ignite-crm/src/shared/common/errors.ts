/**
 * @file Serializable service errors that cross the Data Worker RPC boundary. Workers RPC rebuilds a
 *   thrown error on the caller's side as a plain `Error`, so `instanceof` checks against a subclass
 *   are meaningless after the hop. With the pinned compatibility date's enhanced error
 *   serialization, own properties (`code`, `retryable`, `requestId`, `fields`) do survive. Callers
 *   therefore recognise a service error by `name === 'ServiceError'` and branch on its stable
 *   `code`, never on its class or message (specification §2.12).
 */

/**
 * Every stable service error code.
 */
export const SERVICE_ERROR_CODES = [
  'VALIDATION_FAILED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'VERSION_MISMATCH',
  'IDEMPOTENCY_KEY_REUSED',
  'DEPENDENCY_FAILURE',
  'INTERNAL'
] as const;

/**
 * A stable service error code.
 */
export type ServiceErrorCode = (typeof SERVICE_ERROR_CODES)[number];

/**
 * The structured-cloneable shape of a service error.
 */
export interface ServiceErrorValue {
  /**
   * Always `ServiceError`; the discriminator callers test instead of `instanceof`.
   */
  readonly name: 'ServiceError';
  /**
   * Stable machine-readable failure code.
   */
  readonly code: ServiceErrorCode;
  /**
   * Safe, human-readable explanation. Never contains SQL, stack traces, or record content.
   */
  readonly message: string;
  /**
   * Whether repeating the same request later may succeed.
   */
  readonly retryable: boolean;
  /**
   * Request identifier for correlating logs and audit events.
   */
  readonly requestId: string;
  /**
   * Optional per-field validation messages keyed by input field name.
   */
  readonly fields?: Readonly<Record<string, string>>;
}

/**
 * Options for {@link serviceError}.
 */
export interface ServiceErrorOptions {
  /**
   * Request identifier to attach; defaults to `unknown` when not yet known.
   */
  readonly requestId?: string;
  /**
   * Overrides the code's default retryability.
   */
  readonly retryable?: boolean;
  /**
   * Per-field validation messages.
   */
  readonly fields?: Readonly<Record<string, string>>;
}

/**
 * Build a throwable service error.
 *
 * The result is an `Error` (so it carries a stack for local logging and satisfies lint rules about
 * throwing errors) whose own properties form a {@link ServiceErrorValue}.
 *
 * @param code Stable failure code.
 * @param message Safe explanation for the caller.
 * @param options Request identifier, retryability override, and field messages.
 * @returns The error, ready to throw.
 */
export function serviceError(
  code: ServiceErrorCode,
  message: string,
  options: ServiceErrorOptions = {}
): Error & ServiceErrorValue {
  const error = new Error(message) as Error & {
    -readonly [K in keyof ServiceErrorValue]: ServiceErrorValue[K];
  };
  error.name = 'ServiceError';
  error.code = code;
  error.retryable = options.retryable ?? code === 'DEPENDENCY_FAILURE';
  error.requestId = options.requestId ?? 'unknown';
  if (options.fields !== undefined) {
    error.fields = options.fields;
  }
  return error;
}

/**
 * Recognise a service error by its shape, including one rebuilt by RPC deserialization.
 *
 * @param value Anything that was thrown.
 * @returns Whether the value is a service error with a known code.
 */
export function isServiceError(value: unknown): value is Error & ServiceErrorValue {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<ServiceErrorValue>;
  return (
    candidate.name === 'ServiceError'
    && typeof candidate.code === 'string'
    && (SERVICE_ERROR_CODES as readonly string[]).includes(candidate.code)
  );
}
