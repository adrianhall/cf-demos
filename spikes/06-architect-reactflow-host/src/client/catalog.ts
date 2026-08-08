/**
 * A deliberately tiny slice of CF-Architect's real product catalog (`src/lib/catalog.ts` in
 * `~/repos/adrianhall/CF-Architect`) — five products is exactly what this spike's probe
 * (docs/09-ARCHITECT.md, Phase 0) calls for, not a full port. Phase 2 ports the real ~30-product
 * catalog once this host architecture is confirmed.
 */

/** One draggable entry in the product palette. */
export interface CatalogProduct {
  /** Stable identifier, also used as the new node's default `id` prefix. */
  id: string;
  /** Display name shown on the palette entry and the resulting node. */
  name: string;
  /** Catalog category shown as a small caption under the product name. */
  category: string;
  /** Accent color applied to the resulting node's left border and palette swatch. */
  color: string;
}

export const catalogProducts: CatalogProduct[] = [
  { id: "workers", name: "Workers", category: "Compute", color: "#f6821f" },
  { id: "d1", name: "D1", category: "Storage", color: "#3b82f6" },
  { id: "kv", name: "Workers KV", category: "Storage", color: "#8b5cf6" },
  { id: "r2", name: "R2", category: "Storage", color: "#10b981" },
  { id: "durable-objects", name: "Durable Objects", category: "Compute", color: "#f43f5e" },
];

/** The single external-actor palette entry (a human or system outside the Cloudflare account). */
export const externalActor: Pick<CatalogProduct, "id" | "name"> = {
  id: "browser",
  name: "Browser",
};
