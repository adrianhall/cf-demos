import type { ArchitectureProposal } from "./contracts";

/** Curated catalog deliberately kept small for this orchestration proof. */
const catalog = new Set(["workers", "d1", "r2", "durable-objects"]);

/**
 * Parses and validates untrusted generator output.
 *
 * @param raw Raw generator text.
 * @returns A validated architecture proposal.
 * @throws Error when JSON, products, node IDs, or edges violate the contract.
 */
export function parseArchitectureProposal(raw: string): ArchitectureProposal {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("generator returned malformed JSON");
  }
  if (!isRecord(value) || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    throw new Error("generator returned an invalid proposal shape");
  }
  const nodes = value.nodes.map((node) => {
    if (!isRecord(node) || typeof node.id !== "string" || typeof node.product !== "string") {
      throw new Error("generator returned an invalid node");
    }
    if (!catalog.has(node.product)) throw new Error(`unknown product: ${node.product}`);
    return { id: node.id, product: node.product };
  });
  const nodeIds = new Set(nodes.map((node) => node.id));
  if (nodeIds.size !== nodes.length) throw new Error("generator returned duplicate node IDs");
  const edges = value.edges.map((edge) => {
    if (!isRecord(edge) || typeof edge.from !== "string" || typeof edge.to !== "string") {
      throw new Error("generator returned an invalid edge");
    }
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to) || edge.from === edge.to) {
      throw new Error(`invalid edge: ${edge.from}->${edge.to}`);
    }
    return { from: edge.from, to: edge.to };
  });
  return { nodes, edges };
}

/** Narrows an unknown JSON value to an object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
