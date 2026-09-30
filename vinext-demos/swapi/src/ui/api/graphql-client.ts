/**
 * @file The browser's single path to the GraphQL endpoint. Everything the explorer knows about
 *   talking to the API is here: how a request is shaped, and how the three interesting failures are
 *   told apart. No store or component calls `fetch` directly, so there is one place where error
 *   handling is decided and one place to change if the transport ever does.
 */

/**
 * Why a GraphQL request failed.
 *
 * The distinction exists because UISPEC §9.4 requires three visibly different outcomes, and a
 * component cannot tell them apart from an error message alone.
 */
export type GraphQLErrorKind =
  /**
   * The Cloudflare Access session is no longer valid. Not a data error: the user needs to sign in
   * again, and the UI must offer that rather than a retry (UISPEC §10).
   */
  | 'unauthenticated'
  /**
   * The request did not complete — offline, DNS, a dropped connection. Worth retrying.
   */
  | 'network'
  /**
   * The server answered, but with errors or an unusable body. Retrying may help if it was
   * transient, so the UI offers it, but the cause is server-side.
   */
  | 'server';

/**
 * A failed GraphQL request, carrying enough for the UI to respond appropriately.
 */
export class GraphQLRequestError extends Error {
  /**
   * Which of the three failure modes this was.
   */
  readonly kind: GraphQLErrorKind;

  /**
   * @param kind Failure mode, determining how the UI should present and recover from this.
   * @param message Message safe to show a user. Never a stack trace or a GraphQL error path: UISPEC
   *   §9.4 requires the UI to be useful with only a generic message, which it must be anyway
   *   because a deployed Worker masks unexpected error detail server-side.
   */
  constructor(kind: GraphQLErrorKind, message: string) {
    super(message);
    this.name = 'GraphQLRequestError';
    this.kind = kind;
  }
}

/**
 * Shape of a GraphQL response body.
 *
 * @typeParam Data Expected shape of the `data` field.
 */
interface GraphQLResponseBody<Data> {
  /**
   * Result of the operation, absent when execution failed outright.
   */
  data?: Data;
  /**
   * Errors raised during validation or execution.
   */
  errors?: readonly { message: string }[];
}

/**
 * Endpoint the explorer talks to.
 *
 * The same path GraphiQL uses. The Access policy for it sets `redirect: false`, so an expired
 * session produces a `401` this client can recognise rather than the HTML of a login page arriving
 * where JSON was expected (see `src/access-policies.ts`).
 */
const GRAPHQL_ENDPOINT = '/graphql';

/**
 * Execute one GraphQL operation.
 *
 * Deliberately has no batching, retry, or caching behaviour of its own. Caching belongs to the
 * catalog store (`../state/catalog-store.ts`), which knows the data is immutable for a session;
 * retrying belongs to the UI, which knows whether a human is waiting. This function does one thing
 * so those policies are visible where they are decided rather than buried in a transport layer.
 *
 * @typeParam Data Expected shape of the operation's result.
 * @param query GraphQL document to execute.
 * @param variables Variables for the operation. Always sent as variables rather than interpolated
 *   into the document, so a search term containing GraphQL syntax cannot alter the operation.
 * @param signal Optional abort signal, used to cancel a superseded search.
 * @returns The operation's `data`.
 * @throws {GraphQLRequestError} With kind `unauthenticated` when the Access session has expired,
 *   `network` when the request never completed, and `server` when the response carried errors, was
 *   not valid JSON, or contained no data.
 * @throws {DOMException} When `signal` is aborted. Propagated unchanged rather than wrapped,
 *   because an abort is the caller's own doing and must be distinguishable from a real failure —
 *   showing "request failed" for a search the user superseded by typing another character would be
 *   actively misleading.
 */
export async function executeGraphQL<Data>(
  query: string,
  variables: Readonly<Record<string, unknown>> = {},
  signal?: AbortSignal
): Promise<Data> {
  let response: Response;
  try {
    response = await fetch(GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal
    });
  } catch (cause) {
    // An abort is not a failure to report; let it through untouched for the caller to ignore.
    if (cause instanceof DOMException && cause.name === 'AbortError') {
      throw cause;
    }
    throw new GraphQLRequestError('network', 'Could not reach the server. Check your connection.');
  }

  if (response.status === 401 || response.status === 403) {
    throw new GraphQLRequestError('unauthenticated', 'Your session has expired.');
  }

  let body: GraphQLResponseBody<Data>;
  try {
    body = (await response.json()) as GraphQLResponseBody<Data>;
  } catch {
    throw new GraphQLRequestError('server', 'The server returned an unreadable response.');
  }

  // A GraphQL endpoint answers 200 even for errors, so the status alone proves nothing; the
  // `errors` array is the real signal and has to be checked on every response.
  if (body.errors !== undefined && body.errors.length > 0) {
    throw new GraphQLRequestError('server', 'The server could not complete that request.');
  }

  if (body.data === undefined || body.data === null) {
    throw new GraphQLRequestError('server', 'The server returned no data.');
  }

  return body.data;
}
