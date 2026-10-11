/**
 * @file The SPA's only `fetch` caller: a typed same-origin client for the Application Worker API.
 *   Every response is validated against its shared Valibot schema before it reaches UI state, so a
 *   malformed or unexpected server body becomes an {@link ApiError} instead of a silent rendering
 *   bug. Failures are parsed as RFC 9457 problem details.
 */

import * as v from 'valibot';
import { DisplayConfigurationSchema } from '../../shared/api/configuration.ts';
import {
  CompanyDetailSchema,
  CompanyPageSchema,
  type CreateContactInput,
  ContactDetailSchema,
  ContactPageSchema,
  ContactSchema,
  DashboardSchema
} from '../../shared/api/crm.ts';
import { type Problem, ProblemSchema } from '../../shared/api/problems.ts';
import { SessionSchema } from '../../shared/api/session.ts';

/**
 * Failure kinds the UI distinguishes.
 */
export type ApiErrorKind =
  | 'unauthenticated'
  | 'forbidden'
  | 'not-found'
  | 'validation'
  | 'conflict'
  | 'unavailable'
  | 'malformed'
  | 'network'
  | 'server';

/**
 * A failed API call.
 */
export class ApiError extends Error {
  /**
   * @param kind What kind of failure.
   * @param message Safe message for display.
   * @param status HTTP status, or 0 for network/malformed failures.
   * @param problem The parsed problem details, when the server sent them.
   */
  constructor(
    readonly kind: ApiErrorKind,
    message: string,
    readonly status: number,
    readonly problem?: Problem
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /**
   * Per-field validation messages, if any.
   *
   * @returns Messages keyed by field name.
   */
  get fields(): Readonly<Record<string, string>> {
    return this.problem?.fields ?? {};
  }

  /**
   * Request identifier for support, if the server sent one.
   *
   * @returns The id, or `undefined`.
   */
  get requestId(): string | undefined {
    return this.problem?.requestId;
  }
}

/**
 * Classify a status code.
 *
 * @param status HTTP status.
 * @returns The failure kind.
 */
function kindFor(status: number): ApiErrorKind {
  switch (status) {
    case 401:
      return 'unauthenticated';
    case 403:
      return 'forbidden';
    case 404:
      return 'not-found';
    case 400:
    case 422:
    case 428:
      return 'validation';
    case 409:
      return 'conflict';
    case 503:
      return 'unavailable';
    default:
      return 'server';
  }
}

/**
 * Generate a fresh idempotency key for one user intent.
 *
 * @returns The key.
 */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

/**
 * Options for one request.
 */
interface RequestOptions {
  /**
   * HTTP method.
   */
  readonly method?: 'GET' | 'POST' | 'PATCH';
  /**
   * JSON body.
   */
  readonly body?: unknown;
  /**
   * Extra headers.
   */
  readonly headers?: Record<string, string>;
  /**
   * Cancellation.
   */
  readonly signal?: AbortSignal;
}

/**
 * The fetch function used by the client (injectable for tests).
 */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Typed API client.
 */
export class ApiClient {
  /**
   * @param fetcher Fetch implementation; defaults to the global `fetch`.
   */
  constructor(private readonly fetcher: FetchLike = (input, init) => fetch(input, init)) {}

  /**
   * Perform a request and validate the response.
   *
   * @param path Same-origin path.
   * @param schema Schema the success body must satisfy.
   * @param options Method, body, headers, signal.
   * @returns The validated body.
   * @throws {ApiError} For any HTTP, network, or validation failure.
   */
  async request<TSchema extends v.GenericSchema>(
    path: string,
    schema: TSchema,
    options: RequestOptions = {}
  ): Promise<v.InferOutput<TSchema>> {
    const headers: Record<string, string> = { Accept: 'application/json', ...options.headers };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    let response: Response;
    try {
      response = await this.fetcher(path, {
        method: options.method ?? 'GET',
        headers,
        credentials: 'same-origin',
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        ...(options.signal === undefined ? {} : { signal: options.signal })
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }
      throw new ApiError(
        'network',
        'Could not reach the server. Check your connection and try again.',
        0
      );
    }
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const problem = v.safeParse(ProblemSchema, body);
      throw new ApiError(
        kindFor(response.status),
        problem.success
          ? (problem.output.detail ?? problem.output.title)
          : `Request failed (${response.status}).`,
        response.status,
        problem.success ? problem.output : undefined
      );
    }
    const parsed = v.safeParse(schema, body);
    if (!parsed.success) {
      throw new ApiError('malformed', 'The server sent an unexpected response.', response.status);
    }
    return parsed.output;
  }

  /**
   * The signed-in session.
   *
   * @returns The session.
   * @throws {ApiError} On failure.
   */
  session() {
    return this.request('/api/v1/session', SessionSchema);
  }

  /**
   * Display configuration.
   *
   * @returns The configuration.
   * @throws {ApiError} On failure.
   */
  configuration() {
    return this.request('/api/v1/configuration', DisplayConfigurationSchema);
  }

  /**
   * Dashboard counts.
   *
   * @param signal Cancellation.
   * @returns The dashboard.
   * @throws {ApiError} On failure.
   */
  dashboard(signal?: AbortSignal) {
    return this.request(
      '/api/v1/dashboard',
      DashboardSchema,
      signal === undefined ? {} : { signal }
    );
  }

  /**
   * List or search contacts.
   *
   * @param query Search term and cursor.
   * @param signal Cancellation.
   * @returns One page.
   * @throws {ApiError} On failure.
   */
  contacts(query: { q?: string; cursor?: string }, signal?: AbortSignal) {
    return this.request(
      `/api/v1/contacts${toQuery(query)}`,
      ContactPageSchema,
      signal === undefined ? {} : { signal }
    );
  }

  /**
   * List or search companies.
   *
   * @param query Search term and cursor.
   * @param signal Cancellation.
   * @returns One page.
   * @throws {ApiError} On failure.
   */
  companies(query: { q?: string; cursor?: string }, signal?: AbortSignal) {
    return this.request(
      `/api/v1/companies${toQuery(query)}`,
      CompanyPageSchema,
      signal === undefined ? {} : { signal }
    );
  }

  /**
   * One contact.
   *
   * @param id Contact id.
   * @param signal Cancellation.
   * @returns The detail.
   * @throws {ApiError} On failure.
   */
  contact(id: string, signal?: AbortSignal) {
    return this.request(
      `/api/v1/contacts/${encodeURIComponent(id)}`,
      ContactDetailSchema,
      signal === undefined ? {} : { signal }
    );
  }

  /**
   * One company.
   *
   * @param id Company id.
   * @param signal Cancellation.
   * @returns The detail.
   * @throws {ApiError} On failure.
   */
  company(id: string, signal?: AbortSignal) {
    return this.request(
      `/api/v1/companies/${encodeURIComponent(id)}`,
      CompanyDetailSchema,
      signal === undefined ? {} : { signal }
    );
  }

  /**
   * Create a contact.
   *
   * @param input Contact fields (pre-normalisation; the server applies the shared schema).
   * @param idempotencyKey Key for this user intent; reuse it when retrying the same submission.
   * @returns The created contact.
   * @throws {ApiError} On failure.
   */
  createContact(input: Partial<CreateContactInput>, idempotencyKey: string) {
    return this.request('/api/v1/contacts', ContactSchema, {
      method: 'POST',
      body: input,
      headers: { 'Idempotency-Key': idempotencyKey }
    });
  }
}

/**
 * Build a query string from defined values.
 *
 * @param query Parameters.
 * @returns `?a=b` or the empty string.
 */
function toQuery(query: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') {
      params.set(key, value);
    }
  }
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

/**
 * The application-wide client.
 */
export const api = new ApiClient();
