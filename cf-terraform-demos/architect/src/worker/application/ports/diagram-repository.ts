import type {
  CreateDiagramInput,
  Diagram,
  PublicDiagram,
  UpdateDiagramInput
} from '../../domain/diagram.ts';

/**
 * Persistence port for diagrams.
 *
 * Every method here is **authorization-neutral**, and that is the single most important property of
 * this interface. A port that took "may this caller see it?" decisions would have to re-take them
 * for every transport: the HTTP API today, the MCP tool layer in a later phase, and the live
 * session after that. Ownership lives in {@link DiagramService} instead, which reads a diagram,
 * compares its owner with the verified actor, and answers with the uniform non-enumerating `404`
 * this API's contract depends on.
 *
 * The one apparent exception proves the rule. {@link DiagramRepository.listByOwner} takes an owner,
 * but as a _query filter_ rather than an access decision: "select the rows whose owner is X" is a
 * statement about which rows to read, and the service still decides whether the caller is X.
 *
 * `Pick`-style narrowing of the D1 binding, and the choice of D1 over KV, belong to the adapter
 * (`../../infrastructure/d1-diagram-repository.ts`). Nothing above this line knows either.
 */
export interface DiagramRepository {
  /**
   * Persists a new diagram.
   *
   * @param ownerEmail Verified Cloudflare Access identity that will own the diagram.
   * @param input Validated metadata. A blueprint has already been resolved to `graphData` by the
   *   service, so this port never looks a blueprint up itself.
   * @param graphData Canonical graph JSON to store verbatim.
   * @returns The persisted diagram, including its generated id and timestamps.
   * @throws {Error} When the underlying store rejects the write.
   */
  create(ownerEmail: string, input: CreateDiagramInput, graphData: string): Promise<Diagram>;

  /**
   * Reads one diagram by id, regardless of owner.
   *
   * Owner-blind by design: the caller is the application service, which needs the owner in order to
   * make the access decision. A `findOwned(id, email)` signature would look safer and in fact be
   * worse — it would put the ownership rule in the adapter, where a second transport could reach
   * storage without passing through it.
   *
   * @param id Diagram id.
   * @returns The diagram, or `null` when no row has that id.
   * @throws {Error} When the underlying store rejects the read.
   */
  find(id: string): Promise<Diagram | null>;

  /**
   * Reads one diagram's owner-blind projection by id.
   *
   * Separate from {@link DiagramRepository.find} rather than a caller dropping a field, because the
   * projections genuinely differ: this one must not carry the owner, and selecting only the columns
   * it may return is a stronger guarantee than reading the whole row and remembering to omit one.
   * It backs the administrative moderation preview, whose point is to show an administrator what a
   * diagram _contains_ before they decide to delete it — without adding a second way to discover
   * who wrote it.
   *
   * @param id Diagram id.
   * @returns The owner-blind projection, or `null` when no row has that id.
   * @throws {Error} When the underlying store rejects the read.
   */
  findPublicFields(id: string): Promise<PublicDiagram | null>;

  /**
   * Lists the diagrams belonging to one owner, most recently updated first.
   *
   * Each result carries its full `graphData`, not just metadata: the dashboard renders a real React
   * Flow thumbnail of every card, so a metadata-only projection would need a second request per
   * diagram to draw the page.
   *
   * @param ownerEmail Owner whose rows should be selected.
   * @returns That owner's diagrams, newest activity first. Empty when they have none.
   * @throws {Error} When the underlying store rejects the read.
   */
  listByOwner(ownerEmail: string): Promise<Diagram[]>;

  /**
   * Replaces a diagram's title and/or description.
   *
   * @param id Diagram id.
   * @param input Validated fields to write. An omitted field is left unchanged.
   * @returns The updated diagram, or `null` when no row has that id.
   * @throws {Error} When the underlying store rejects the write.
   */
  updateMetadata(id: string, input: UpdateDiagramInput): Promise<Diagram | null>;

  /**
   * Replaces a diagram's entire graph.
   *
   * There is no partial-patch protocol: the editor always sends the complete graph, so this
   * replaces rather than merges.
   *
   * @param id Diagram id.
   * @param graphData Canonical, already-validated graph JSON to store verbatim.
   * @returns The new `updatedAt` timestamp, or `null` when no row has that id.
   * @throws {Error} When the underlying store rejects the write.
   */
  replaceGraph(id: string, graphData: string): Promise<string | null>;

  /**
   * Deletes a diagram.
   *
   * @param id Diagram id.
   * @returns `true` when a row was deleted, and `false` when none had that id.
   * @throws {Error} When the underlying store rejects the delete.
   */
  remove(id: string): Promise<boolean>;
}
