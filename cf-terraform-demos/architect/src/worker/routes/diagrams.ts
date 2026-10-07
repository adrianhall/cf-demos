import { Hono } from 'hono';
import { currentIdentityEmail, jsonBodyLimit, readJsonBody } from '@demos/worker-common';
import type { AppBindings } from '../bindings.ts';

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
 * Owner-scoped diagram API, mounted at `/api/diagrams`.
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
 * Every refusal is a `404`, never a `403`: a diagram that exists but belongs to someone else is
 * reported identically to one that does not exist, so a caller can never confirm that a guessed id
 * is real. The service owns that rule; this router simply never adds a status of its own.
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
    context.var.LOGGER.info('diagram_created', { diagramId: diagram.id });
    return context.json({ diagram }, 201);
  });

  /**
   * Reads one of the signed-in identity's own diagrams.
   *
   * @param context Hono request context carrying the verified identity, the untrusted `id` path
   *   parameter and the diagram service.
   * @returns A `200` response carrying the diagram.
   * @throws {ProblemDetailsError} `404` when the id is malformed, unknown, or belongs to another
   *   identity — all three reported identically.
   * @throws {NullError} When mounted without the Access middleware in front of it.
   * @throws {Error} When the repository cannot read the row.
   */
  router.get('/:id', async (context) => {
    const id = context.req.param('id');
    const diagram = await context.var.DIAGRAM_SERVICE.get(currentIdentityEmail(context), id);

    // An id and the operation are enough to correlate a request. The graph, title and verified
    // identity are user content and do not belong in an operational log.
    context.var.LOGGER.info('diagram_opened', { diagramId: diagram.id });
    return context.json({ diagram });
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

    context.var.LOGGER.info('diagram_updated', { diagramId: diagram.id, kind: 'metadata' });
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

    context.var.LOGGER.info('diagram_updated', { diagramId: id, kind: 'graph' });
    return context.json({ updatedAt });
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

    context.var.LOGGER.info('diagram_duplicated', { diagramId: diagram.id, sourceId: source });
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

    context.var.LOGGER.info('diagram_deleted', { diagramId: id });
    return new Response(null, { status: 204 });
  });

  return router;
}
