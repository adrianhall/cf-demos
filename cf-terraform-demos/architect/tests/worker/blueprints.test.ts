import { describe, expect, it } from 'vitest';
import { BLUEPRINT_MAP, BLUEPRINTS } from '../../src/blueprints.ts';
import { NODE_TYPE_MAP } from '../../src/catalog.ts';
import { CF_EDGE_TYPE, CF_NODE_TYPE } from '../../src/graph-element-types.ts';
import { canonicalizeGraphData, type GraphData } from '../../src/worker/domain/graph.ts';

/**
 * @file Covers the blueprint templates' internal consistency and their cross-references into the
 *   catalogue. Every assertion here guards something a user would otherwise meet as a broken
 *   diagram rather than as a failed test: a template whose node references a product the catalogue
 *   no longer defines renders as an unstyled box, and an edge pointing at a node that is not in the
 *   same template renders as nothing at all. It runs in the Node project rather than the jsdom one
 *   because none of it is about rendering.
 */

/**
 * Parses one blueprint's serialised graph.
 *
 * @param graphData The blueprint's `graphData`.
 * @returns The decoded graph.
 */
function parse(graphData: string): GraphData {
  return JSON.parse(graphData) as GraphData;
}

describe('blueprints', () => {
  it('defines the full documented set of templates', () => {
    expect(BLUEPRINTS).toHaveLength(22);
  });

  // A duplicate makes `BLUEPRINT_MAP` keep whichever entry was built last, so creating from that
  // slug would silently seed one of two graphs with no way to tell which.
  it('has a unique id for every blueprint', () => {
    const ids = BLUEPRINTS.map((blueprint) => blueprint.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('indexes every blueprint by id, and nothing else', () => {
    for (const blueprint of BLUEPRINTS) {
      expect(BLUEPRINT_MAP.get(blueprint.id)).toBe(blueprint);
    }

    expect(BLUEPRINT_MAP.size).toBe(BLUEPRINTS.length);
    expect(BLUEPRINT_MAP.get('does-not-exist')).toBeUndefined();
  });

  it('gives every blueprint a title, description and category', () => {
    for (const blueprint of BLUEPRINTS) {
      expect(blueprint.title, `${blueprint.id} needs a title`).not.toBe('');
      expect(blueprint.description, `${blueprint.id} needs a description`).not.toBe('');
      expect(blueprint.category, `${blueprint.id} needs a category`).not.toBe('');
    }
  });

  // The gallery derives its filter pills from the distinct categories in this data, so these are
  // the filters a visitor actually sees.
  it('uses only the documented gallery categories', () => {
    const categories = new Set(BLUEPRINTS.map((blueprint) => blueprint.category));

    expect([...categories].sort()).toEqual(['AI', 'Media', 'Serverless', 'Storage']);
  });

  // The reference-architecture templates are transcriptions of a specific published diagram, so a
  // missing or hand-edited URL loses the only pointer back to the prose that justifies the graph.
  it('points every reference-architecture template at a canonical Cloudflare URL', () => {
    const referenced = BLUEPRINTS.filter((blueprint) => blueprint.referenceUrl !== undefined);

    // The four source-ported templates that map onto no single published diagram.
    expect(referenced).toHaveLength(BLUEPRINTS.length - 4);

    for (const blueprint of referenced) {
      expect(blueprint.referenceUrl, `${blueprint.id} needs an absolute docs URL`).toMatch(
        /^https:\/\/developers\.cloudflare\.com\/reference-architecture\/diagrams\/[a-z-]+\/[a-z0-9-]+\/$/
      );
    }
  });

  // A duplicated URL means two templates claim to be the same published architecture, which is
  // either a copy-paste slip or a genuine duplicate blueprint.
  it('maps at most one template onto each reference architecture', () => {
    const urls = BLUEPRINTS.flatMap((blueprint) =>
      blueprint.referenceUrl === undefined ? [] : [blueprint.referenceUrl]
    );

    expect(new Set(urls).size).toBe(urls.length);
  });

  it('serialises every graph as valid JSON with nodes, edges and a viewport', () => {
    for (const blueprint of BLUEPRINTS) {
      const graph = parse(blueprint.graphData);

      expect(Array.isArray(graph.nodes), `${blueprint.id} needs a nodes array`).toBe(true);
      expect(Array.isArray(graph.edges), `${blueprint.id} needs an edges array`).toBe(true);
      expect(graph.viewport).toEqual({ x: 0, y: 0, zoom: 1 });
      expect(graph.nodes.length, `${blueprint.id} would open as a blank canvas`).toBeGreaterThan(0);
    }
  });

  // The server seeds a new diagram with a blueprint's `graphData` verbatim rather than running it
  // through the canonicaliser, so a template that would have failed validation is a row that can
  // never be saved back. Asserting it here is what keeps that shortcut safe.
  it('holds graph data the domain validator accepts, already in canonical form', () => {
    for (const blueprint of BLUEPRINTS) {
      expect(canonicalizeGraphData(parse(blueprint.graphData)), blueprint.id).toBe(
        blueprint.graphData
      );
    }
  });

  it('references only catalogue product types that exist', () => {
    for (const blueprint of BLUEPRINTS) {
      for (const node of parse(blueprint.graphData).nodes) {
        const { typeId } = node.data as { typeId: string };

        expect(
          NODE_TYPE_MAP.has(typeId),
          `${blueprint.id} references the unknown product type "${typeId}"`
        ).toBe(true);
      }
    }
  });

  // Every node and edge carries the shared React Flow type key rather than a re-typed literal, so
  // the client's renderer registry resolves it. A drifted literal renders the element with React
  // Flow's unstyled default instead.
  it('stamps the shared React Flow type keys onto every element', () => {
    for (const blueprint of BLUEPRINTS) {
      const graph = parse(blueprint.graphData);

      for (const node of graph.nodes) {
        expect(node.type, `${blueprint.id} node ${String(node.id)}`).toBe(CF_NODE_TYPE);
      }
      for (const edge of graph.edges) {
        expect(edge.type, `${blueprint.id} edge ${String(edge.id)}`).toBe(CF_EDGE_TYPE);
      }
    }
  });

  it('gives every node a numeric canvas position', () => {
    for (const blueprint of BLUEPRINTS) {
      for (const node of parse(blueprint.graphData).nodes) {
        expect(node.position, `${blueprint.id} node ${String(node.id)}`).toEqual({
          x: expect.any(Number) as number,
          y: expect.any(Number) as number
        });
      }
    }
  });

  it('connects every edge to node ids within the same blueprint', () => {
    for (const blueprint of BLUEPRINTS) {
      const graph = parse(blueprint.graphData);
      const nodeIds = new Set(graph.nodes.map((node) => node.id));

      for (const edge of graph.edges) {
        expect(nodeIds.has(edge.source), `${blueprint.id} edge ${String(edge.id)} source`).toBe(
          true
        );
        expect(nodeIds.has(edge.target), `${blueprint.id} edge ${String(edge.id)} target`).toBe(
          true
        );
      }
    }
  });

  it('has unique node and edge ids within each blueprint', () => {
    for (const blueprint of BLUEPRINTS) {
      const graph = parse(blueprint.graphData);
      const nodeIds = graph.nodes.map((node) => node.id);
      const edgeIds = graph.edges.map((edge) => edge.id);

      expect(new Set(nodeIds).size, `${blueprint.id} has duplicate node ids`).toBe(nodeIds.length);
      expect(new Set(edgeIds).size, `${blueprint.id} has duplicate edge ids`).toBe(edgeIds.length);
    }
  });
});
