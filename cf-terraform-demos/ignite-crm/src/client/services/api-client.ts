/**
 * @file The SPA's only `fetch` caller: a typed same-origin client for the Application Worker API.
 *   Every response is validated against its shared Valibot schema before it reaches UI state, so a
 *   malformed or unexpected server body becomes an {@link ApiError} instead of a silent rendering
 *   bug. Failures are parsed as RFC 9457 problem details.
 */

import * as v from 'valibot';
import { AuditPageSchema, type AuditListQuery } from '../../shared/api/audit.ts';
import { DisplayConfigurationSchema } from '../../shared/api/configuration.ts';
import {
  CompanyPageSchema,
  type CreateContactInput,
  ContactPageSchema,
  ContactSchema,
  DashboardSchema
} from '../../shared/api/crm.ts';
import { UserRefSchema } from '../../shared/api/crm.ts';
import { CompanyDetailSchema, ContactDetailSchema } from '../../shared/api/customer.ts';
import {
  type CreateNoteInput,
  NoteDetailSchema,
  type NoteLinkType,
  NotePageSchema,
  NoteSchema,
  NoteSearchResultSchema,
  type UpdateNoteInput
} from '../../shared/api/notes.ts';
import { type Problem, ProblemSchema } from '../../shared/api/problems.ts';
import {
  type ConvertDealRequest,
  type CreateTaskInput,
  MyWorkSchema,
  ProjectDetailSchema,
  ProjectPageSchema,
  ProjectSchema,
  type ProjectStatus,
  TaskSchema,
  type UpdateProjectInput,
  type UpdateTaskInput
} from '../../shared/api/projects.ts';
import {
  ActionStreamSchema,
  ActivitySchema,
  ContactNextActionSchema,
  type CreateActivityInput,
  type CreateDealInput,
  DealDetailSchema,
  DealPageSchema,
  DealSchema,
  type DealStatus,
  PipelineSchema,
  PipelineSummarySchema,
  type SetNextActionInput,
  type UpdateDealInput
} from '../../shared/api/sales.ts';
import { SessionSchema } from '../../shared/api/session.ts';
import {
  type InviteUserInput,
  RoleCatalogueSchema,
  type SetUserRolesInput,
  type SetUserStatusInput,
  TeamMemberSchema,
  TeamPageSchema
} from '../../shared/api/team.ts';

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
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'PUT';
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

  /**
   * The sales pipeline.
   *
   * @param signal Cancellation.
   * @returns The pipeline and its stages.
   * @throws {ApiError} On failure.
   */
  pipeline(signal?: AbortSignal) {
    return this.request('/api/v1/pipeline', PipelineSchema, signal === undefined ? {} : { signal });
  }

  /**
   * Users a deal may be assigned to.
   *
   * @param signal Cancellation.
   * @returns User references.
   * @throws {ApiError} On failure.
   */
  assignees(signal?: AbortSignal) {
    return this.request(
      '/api/v1/assignees',
      v.array(UserRefSchema),
      signal === undefined ? {} : { signal }
    );
  }

  /**
   * List or search deals.
   *
   * @param query Search term, status filter, page size, and cursor.
   * @param signal Cancellation.
   * @returns One page.
   * @throws {ApiError} On failure.
   */
  deals(
    query: { q?: string; status?: DealStatus; limit?: number; cursor?: string },
    signal?: AbortSignal
  ) {
    return this.request(
      `/api/v1/deals${toQuery({ ...query, limit: query.limit?.toString() })}`,
      DealPageSchema,
      signal === undefined ? {} : { signal }
    );
  }

  /**
   * One deal with its activities and history.
   *
   * @param id Deal id.
   * @param signal Cancellation.
   * @returns The detail.
   * @throws {ApiError} On failure.
   */
  deal(id: string, signal?: AbortSignal) {
    return this.request(
      `/api/v1/deals/${encodeURIComponent(id)}`,
      DealDetailSchema,
      signal === undefined ? {} : { signal }
    );
  }

  /**
   * Create a deal.
   *
   * @param input Deal fields.
   * @param idempotencyKey Key for this user intent.
   * @returns The created deal.
   * @throws {ApiError} On failure.
   */
  createDeal(input: Partial<CreateDealInput>, idempotencyKey: string) {
    return this.request('/api/v1/deals', DealSchema, {
      method: 'POST',
      body: input,
      headers: { 'Idempotency-Key': idempotencyKey }
    });
  }

  /**
   * Update a deal.
   *
   * @param id Deal id.
   * @param input Fields to change.
   * @param version Version last read; a stale one fails with a `conflict` error.
   * @param idempotencyKey Key for this user intent.
   * @returns The updated deal.
   * @throws {ApiError} On failure.
   */
  updateDeal(id: string, input: UpdateDealInput, version: number, idempotencyKey: string) {
    return this.request(`/api/v1/deals/${encodeURIComponent(id)}`, DealSchema, {
      method: 'PATCH',
      body: input,
      headers: { 'Idempotency-Key': idempotencyKey, 'If-Match': `"${version}"` }
    });
  }

  /**
   * Log a call or meeting.
   *
   * @param input Activity fields.
   * @param idempotencyKey Key for this user intent.
   * @returns The activity.
   * @throws {ApiError} On failure.
   */
  createActivity(input: CreateActivityInput, idempotencyKey: string) {
    return this.request('/api/v1/activities', ActivitySchema, {
      method: 'POST',
      body: input,
      headers: { 'Idempotency-Key': idempotencyKey }
    });
  }

  /**
   * Set or replace a contact's next action.
   *
   * @param contactId Contact id.
   * @param input The action.
   * @param version Version of the action being replaced, or `null` to create one.
   * @param idempotencyKey Key for this user intent.
   * @returns The action.
   * @throws {ApiError} On failure.
   */
  setNextAction(
    contactId: string,
    input: SetNextActionInput,
    version: number | null,
    idempotencyKey: string
  ) {
    return this.request(
      `/api/v1/contacts/${encodeURIComponent(contactId)}/next-action`,
      ContactNextActionSchema,
      {
        method: 'PUT',
        body: input,
        headers: {
          'Idempotency-Key': idempotencyKey,
          ...(version === null ? {} : { 'If-Match': `"${version}"` })
        }
      }
    );
  }

  /**
   * Mark a contact's next action done.
   *
   * @param contactId Contact id.
   * @param version Version of the open action.
   * @param idempotencyKey Key for this user intent.
   * @returns The completed action.
   * @throws {ApiError} On failure.
   */
  completeNextAction(contactId: string, version: number, idempotencyKey: string) {
    return this.request(
      `/api/v1/contacts/${encodeURIComponent(contactId)}/next-action/complete`,
      ContactNextActionSchema,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey, 'If-Match': `"${version}"` }
      }
    );
  }

  /**
   * The signed-in user's prioritized follow-ups.
   *
   * @param signal Cancellation.
   * @returns The action stream.
   * @throws {ApiError} On failure.
   */
  actionStream(signal?: AbortSignal) {
    return this.request(
      '/api/v1/action-stream',
      ActionStreamSchema,
      signal === undefined ? {} : { signal }
    );
  }

  /**
   * Convert a won deal into a linked project.
   *
   * @param dealId Deal id.
   * @param input Optional name, lead, and target date.
   * @param version Deal version last read; a stale one fails with a `conflict` error.
   * @param idempotencyKey Key for this user intent.
   * @returns The new project.
   * @throws {ApiError} On failure (`conflict` when already converted or no longer won).
   */
  convertDeal(dealId: string, input: ConvertDealRequest, version: number, idempotencyKey: string) {
    return this.request(`/api/v1/deals/${encodeURIComponent(dealId)}/convert`, ProjectSchema, {
      method: 'POST',
      body: input,
      headers: { 'Idempotency-Key': idempotencyKey, 'If-Match': `"${version}"` }
    });
  }

  /**
   * List or search projects.
   *
   * @param query Search term, status filter, page size, and cursor.
   * @param signal Cancellation.
   * @returns One page.
   * @throws {ApiError} On failure.
   */
  projects(
    query: { q?: string; status?: ProjectStatus; limit?: number; cursor?: string },
    signal?: AbortSignal
  ) {
    return this.request(
      `/api/v1/projects${toQuery({ ...query, limit: query.limit?.toString() })}`,
      ProjectPageSchema,
      signal === undefined ? {} : { signal }
    );
  }

  /**
   * One project with its tasks and history.
   *
   * @param id Project id.
   * @param signal Cancellation.
   * @returns The detail.
   * @throws {ApiError} On failure.
   */
  project(id: string, signal?: AbortSignal) {
    return this.request(
      `/api/v1/projects/${encodeURIComponent(id)}`,
      ProjectDetailSchema,
      signal === undefined ? {} : { signal }
    );
  }

  /**
   * Update a project.
   *
   * @param id Project id.
   * @param input Fields to change.
   * @param version Version last read.
   * @param idempotencyKey Key for this user intent.
   * @returns The updated project.
   * @throws {ApiError} On failure.
   */
  updateProject(id: string, input: UpdateProjectInput, version: number, idempotencyKey: string) {
    return this.request(`/api/v1/projects/${encodeURIComponent(id)}`, ProjectSchema, {
      method: 'PATCH',
      body: input,
      headers: { 'Idempotency-Key': idempotencyKey, 'If-Match': `"${version}"` }
    });
  }

  /**
   * Add a task to a project.
   *
   * @param projectId Project id.
   * @param input Task fields.
   * @param idempotencyKey Key for this user intent.
   * @returns The task.
   * @throws {ApiError} On failure.
   */
  createTask(projectId: string, input: Partial<CreateTaskInput>, idempotencyKey: string) {
    return this.request(`/api/v1/projects/${encodeURIComponent(projectId)}/tasks`, TaskSchema, {
      method: 'POST',
      body: input,
      headers: { 'Idempotency-Key': idempotencyKey }
    });
  }

  /**
   * Update (or move) a task.
   *
   * @param id Task id.
   * @param input Fields to change.
   * @param version Version last read.
   * @param idempotencyKey Key for this user intent.
   * @returns The updated task.
   * @throws {ApiError} On failure.
   */
  updateTask(id: string, input: UpdateTaskInput, version: number, idempotencyKey: string) {
    return this.request(`/api/v1/tasks/${encodeURIComponent(id)}`, TaskSchema, {
      method: 'PATCH',
      body: input,
      headers: { 'Idempotency-Key': idempotencyKey, 'If-Match': `"${version}"` }
    });
  }

  /**
   * The signed-in user's open assigned tasks.
   *
   * @param signal Cancellation.
   * @returns The worklist.
   * @throws {ApiError} On failure.
   */
  myWork(signal?: AbortSignal) {
    return this.request('/api/v1/my-work', MyWorkSchema, signal === undefined ? {} : { signal });
  }

  /**
   * The fixed role catalogue.
   *
   * @param signal Cancellation.
   * @returns Every role with its permissions.
   * @throws {ApiError} On failure (`forbidden` without `users.read`).
   */
  roles(signal?: AbortSignal) {
    return this.request(
      '/api/v1/roles',
      RoleCatalogueSchema,
      signal === undefined ? {} : { signal }
    );
  }

  /**
   * The team directory.
   *
   * @param query Search and cursor.
   * @param signal Cancellation.
   * @returns One page, ordered by display name.
   * @throws {ApiError} On failure.
   */
  team(query: { q?: string; cursor?: string }, signal?: AbortSignal) {
    return this.request(
      `/api/v1/users${toQuery(query)}`,
      TeamPageSchema,
      signal === undefined ? {} : { signal }
    );
  }

  /**
   * Add a teammate (owner only).
   *
   * @param input E-mail, display name, and roles.
   * @param idempotencyKey Key for this user intent.
   * @returns The new member.
   * @throws {ApiError} On failure.
   */
  inviteUser(input: InviteUserInput, idempotencyKey: string) {
    return this.request('/api/v1/users', TeamMemberSchema, {
      method: 'POST',
      body: input,
      headers: { 'Idempotency-Key': idempotencyKey }
    });
  }

  /**
   * Replace a teammate's roles (owner only).
   *
   * @param id User id.
   * @param input The new role set.
   * @param version Version last read.
   * @param idempotencyKey Key for this user intent.
   * @returns The updated member.
   * @throws {ApiError} On failure.
   */
  setUserRoles(id: string, input: SetUserRolesInput, version: number, idempotencyKey: string) {
    return this.request(`/api/v1/users/${encodeURIComponent(id)}/roles`, TeamMemberSchema, {
      method: 'PUT',
      body: input,
      headers: { 'Idempotency-Key': idempotencyKey, 'If-Match': `"${version}"` }
    });
  }

  /**
   * Suspend or reactivate a teammate (owner only).
   *
   * @param id User id.
   * @param input The new status.
   * @param version Version last read.
   * @param idempotencyKey Key for this user intent.
   * @returns The updated member.
   * @throws {ApiError} On failure.
   */
  setUserStatus(id: string, input: SetUserStatusInput, version: number, idempotencyKey: string) {
    return this.request(`/api/v1/users/${encodeURIComponent(id)}/status`, TeamMemberSchema, {
      method: 'PUT',
      body: input,
      headers: { 'Idempotency-Key': idempotencyKey, 'If-Match': `"${version}"` }
    });
  }

  /**
   * The audit trail.
   *
   * @param query Filters and cursor.
   * @param signal Cancellation.
   * @returns One page, newest first.
   * @throws {ApiError} On failure (`forbidden` without `audit.read`).
   */
  audit(query: Omit<AuditListQuery, 'limit'>, signal?: AbortSignal) {
    return this.request(
      `/api/v1/audit${toQuery(query)}`,
      AuditPageSchema,
      signal === undefined ? {} : { signal }
    );
  }

  /**
   * List notes, newest first, optionally only those linked to one record.
   *
   * @param query Linked record and cursor.
   * @param signal Cancellation.
   * @returns One page.
   * @throws {ApiError} On failure.
   */
  notes(
    query: { linkType?: NoteLinkType; linkId?: string; cursor?: string },
    signal?: AbortSignal
  ) {
    return this.request(
      `/api/v1/notes${toQuery(query)}`,
      NotePageSchema,
      signal === undefined ? {} : { signal }
    );
  }

  /**
   * One note with its links and history.
   *
   * @param id Note id.
   * @param signal Cancellation.
   * @returns The detail.
   * @throws {ApiError} On failure.
   */
  note(id: string, signal?: AbortSignal) {
    return this.request(
      `/api/v1/notes/${encodeURIComponent(id)}`,
      NoteDetailSchema,
      signal === undefined ? {} : { signal }
    );
  }

  /**
   * Full-text search. The text travels in a POST body, never the URL, so it stays out of history
   * and logs.
   *
   * @param q Search text (2–200 characters).
   * @param signal Cancellation.
   * @returns At most 50 hits, best first.
   * @throws {ApiError} On failure.
   */
  searchNotes(q: string, signal?: AbortSignal) {
    return this.request('/api/v1/notes/search', NoteSearchResultSchema, {
      method: 'POST',
      body: { q },
      ...(signal === undefined ? {} : { signal })
    });
  }

  /**
   * Create a note linked to one or more records.
   *
   * @param input Title, Markdown, and links.
   * @param idempotencyKey Key for this user intent.
   * @returns The note.
   * @throws {ApiError} On failure.
   */
  createNote(input: CreateNoteInput, idempotencyKey: string) {
    return this.request('/api/v1/notes', NoteSchema, {
      method: 'POST',
      body: input,
      headers: { 'Idempotency-Key': idempotencyKey }
    });
  }

  /**
   * Update a note's text and/or replace its links.
   *
   * @param id Note id.
   * @param input Fields to change.
   * @param version Version last read.
   * @param idempotencyKey Key for this user intent.
   * @returns The updated note.
   * @throws {ApiError} On failure.
   */
  updateNote(id: string, input: UpdateNoteInput, version: number, idempotencyKey: string) {
    return this.request(`/api/v1/notes/${encodeURIComponent(id)}`, NoteSchema, {
      method: 'PATCH',
      body: input,
      headers: { 'Idempotency-Key': idempotencyKey, 'If-Match': `"${version}"` }
    });
  }

  /**
   * Pipeline totals by stage and outcome.
   *
   * @param signal Cancellation.
   * @returns The summary.
   * @throws {ApiError} On failure.
   */
  pipelineSummary(signal?: AbortSignal) {
    return this.request(
      '/api/v1/reports/pipeline',
      PipelineSummarySchema,
      signal === undefined ? {} : { signal }
    );
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
