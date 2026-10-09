import { Hono } from 'hono';
import {
  currentIdentityEmail,
  jsonBodyLimit,
  readJsonBody,
  upgradeRequired
} from '@demos/worker-common';
import type { AppBindings } from '../bindings.ts';
import type { LogVia } from '../logging.ts';

/**
 * Transport recorded on every structured log event this router emits.
 *
 * The same field the MCP tools set to `'mcp'` (`../mcp/tools.ts`), so one Workers Logs query
 * separates a person clicking a button from their own agent calling a tool. Both surfaces reach the
 * identical use cases, so without this field the two are indistinguishable in observability.
 */
const VIA: LogVia = 'api';

/**
 * Largest accepted JSON body on this router, in bytes.
 *
 * Deliberately far above `@demos/worker-common`'s 8 KiB default, and explicit about why: a graph
 * save carries every node's position, label and annotation plus every edge, so a large, richly
 * described architecture legitimately runs to tens of kilobytes. 512 KiB covers that with room to
 * spare while still bounding the worst case, so a client cannot stream an unbounded body into a
 * `JSON.parse`.
 */
const MAX_DIAGRAM_BODY_BYTES = 512 * 1_024;

/**
 * The diagram API, mounted at `/api/diagrams`.
 *
 * Most of it is owner-scoped. Three endpoints are deliberately not, and they are the ones
 * collaboration consists of: reading a diagram, replacing its graph, and opening its live session
 * all admit an identity the owner has granted edit access to. Everything that decides what the
 * diagram _is_ or who may reach it — rename, delete, duplicate, the share link, and the
 * collaborator list itself — stays owner-only. The services own that distinction; no handler here
 * takes an authorization decision of its own.
 *
 * The handlers are deliberately thin enough to read as a description of the API surface. Each one
 * does exactly three things: take the verified identity, hand the request's untrusted values to
 * {@link DiagramService}, and shape the result as HTTP. No handler validates a payload, decides
 * whether the caller may see a diagram, or constructs a repository — those belong to the
 * application tier and the composition root respectively, which is what keeps the MCP tool layer in
 * a later phase able to reach the same use cases without going through HTTP at all.
 *
 * The identity always comes from `currentIdentityEmail`, which reads the validated Access JWT.
 * Nothing here accepts an owner from a path parameter, a query string, a header or a body.
 *
 * Every refusal is a `404`, never a `403`: a diagram that exists but the caller may not reach is
 * reported identically to one that does not exist, so a caller can never confirm that a guessed id
 * is real. That holds for a collaborator attempting an owner-only action too — they can already see
 * the diagram, so the status discloses nothing either way, and giving every refusal one shape is
 * what stops a `403` appearing somewhere it would be a signal. The services own that rule; this
 * router simply never adds a status of its own.
 *
 * The two refusals that are **not** uniform are both cases where the caller already knows
 * everything the message could disclose: adding your own address as a collaborator, and naming an
 * identity that has never signed in. Each says what is actually wrong, because a `404` there would
 * send somebody looking for a diagram that is open in front of them.
 *
 * @returns A Hono router serving the owner-scoped diagram endpoints.
 */
export function createDiagramsRouter(): Hono<AppBindings> {
  const router = new Hono<AppBindings>();

  // Mounted on the router rather than per route, so an endpoint added later is bounded by
  // construction. It is a no-op for a request with no body, so the reads below are unaffected.
  router.use(jsonBodyLimit(MAX_DIAGRAM_BODY_BYTES));

  /**
   * Lists the signed-in identity's own diagrams, most recently updated first.
   *
   * @param context Hono request context carrying the verified identity and the diagram service.
   * @returns A `200` response carrying the caller's diagrams, each with its full graph so the
   *   dashboard can render a real thumbnail without a second request per card.
   * @throws {NullError} When mounted without the Access middleware in front of it.
   * @throws {Error} When the repository cannot read the rows.
   */
  router.get('/', async (context) =>
    context.json({
      diagrams: await context.var.DIAGRAM_SERVICE.list(currentIdentityEmail(context))
    })
  );

  /**
   * Lists the diagrams somebody else owns and has granted the caller edit access to.
   *
   * A separate endpoint rather than a `?scope=` parameter on the route above, deliberately. That
   * route's contract — "the signed-in identity's own diagrams" — is what the MCP `list_diagrams`
   * tool documents and relies on, so changing its shape would be a breaking change to the agent
   * surface for no benefit to the dashboard, which wants both lists on screen at once anyway.
   *
   * Registered **before** `/:id`, and it has to be: Hono matches in registration order, so a
   * literal path registered after a single-segment parameter would be captured by it and answered
   * as a diagram id — producing the `404` a malformed id gets, from a route that exists.
   *
   * @param context Hono request context carrying the verified identity and the collaborator
   *   service.
   * @returns A `200` response carrying the shared diagrams, each with its owner's email so the
   *   dashboard can say who shared it, and its full graph so a card renders a real thumbnail.
   * @throws {NullError} When mounted without the Access middleware in front of it.
   * @throws {Error} When the repository cannot read the rows.
   */
  router.get('/shared-with-me', async (context) =>
    context.json({
      diagrams: await context.var.COLLABORATOR_SERVICE.listSharedWithMe(
        currentIdentityEmail(context)
      )
    })
  );

  /**
   * Creates a diagram, blank or seeded from a blueprint named in the body.
   *
   * @param context Hono request context carrying the verified identity, the bounded JSON body and
   *   the diagram service.
   * @returns A `201` response carrying the new diagram, which the client uses to navigate straight
   *   into its editor.
   * @throws {ProblemDetailsError} `400` when the body is not valid JSON or not an object, `422`
   *   when a field is invalid, and `404` when it names a blueprint that does not exist.
   * @throws {NullError} When mounted without the Access middleware in front of it.
   * @throws {Error} When the repository cannot write the row.
   */
  router.post('/', async (context) => {
    const diagram = await context.var.DIAGRAM_SERVICE.create(
      currentIdentityEmail(context),
      await readJsonBody(context.req.raw)
    );

    // The id, not the title or the graph: a log line should be enough to correlate a request
    // without becoming a copy of the user's content.
    context.var.LOGGER.info('diagram_created', { diagramId: diagram.id, via: VIA });
    return context.json({ diagram }, 201);
  });

  /**
   * Reads one diagram the signed-in identity owns or collaborates on.
   *
   * One of the three endpoints held to the widened rule. The response carries the caller's `role`
   * alongside the diagram, which is what lets the editor decide whether to offer the owner-only
   * controls — renaming, deleting, the share link, managing collaborators. That is presentational
   * only: every one of those routes re-derives the rule server-side, so a client that ignored the
   * field and rendered the controls anyway would simply receive `404`s.
   *
   * @param context Hono request context carrying the verified identity, the untrusted `id` path
   *   parameter and the diagram service.
   * @returns A `200` response carrying the diagram and the caller's role on it.
   * @throws {ProblemDetailsError} `404` when the id is malformed, unknown, or the caller neither
   *   owns the diagram nor collaborates on it — all three reported identically.
   * @throws {NullError} When mounted without the Access middleware in front of it.
   * @throws {Error} When a repository cannot read its rows.
   */
  router.get('/:id', async (context) => {
    const id = context.req.param('id');
    const { diagram, role } = await context.var.DIAGRAM_SERVICE.getAccessible(
      currentIdentityEmail(context),
      id
    );

    // An id, the operation and the role are enough to correlate a request and tell an owner's own
    // read apart from a collaborator's. The graph, title and verified identity are user content
    // and do not belong in an operational log.
    context.var.LOGGER.info('diagram_opened', { diagramId: diagram.id, role, via: VIA });
    return context.json({ diagram, role });
  });

  /**
   * Renames one of the signed-in identity's own diagrams and/or changes its description.
   *
   * @param context Hono request context carrying the verified identity, the untrusted `id` path
   *   parameter, the bounded JSON body and the diagram service.
   * @returns A `200` response carrying the updated diagram.
   * @throws {ProblemDetailsError} `400`/`422` when the body is invalid or carries neither field,
   *   and `404` when the diagram is malformed, unknown or foreign.
   * @throws {NullError} When mounted without the Access middleware in front of it.
   * @throws {Error} When the repository cannot read or write the row.
   */
  router.patch('/:id', async (context) => {
    const diagram = await context.var.DIAGRAM_SERVICE.updateMetadata(
      currentIdentityEmail(context),
      context.req.param('id'),
      await readJsonBody(context.req.raw)
    );

    context.var.LOGGER.info('diagram_updated', {
      diagramId: diagram.id,
      kind: 'metadata',
      via: VIA
    });
    return context.json({ diagram });
  });

  /**
   * Replaces one of the signed-in identity's own diagrams' graph — the editor's autosave target.
   *
   * `PUT` rather than `PATCH` because the client always sends the complete graph: there is no
   * partial-patch protocol, and naming the method after the semantics it actually has keeps a
   * future reader from looking for one.
   *
   * @param context Hono request context carrying the verified identity, the untrusted `id` path
   *   parameter, the bounded JSON body and the diagram service.
   * @returns A `200` response carrying the new `updatedAt` timestamp, which the editor shows as its
   *   save state.
   * @throws {ProblemDetailsError} `400`/`422` when the body or the decoded graph is invalid, and
   *   `404` when the diagram is malformed, unknown or foreign.
   * @throws {NullError} When mounted without the Access middleware in front of it.
   * @throws {Error} When the repository cannot read or write the row.
   */
  router.put('/:id/graph', async (context) => {
    const id = context.req.param('id');
    const updatedAt = await context.var.DIAGRAM_SERVICE.saveGraph(
      currentIdentityEmail(context),
      id,
      await readJsonBody(context.req.raw)
    );

    context.var.LOGGER.info('diagram_updated', { diagramId: id, kind: 'graph', via: VIA });
    return context.json({ updatedAt });
  });

  /**
   * Opens the editor's live connection to one of the signed-in identity's own diagrams.
   *
   * The route lives under `/api/` deliberately rather than needing a path of its own. That prefix
   * is already an authenticating, non-redirecting entry in `src/access-policies.ts` and already
   * listed in `cloudflare.config.ts`'s `runWorkerFirst`, so this endpoint inherits both decisions
   * instead of adding a third place either could be got wrong. `redirect: false` matters here more
   * than anywhere else in the application: a browser's `WebSocket` constructor cannot follow a
   * redirect to a login page, so an unauthenticated upgrade would surface as an unexplained
   * connection failure rather than as an authentication error.
   *
   * The `Upgrade` header is checked here, in the transport tier, because it is a fact about the
   * HTTP request rather than a business rule — the service should not have to know what protocol
   * its caller arrived over. A plain `GET` is answered `426 Upgrade Required`, which says precisely
   * what is wrong: the request is well-formed and the diagram exists, it is the protocol that is
   * wrong, so the `400` a generic rejection would give would be actively misleading.
   *
   * The router's `jsonBodyLimit` is mounted above but is a no-op here, because an upgrade request
   * carries no body and the middleware returns immediately for one that does not.
   *
   * The response is returned verbatim. Rebuilding it would drop the `webSocket` property, which is
   * the one part of the response that matters.
   *
   * @param context Hono request context carrying the verified identity, the untrusted `id` path
   *   parameter and the diagram service.
   * @returns A `101 Switching Protocols` response handing the socket to the browser.
   * @throws {ProblemDetailsError} `426` when the request is not a WebSocket upgrade, and `404` when
   *   the diagram is malformed, unknown or foreign — the same non-enumerating answer every other
   *   diagram route gives, so a connection attempt cannot be used to probe for ids.
   * @throws {NullError} When mounted without the Access middleware in front of it.
   * @throws {Error} When the repository cannot read the row or the session cannot accept the
   *   connection.
   */
  router.get('/:id/live', async (context) => {
    if (context.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
      throw upgradeRequired('This endpoint accepts WebSocket connections only.');
    }

    const id = context.req.param('id');
    const response = await context.var.DIAGRAM_SERVICE.connectLiveSession(
      currentIdentityEmail(context),
      id,
      context.req.raw
    );

    context.var.LOGGER.info('diagram_live_connected', { diagramId: id, via: VIA });
    return response;
  });

  /**
   * Duplicates one of the signed-in identity's own diagrams.
   *
   * A server-side endpoint rather than the client's own "read, create, then save" sequence: that
   * sequence is three requests whose middle failure leaves an empty diagram behind, and it needs
   * the client to hold a complete graph it only has because the list endpoint happens to include
   * one.
   *
   * @param context Hono request context carrying the verified identity, the untrusted `id` path
   *   parameter and the diagram service.
   * @returns A `201` response carrying the new copy.
   * @throws {ProblemDetailsError} `404` when the source diagram is malformed, unknown or foreign.
   * @throws {NullError} When mounted without the Access middleware in front of it.
   * @throws {Error} When the repository cannot read or write a row.
   */
  router.post('/:id/duplicate', async (context) => {
    const source = context.req.param('id');
    const diagram = await context.var.DIAGRAM_SERVICE.duplicate(
      currentIdentityEmail(context),
      source
    );

    context.var.LOGGER.info('diagram_duplicated', {
      diagramId: diagram.id,
      sourceId: source,
      via: VIA
    });
    return context.json({ diagram }, 201);
  });

  /**
   * Deletes one of the signed-in identity's own diagrams.
   *
   * @param context Hono request context carrying the verified identity, the untrusted `id` path
   *   parameter and the diagram service.
   * @returns A `204` response with no body, because there is nothing left to describe.
   * @throws {ProblemDetailsError} `404` when the diagram is malformed, unknown or foreign.
   * @throws {NullError} When mounted without the Access middleware in front of it.
   * @throws {Error} When the repository cannot read or delete the row.
   */
  router.delete('/:id', async (context) => {
    const id = context.req.param('id');
    await context.var.DIAGRAM_SERVICE.remove(currentIdentityEmail(context), id);

    context.var.LOGGER.info('diagram_deleted', { diagramId: id, via: VIA });
    return new Response(null, { status: 204 });
  });

  /**
   * Reports whether the diagram has an active read-only link, and when it was created.
   *
   * Never carries the link. Only a digest of a token is stored, so the server cannot reproduce one
   * — see `../domain/share.ts`.
   *
   * @param context Hono request context carrying the verified identity, the untrusted `id` path
   *   parameter and the share service.
   * @returns A `200` response carrying `{ active, createdAt }`.
   * @throws {ProblemDetailsError} `404` when the diagram is malformed, unknown or foreign.
   * @throws {NullError} When mounted without the Access middleware in front of it.
   * @throws {Error} When the repository cannot read the rows.
   */
  router.get('/:id/share', async (context) =>
    context.json(
      await context.var.SHARE_SERVICE.getStatus(
        currentIdentityEmail(context),
        context.req.param('id')
      )
    )
  );

  /**
   * Mints a read-only link for the diagram, revoking any link already active for it.
   *
   * This response is the one and only place the raw token is ever exposed. It is not stored, not
   * logged, and not returned by the status endpoint above, so a client that discards it cannot ask
   * for it again — it can only mint a new link, which revokes this one.
   *
   * The absolute URL is assembled here rather than in the service, because the origin is a property
   * of the request rather than of the use case: the same service called by an MCP tool in a later
   * phase has no request to read an origin from.
   *
   * @param context Hono request context carrying the verified identity, the untrusted `id` path
   *   parameter and the share service.
   * @returns A `201` response carrying the token, its creation timestamp and the shareable URL.
   * @throws {ProblemDetailsError} `404` when the diagram is malformed, unknown or foreign — refused
   *   before anything is minted.
   * @throws {NullError} When mounted without the Access middleware in front of it.
   * @throws {Error} When the repository cannot read or write the rows.
   */
  router.post('/:id/share', async (context) => {
    const id = context.req.param('id');
    const share = await context.var.SHARE_SERVICE.rotate(currentIdentityEmail(context), id);

    // The diagram id and the operation, exactly as every other log line here: the token is a
    // bearer credential and the one value that must never reach an operational log.
    context.var.LOGGER.info('diagram_shared', { diagramId: id, via: VIA });

    return context.json(
      {
        createdAt: share.createdAt,
        token: share.token,
        url: new URL(`/s/${share.token}`, context.req.url).toString()
      },
      201
    );
  });

  /**
   * Revokes the diagram's active read-only link.
   *
   * @param context Hono request context carrying the verified identity, the untrusted `id` path
   *   parameter and the share service.
   * @returns A `204` response with no body.
   * @throws {ProblemDetailsError} `404` when the diagram is malformed, unknown or foreign, or when
   *   it has no active link.
   * @throws {NullError} When mounted without the Access middleware in front of it.
   * @throws {Error} When the repository cannot read or write the rows.
   */
  router.delete('/:id/share', async (context) => {
    const id = context.req.param('id');
    await context.var.SHARE_SERVICE.revoke(currentIdentityEmail(context), id);

    context.var.LOGGER.info('diagram_share_revoked', { diagramId: id, via: VIA });
    return new Response(null, { status: 204 });
  });

  /**
   * Lists who has been granted edit access to the diagram.
   *
   * Readable by the owner **or** any of its collaborators, unlike the share routes above, which are
   * owner-only. Somebody editing a diagram alongside other people has a legitimate reason to know
   * who those people are; a shared document whose other editors are hidden reads as a private one
   * that changes by itself.
   *
   * @param context Hono request context carrying the verified identity, the untrusted `id` path
   *   parameter and the collaborator service.
   * @returns A `200` response carrying the diagram's collaborators, oldest grant first.
   * @throws {ProblemDetailsError} `404` when the diagram is malformed, unknown, or the caller
   *   neither owns it nor collaborates on it.
   * @throws {NullError} When mounted without the Access middleware in front of it.
   * @throws {Error} When the repository cannot read the rows.
   */
  router.get('/:id/collaborators', async (context) =>
    context.json({
      collaborators: await context.var.COLLABORATOR_SERVICE.list(
        currentIdentityEmail(context),
        context.req.param('id')
      )
    })
  );

  /**
   * Grants a previously signed-in identity edit access to the diagram.
   *
   * Owner-only, and distinct from `POST /:id/share` in both authority and effect: that mints an
   * anonymous read-only link for whoever holds it, while this names one verified identity and lets
   * them edit. The two are separate routes because they are separate concepts, and the client keeps
   * them visibly separate for the same reason.
   *
   * @param context Hono request context carrying the verified identity, the untrusted `id` path
   *   parameter, the bounded JSON body and the collaborator service.
   * @returns A `201` response carrying the grant. `201` even when the grant already existed: the
   *   operation is idempotent, the client asked for a state that is now true, and reporting a
   *   conflict would make it special-case an outcome it already has.
   * @throws {ProblemDetailsError} `400` when the body is not an object or names the owner's own
   *   address, `422` when the email is malformed, and `404` when the diagram is malformed, unknown
   *   or not the caller's — **or** when the named identity has never signed in, which carries its
   *   own actionable message rather than the uniform refusal.
   * @throws {NullError} When mounted without the Access middleware in front of it.
   * @throws {Error} When the repository cannot read or write the rows.
   */
  router.post('/:id/collaborators', async (context) => {
    const collaborator = await context.var.COLLABORATOR_SERVICE.add(
      currentIdentityEmail(context),
      context.req.param('id'),
      await readJsonBody(context.req.raw)
    );

    // The diagram id and the affected address, and nothing else. The email is the subject of the
    // event rather than incidental content, so an operator can answer "who was given access to
    // this diagram" — but no graph content reaches an operational log, here or anywhere.
    context.var.LOGGER.info('collaborator_added', {
      collaboratorEmail: collaborator.collaboratorEmail,
      diagramId: collaborator.diagramId,
      via: VIA
    });
    return context.json({ collaborator }, 201);
  });

  /**
   * Revokes one identity's edit access to the diagram.
   *
   * Two callers may reach this and no others: the owner removing anybody, and a collaborator
   * removing themselves — the "Leave diagram" path. The service decides which, before any row is
   * touched; this handler adds no rule of its own.
   *
   * The email is taken from the path rather than a body because it identifies the resource being
   * deleted, and `DELETE` with a body is poorly supported by intermediaries. Hono has already
   * percent-decoded the parameter, so the service receives the address as it was written.
   *
   * @param context Hono request context carrying the verified identity, the untrusted `id` and
   *   `email` path parameters and the collaborator service.
   * @returns A `204` response with no body, because there is nothing left to describe.
   * @throws {ProblemDetailsError} `422` when the email is malformed, and `404` when the diagram is
   *   malformed, unknown or unreachable by the caller, when a collaborator named somebody other
   *   than themselves, or when no such grant exists.
   * @throws {NullError} When mounted without the Access middleware in front of it.
   * @throws {Error} When the repository cannot read or write the rows.
   */
  router.delete('/:id/collaborators/:email', async (context) => {
    const id = context.req.param('id');
    const email = context.req.param('email');
    await context.var.COLLABORATOR_SERVICE.remove(currentIdentityEmail(context), id, email);

    context.var.LOGGER.info('collaborator_removed', {
      collaboratorEmail: email,
      diagramId: id,
      via: VIA
    });
    return new Response(null, { status: 204 });
  });

  return router;
}
