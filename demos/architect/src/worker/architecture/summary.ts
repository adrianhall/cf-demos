import { catalog } from "../../graph/catalog";
import type {
  ActorNodeData,
  GraphDocument,
  ProductNodeData,
} from "../../graph/types";

/**
 * Narrow one node's `data` to {@link ProductNodeData}. `ArchitectureNode` does not declare
 * `type`/`data` as a discriminated union (see `../../graph/types.ts`'s own documentation on why),
 * so this checks the one field only {@link ProductNodeData} has, rather than trusting the
 * sibling `node.type` field to narrow `node.data` for the type checker.
 *
 * @param data Candidate node data.
 * @returns Whether `data` is a product node's data.
 */
function isProductNodeData(
  data: ProductNodeData | ActorNodeData,
): data is ProductNodeData {
  return "productId" in data;
}

/**
 * Build a compact, deterministic semantic summary of the curated product catalog and the
 * diagram's current nodes, for `ArchitectureWorkflow`'s `summarize` step to hand to the AI
 * generator as `ArchitectureGeneratorRequest.catalogSummary`.
 *
 * Deliberately never includes the requester's prompt (that stays a separate field) and never
 * includes edge relationships in detail — the model only needs to know which products already
 * appear on the canvas, not the full graph, to propose sensible new architecture. This keeps the
 * request small and avoids leaking anything beyond what the diagram's own members can already
 * see.
 *
 * @param document The diagram's current authoritative document (`DiagramRoom.readDocument()`).
 * @returns A short, human-readable summary safe to send to Workers AI.
 */
export function buildCatalogSummary(document: GraphDocument): string {
  const catalogLines = catalog
    .map(
      (product) =>
        `- ${product.label} (id: ${product.id}): ${product.description}`,
    )
    .join("\n");

  const nodeLines =
    document.nodes.length === 0
      ? "(the diagram is currently empty)"
      : document.nodes
          .map((node) =>
            isProductNodeData(node.data)
              ? `- product ${node.data.productId}: ${node.data.label}`
              : `- external actor: ${node.data.label}`,
          )
          .join("\n");

  return [
    "Available Cloudflare products (only use these productId values for product nodes):",
    catalogLines,
    "",
    `The diagram currently has ${document.nodes.length} node(s) and ${document.edges.length} edge(s):`,
    nodeLines,
  ].join("\n");
}
