import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as FeatherIcons from 'react-feather';
import { describe, expect, it } from 'vitest';
import {
  CATEGORY_COLORS,
  CATEGORY_LABELS,
  EDGE_TYPE_MAP,
  EDGE_TYPES,
  getNodesByCategory,
  NODE_TYPE_MAP,
  NODE_TYPES
} from '../../src/catalog.ts';

/**
 * @file Covers the product catalogue's internal consistency. Every assertion here guards a failure
 *   that would otherwise surface as a silently broken node on the canvas: a duplicate identifier
 *   making a lookup non-deterministic, an icon name with no file behind it, or a category with no
 *   colour, which would leave a node with no border — the only cue distinguishing it from the
 *   canvas when unselected. It runs in the Node-based project rather than the jsdom one despite
 *   covering client-shared data, because the icon check reads the vendored icon directory from
 *   disk. That is the whole point of it: asserting the catalogue against itself would pass with
 *   every icon file deleted.
 */

/**
 * Every vendored icon filename under `src/client/icons/`.
 */
const vendoredIconFiles = new Set(
  readdirSync(fileURLToPath(new URL('../../src/client/icons', import.meta.url)))
);

describe('catalog', () => {
  it('defines the full documented product set', () => {
    expect(NODE_TYPES).toHaveLength(42);
  });

  // A duplicate makes `NODE_TYPE_MAP` keep whichever entry was built last, so the canvas would
  // render one of two definitions with no way to tell which.
  it('has a unique typeId for every node type', () => {
    const typeIds = NODE_TYPES.map((node) => node.typeId);

    expect(new Set(typeIds).size).toBe(typeIds.length);
  });

  it('has a unique edgeType for every edge type', () => {
    const edgeTypes = EDGE_TYPES.map((edge) => edge.edgeType);

    expect(new Set(edgeTypes).size).toBe(edgeTypes.length);
  });

  it('gives every node type a non-empty label and description', () => {
    for (const node of NODE_TYPES) {
      expect(node.label, `${node.typeId} needs a label`).not.toBe('');
      expect(node.description, `${node.typeId} needs a description`).not.toBe('');
    }
  });

  // The border colour is the only visual cue distinguishing an unselected node from the canvas, so
  // a category with no colour is a node that disappears.
  it('assigns a hex colour and a label to every category a node type uses', () => {
    for (const node of NODE_TYPES) {
      expect(CATEGORY_COLORS[node.category]).toMatch(/^#[0-9A-Fa-f]{6}$/u);
      expect(CATEGORY_LABELS[node.category]).toBeTruthy();
    }
  });

  it('gives every node type at least one connection handle', () => {
    for (const node of NODE_TYPES) {
      expect(node.defaultHandles.length).toBeGreaterThan(0);
    }
  });

  it('gives every handle a unique id within its node type', () => {
    for (const node of NODE_TYPES) {
      const ids = node.defaultHandles.map((handle) => handle.id);

      expect(new Set(ids).size, `${node.typeId} has duplicate handle ids`).toBe(ids.length);
    }
  });

  describe('lookup maps', () => {
    it('resolves a node type by typeId', () => {
      expect(NODE_TYPE_MAP.get('worker')).toMatchObject({
        category: 'compute',
        label: 'Workers'
      });
    });

    it('resolves nothing for an unknown typeId', () => {
      expect(NODE_TYPE_MAP.get('does-not-exist')).toBeUndefined();
    });

    it('resolves an edge type by edgeType', () => {
      expect(EDGE_TYPE_MAP.get('data-flow')).toMatchObject({ label: 'Data Flow' });
    });

    it('resolves nothing for an unknown edgeType', () => {
      expect(EDGE_TYPE_MAP.get('does-not-exist')).toBeUndefined();
    });

    it('indexes every node and edge type', () => {
      expect(NODE_TYPE_MAP.size).toBe(NODE_TYPES.length);
      expect(EDGE_TYPE_MAP.size).toBe(EDGE_TYPES.length);
    });
  });

  describe('icons', () => {
    // An icon name with no file behind it renders as nothing at all, which on the canvas reads as a
    // node that failed to load rather than a missing asset.
    it('resolves every vendored icon name to a real file', () => {
      for (const node of NODE_TYPES) {
        if (node.icon.kind !== 'svg') {
          continue;
        }
        expect(
          vendoredIconFiles.has(`${node.icon.name}.svg`),
          `${node.typeId} references the missing icon ${node.icon.name}.svg`
        ).toBe(true);
      }
    });

    // `ProductIcon` maps these by name against a small hand-maintained set, deliberately rather
    // than a namespace import that would defeat tree-shaking. This is what keeps the two in sync.
    it('resolves every feather icon name to a real react-feather export', () => {
      for (const node of NODE_TYPES) {
        if (node.icon.kind !== 'feather') {
          continue;
        }
        expect(FeatherIcons, `${node.typeId} references an unknown feather icon`).toHaveProperty(
          node.icon.name
        );
      }
    });
  });

  describe('documentation links', () => {
    it('gives every documentation link an https URL and a title', () => {
      for (const node of NODE_TYPES) {
        for (const link of node.docLinks ?? []) {
          expect(link.title, `${node.typeId} has an untitled link`).not.toBe('');
          expect(link.url, `${node.typeId} link ${link.title} must be https`).toMatch(
            /^https:\/\//u
          );
        }
      }
    });

    it('uses only the supported link icons', () => {
      for (const node of NODE_TYPES) {
        for (const link of node.docLinks ?? []) {
          expect(['doc', 'video']).toContain(link.icon);
        }
      }
    });
  });

  describe('getNodesByCategory', () => {
    it('groups every node type with none dropped or duplicated', () => {
      const grouped = getNodesByCategory();
      const total = Object.values(grouped).reduce((sum, nodes) => sum + nodes.length, 0);

      expect(total).toBe(NODE_TYPES.length);
    });

    it('files every node under its own category', () => {
      for (const [category, nodes] of Object.entries(getNodesByCategory())) {
        for (const node of nodes) {
          expect(node.category).toBe(category);
        }
      }
    });
  });
});
