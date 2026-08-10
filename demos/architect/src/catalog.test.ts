import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as FeatherIcons from "react-feather";
import { describe, expect, it } from "vitest";
import {
  CATEGORY_COLORS,
  CATEGORY_LABELS,
  EDGE_TYPE_MAP,
  EDGE_TYPES,
  getNodesByCategory,
  NODE_TYPE_MAP,
  NODE_TYPES,
} from "./catalog";

/** Every vendored icon filename under `src/client/icons/` (Issue 7, docs/09-ARCHITECT.md Phase 7). */
const vendoredIconFiles = new Set(
  readdirSync(fileURLToPath(new URL("./client/icons", import.meta.url))),
);

describe("catalog", () => {
  it("has a unique typeId for every node type", () => {
    const typeIds = NODE_TYPES.map((node) => node.typeId);
    expect(new Set(typeIds).size).toBe(typeIds.length);
  });

  it("has a unique edgeType for every edge type", () => {
    const edgeTypes = EDGE_TYPES.map((edge) => edge.edgeType);
    expect(new Set(edgeTypes).size).toBe(edgeTypes.length);
  });

  it("assigns a category color and label to every category used by a node type", () => {
    for (const node of NODE_TYPES) {
      expect(CATEGORY_COLORS[node.category]).toMatch(/^#[0-9A-Fa-f]{6}$/u);
      expect(CATEGORY_LABELS[node.category]).toBeTruthy();
    }
  });

  it("gives every node type at least one connection handle", () => {
    for (const node of NODE_TYPES) {
      expect(node.defaultHandles.length).toBeGreaterThan(0);
    }
  });

  it("looks up a node type definition by typeId via NODE_TYPE_MAP", () => {
    expect(NODE_TYPE_MAP.get("worker")).toMatchObject({
      category: "compute",
      label: "Workers",
    });
    expect(NODE_TYPE_MAP.get("does-not-exist")).toBeUndefined();
  });

  it("looks up an edge type definition by edgeType via EDGE_TYPE_MAP", () => {
    expect(EDGE_TYPE_MAP.get("data-flow")).toMatchObject({
      label: "Data Flow",
    });
    expect(EDGE_TYPE_MAP.get("does-not-exist")).toBeUndefined();
  });

  it("resolves every svg-kind icon to a vendored file under src/client/icons/", () => {
    for (const node of NODE_TYPES) {
      if (node.icon.kind !== "svg") continue;
      expect(vendoredIconFiles.has(`${node.icon.name}.svg`)).toBe(true);
    }
  });

  it("resolves every feather-kind icon to a real react-feather export", () => {
    for (const node of NODE_TYPES) {
      if (node.icon.kind !== "feather") continue;
      expect(FeatherIcons).toHaveProperty(node.icon.name);
    }
  });

  it("groups every node type under its category with none dropped or duplicated", () => {
    const grouped = getNodesByCategory();
    const total = Object.values(grouped).reduce(
      (sum, nodes) => sum + nodes.length,
      0,
    );
    expect(total).toBe(NODE_TYPES.length);
    for (const [category, nodes] of Object.entries(grouped)) {
      for (const node of nodes) {
        expect(node.category).toBe(category);
      }
    }
  });
});
