/**
 * An entity tagged with the parent it was loaded for.
 *
 * Batched relation loads are the reason this type exists. A GraphQL query that selects `films {
 * characters { name } }` asks for the characters of _many_ films at once, and this application
 * answers that with one SQL statement per relation rather than one per film. That single result set
 * contains the children of every requested parent mixed together, so each row has to carry the
 * parent it belongs to for the loader to split the rows back into per-parent lists.
 *
 * The tag lives on the domain entity rather than in a separate index structure because the
 * DataLoader integration groups a flat array by a key function (see
 * `src/worker/application/graphql/types/refs.ts`), so a flat, self-describing row is exactly the
 * shape the consumer needs.
 *
 * @typeParam T Entity type being related to a parent.
 */
export type Related<T> = T & {
  /**
   * Identifier of the parent entity whose relation list this entity belongs to.
   */
  parentId: string;
};
