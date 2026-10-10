import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as FeatherIcons from 'react-feather';
import { describe, expect, it } from 'vitest';
import { BLUEPRINTS } from '../../src/blueprints.ts';
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
    expect(NODE_TYPES).toHaveLength(51);
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

    // `DocLinkIcon` has had a `video` member since the original application, but no product ever
    // set it, so the panel's video branch was unreachable content rather than unreachable code.
    // This keeps the branch fed: delete the last video link and the panel renders a type it can
    // no longer be shown to handle.
    it('exercises both supported link icons somewhere in the catalogue', () => {
      const icons = new Set(NODE_TYPES.flatMap((node) => node.docLinks ?? []).map((l) => l.icon));

      expect(icons).toEqual(new Set(['doc', 'video']));
    });

    // A video is an addition to a product's written documentation, never a replacement: the docs
    // link is the one that stays correct as the product changes.
    it('pairs every video link with written documentation for the same product', () => {
      for (const node of NODE_TYPES) {
        const links = node.docLinks ?? [];
        if (!links.some((link) => link.icon === 'video')) {
          continue;
        }
        expect(
          links.some((link) => link.icon === 'doc'),
          `${node.typeId} offers a video but no documentation link`
        ).toBe(true);
      }
    });

    // Every video is a watch page on Cloudflare's own channel. Anything else -- a playlist, a
    // channel page, a marketing page wearing a video title -- is the content gap reopening under
    // a link that merely looks right.
    it('points every video link at a YouTube watch page', () => {
      for (const node of NODE_TYPES) {
        for (const link of node.docLinks ?? []) {
          if (link.icon !== 'video') {
            continue;
          }
          expect(link.url, `${node.typeId} video is not a watch URL`).toMatch(
            /^https:\/\/www\.youtube\.com\/watch\?v=[\w-]{11}$/u
          );
        }
      }
    });

    // The panel keys its list by URL, so two products sharing one video is fine but one product
    // listing the same link twice renders duplicate React keys and a visibly repeated row.
    it('lists no duplicate link URL within a product', () => {
      for (const node of NODE_TYPES) {
        const urls = (node.docLinks ?? []).map((link) => link.url);

        expect(new Set(urls).size, `${node.typeId} repeats a documentation link`).toBe(urls.length);
      }
    });

    // A title that does not name its product reads as "Video" in a panel that has already said
    // which product is selected, which is exactly where a mis-pasted link hides.
    it('names the product in every video link title', () => {
      for (const node of NODE_TYPES) {
        for (const link of node.docLinks ?? []) {
          if (link.icon !== 'video') {
            continue;
          }
          expect(link.title, `${node.typeId} video title is unhelpful`).toMatch(/\bVideo$/u);
          expect(link.title.length, `${node.typeId} video title is only "Video"`).toBeGreaterThan(
            'Video'.length
          );
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

  // A product rename must change only the user-facing surface -- label, description, icon and
  // documentation links -- and never a `typeId`, because `typeId` is what a saved diagram stores
  // in its `graph_data` JSON. Renaming one would strand every existing diagram containing that
  // node on a type the catalogue can no longer resolve, which renders as a label-only node with no
  // icon rather than failing anywhere a test would normally notice.
  //
  // The blueprints are the only persisted graphs committed to this repository, so they stand in
  // for every diagram already saved in D1: if a rename breaks them, it breaks those too.
  describe('blueprint graph compatibility', () => {
    it('resolves every typeId used by a blueprint to a catalogue entry', () => {
      for (const blueprint of BLUEPRINTS) {
        const graph = JSON.parse(blueprint.graphData) as {
          nodes?: { data?: { typeId?: string } }[];
        };

        for (const node of graph.nodes ?? []) {
          const typeId = node.data?.typeId;
          expect(typeId).toBeDefined();
          // Asserted through the map the renderers actually use, so this fails for exactly the
          // reason a canvas would render the node without its icon.
          expect(
            NODE_TYPE_MAP.has(typeId ?? ''),
            `blueprint "${blueprint.id}" uses unknown typeId "${typeId}"`
          ).toBe(true);
        }
      }
    });
  });
});
