/**
 * Configures the shared Pothos schema builder.
 *
 * Depth and breadth are bounded to stop cyclic, arbitrarily wide queries from
 * exhausting the endpoint. This operational guard deliberately does not score
 * fields or change the intentionally naive, per-parent D1 resolution.
 */
import SchemaBuilder from "@pothos/core";
import ComplexityPlugin from "@pothos/plugin-complexity";
import type { AppBindings } from "../bindings";

/** Builds the read-only SWAPI schema using the request's Worker bindings. */
export const builder = new SchemaBuilder<{
  Context: AppBindings;
}>({
  plugins: [ComplexityPlugin],
  complexity: {
    limit: {
      breadth: 50,
      depth: 10,
    },
  },
});
