import type { ViewportTransform } from "@vue-flow/core";
import type { GraphPoint } from "./types";

/** Convert screen pixels to graph coordinates under a specific viewer's viewport. */
export function screenToGraph(point: GraphPoint, viewport: ViewportTransform): GraphPoint {
  return { x: (point.x - viewport.x) / viewport.zoom, y: (point.y - viewport.y) / viewport.zoom };
}

/** Convert a graph-space point to screen pixels under a specific viewer's viewport. */
export function graphToScreen(point: GraphPoint, viewport: ViewportTransform): GraphPoint {
  return { x: point.x * viewport.zoom + viewport.x, y: point.y * viewport.zoom + viewport.y };
}
