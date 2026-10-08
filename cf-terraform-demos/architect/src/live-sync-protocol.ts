/**
 * @file The live-sync WebSocket wire protocol, shared verbatim by the Durable Object that produces
 *   the frames (`src/worker/infrastructure/diagram-session.ts`) and the canvas that consumes them
 *   (`src/client/components/editor/DiagramCanvas.tsx`). It sits in `src/` rather than under
 *   `src/worker/` or `src/client/` for the same reason `./graph-element-types.ts` does: it belongs
 *   to neither side, it is the contract between them. One definition means a frame the object can
 *   send is by construction a frame the canvas can handle — the client's `switch` is checked for
 *   exhaustiveness, so adding a frame here fails the build until the canvas handles it. Two
 *   independently written copies would instead fail at runtime, in a browser, as a frame silently
 *   doing nothing. **This channel is one-way.** The object pushes; the browser never writes to it.
 *   The browser's own edits keep going through the debounced `PUT /api/diagrams/:id/graph`
 *   autosave, unchanged — this phase adds a read channel, not a second write path. There is
 *   therefore no client frame type in this module at all, and that absence is the protocol rather
 *   than an omission: a vocabulary with nothing for a client to say is a vocabulary a client cannot
 *   misuse.
 */

/**
 * Sent once to a connection the moment it is accepted.
 *
 * It carries the identity the server pinned to this socket, read back out of the socket attachment
 * rather than echoed from the request. That round trip is the point: the value a later frame would
 * be attributed to is the value the client is shown, so the two cannot disagree. A client that
 * receives an identity it did not expect is looking at a stale Access session and can say so,
 * instead of silently trusting a connection opened for somebody else.
 */
export interface ConnectedFrame {
  /**
   * Discriminator identifying this frame.
   */
  type: 'connected';
  /**
   * Verified Cloudflare Access identity the Worker authorized this connection for.
   */
  viewer: string;
}

/**
 * A diagram's graph as it now stands, pushed after an agent's change has already been persisted.
 *
 * Sent to every connection open on the diagram, including one belonging to the very identity whose
 * agent made the change: a second tab needs the update just as much as a first one, and the object
 * has no way to tell which connection, if any, belongs to the session that triggered the tool
 * call.
 */
export interface GraphUpdatedFrame {
  /**
   * Discriminator identifying this frame.
   */
  type: 'graph_updated';
  /**
   * The canonical graph JSON exactly as it was persisted to D1, so a client renders what is
   * actually stored rather than a reconstruction of it.
   */
  graphData: string;
  /**
   * ISO-8601 timestamp the persisting write recorded. The client compares it with its own
   * last-known value and ignores anything not newer, which is what stops a push that lost a race
   * from reverting a change the user can already see.
   */
  updatedAt: string;
}

/**
 * Sent to one connection that tried to write on a channel that does not accept writes.
 *
 * The connection stays open. A client sending a frame here is a bug in that client rather than an
 * attack — there is nothing it could say that would be honoured — so the useful response is to say
 * plainly why nothing happened rather than to disconnect a session the user is working in.
 */
export interface ErrorFrame {
  /**
   * Discriminator identifying this frame.
   */
  type: 'error';
  /**
   * User-safe explanation of what the server did not do.
   */
  detail: string;
}

/**
 * Every frame the session may send.
 *
 * A discriminated union, so a `switch` on `type` in the browser is exhaustiveness-checked and a
 * frame added here cannot ship until the canvas handles it.
 */
export type SessionFrame = ConnectedFrame | GraphUpdatedFrame | ErrorFrame;
