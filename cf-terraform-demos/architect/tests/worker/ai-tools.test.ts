import { describe, expect, it } from 'vitest';
import { EDGE_TYPES, NODE_TYPES } from '../../src/catalog.ts';
import { dispatchToolCall, TOOL_DEFINITIONS } from '../../src/worker/domain/ai/tools.ts';
import { applyGraphOperation } from '../../src/worker/domain/graph-operations.ts';
import type { GraphData } from '../../src/worker/domain/graph.ts';

/**
 * @file Covers the tool catalogue and its dispatcher. Two properties matter more than the rest and
 *   both are asserted for every tool: that a dispatched graph tool produces an operation
 *   `applyGraphOperation()` genuinely accepts — not merely one that type-checks — and that every
 *   refusal arrives as a value rather than a throw, because a thrown refusal ends a chat turn on a
 *   mistake the model could have corrected within it. The catalogue values used below are read from
 *   `src/catalog.ts` rather than written as literals, so a future catalogue edit cannot leave these
 *   tests passing against ids the application no longer has.
 */

/**
 * First real node type id in the live catalogue.
 */
const REAL_NODE_TYPE_ID = NODE_TYPES[0].typeId;

/**
 * First real edge type id in the live catalogue.
 */
const REAL_EDGE_TYPE = EDGE_TYPES[0].edgeType;

/**
 * An empty canonical graph.
 *
 * @returns A fresh graph, so a test cannot affect another through a shared object.
 */
function emptyGraph(): GraphData {
  return { edges: [], nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
}

/**
 * A graph with two nodes, `a` and `b`, and no edges.
 *
 * @returns A fresh graph.
 */
function twoNodeGraph(): GraphData {
  return {
    edges: [],
    nodes: [
      {
        data: { description: '', label: 'API', typeId: REAL_NODE_TYPE_ID },
        id: 'a',
        position: { x: 0, y: 0 },
        type: 'cf-node'
      },
      {
        data: { description: '', label: 'Database', typeId: 'd1' },
        id: 'b',
        position: { x: 100, y: 100 },
        type: 'cf-node'
      }
    ],
    viewport: { x: 0, y: 0, zoom: 1 }
  };
}

/**
 * The two-node graph plus one edge, `e1`, running from `a` to `b`.
 *
 * @returns A fresh graph.
 */
function graphWithEdge(): GraphData {
  return {
    ...twoNodeGraph(),
    edges: [
      {
        data: { edgeType: REAL_EDGE_TYPE, label: 'Query' },
        id: 'e1',
        source: 'a',
        target: 'b',
        type: 'cf-edge'
      }
    ]
  };
}

/**
 * Asserts a dispatch produced a graph operation and returns it.
 *
 * Narrowing through a helper keeps each test's own body about the operation it expected rather than
 * about proving the union member.
 *
 * @param result The dispatcher's result.
 * @returns The operation the result carries.
 * @throws {Error} When the result was not a `graph_operation`, which fails the calling test.
 */
function expectOperation(result: ReturnType<typeof dispatchToolCall>) {
  if (result.kind !== 'graph_operation') {
    throw new Error(`Expected a graph_operation result, got "${result.kind}".`);
  }
  return result.operation;
}

/**
 * Asserts a dispatch was refused and returns the message.
 *
 * @param result The dispatcher's result.
 * @returns The refusal message.
 * @throws {Error} When the result was not a `tool_error`, which fails the calling test.
 */
function expectToolError(result: ReturnType<typeof dispatchToolCall>): string {
  if (result.kind !== 'tool_error') {
    throw new Error(`Expected a tool_error result, got "${result.kind}".`);
  }
  return result.message;
}

describe('TOOL_DEFINITIONS', () => {
  it('advertises exactly the eight tools the dispatcher handles', () => {
    expect(TOOL_DEFINITIONS.map((tool) => tool.name).sort()).toEqual([
      'add_edge',
      'add_node',
      'remove_edge',
      'remove_node',
      'rename_diagram',
      'search_cloudflare_documentation',
      'update_edge',
      'update_node'
    ]);
  });

  it('gives every tool a description and a JSON Schema object', () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.parameters).toMatchObject({ type: 'object' });
    }
  });

  it('describes every field, since a field with no description is one a model guesses at', () => {
    for (const tool of TOOL_DEFINITIONS) {
      const properties = tool.parameters.properties as
        | Record<string, { description?: string }>
        | undefined;
      if (properties === undefined) {
        continue;
      }
      for (const [field, schema] of Object.entries(properties)) {
        expect(schema.description, `${tool.name}.${field}`).toBeTruthy();
      }
    }
  });

  it('strips the two keywords the inference call does not take', () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.parameters).not.toHaveProperty('$schema');
      expect(tool.parameters).not.toHaveProperty('additionalProperties');
    }
  });

  it('does not offer update_node a typeId, which NodePatch cannot apply', () => {
    const updateNode = TOOL_DEFINITIONS.find((tool) => tool.name === 'update_node');
    const properties = updateNode?.parameters.properties as Record<string, unknown>;

    expect(Object.keys(properties).sort()).toEqual(['description', 'label', 'nodeId', 'position']);
  });
});

describe('dispatchToolCall: add_node', () => {
  it('produces an add_node operation carrying the position the call named', () => {
    const result = dispatchToolCall(
      'add_node',
      {
        description: 'The API gateway',
        label: 'API',
        position: { x: 10, y: 20 },
        typeId: REAL_NODE_TYPE_ID
      },
      emptyGraph()
    );

    expect(result).toEqual({
      kind: 'graph_operation',
      operation: {
        input: {
          description: 'The API gateway',
          label: 'API',
          position: { x: 10, y: 20 },
          typeId: REAL_NODE_TYPE_ID
        },
        kind: 'add_node'
      }
    });
  });

  it('assigns a grid position when the call omits one', () => {
    const operation = expectOperation(
      dispatchToolCall('add_node', { label: 'API', typeId: REAL_NODE_TYPE_ID }, emptyGraph())
    );

    if (operation.kind !== 'add_node') {
      throw new Error('Expected an add_node operation.');
    }
    expect(operation.input.position).toEqual({ x: 0, y: 0 });
  });

  it('produces an operation applyGraphOperation actually accepts', () => {
    const graph = emptyGraph();
    const operation = expectOperation(
      dispatchToolCall('add_node', { label: 'API', typeId: REAL_NODE_TYPE_ID }, graph)
    );

    const applied = applyGraphOperation(graph, operation);

    expect(applied.nodes).toHaveLength(1);
    expect(applied.nodes[0]).toMatchObject({ data: { label: 'API', typeId: REAL_NODE_TYPE_ID } });
  });

  it('refuses an unrecognised typeId with a message naming the valid values', () => {
    const message = expectToolError(
      dispatchToolCall('add_node', { label: 'API', typeId: 'not-a-real-type' }, emptyGraph())
    );

    expect(message).toContain('not-a-real-type');
    expect(message).toContain(REAL_NODE_TYPE_ID);
    // Every valid id, not a sample: the list is what lets the model correct itself.
    for (const node of NODE_TYPES) {
      expect(message).toContain(node.typeId);
    }
  });

  it('refuses a call missing a required field', () => {
    expect(
      expectToolError(dispatchToolCall('add_node', { typeId: REAL_NODE_TYPE_ID }, emptyGraph()))
    ).toContain('label');
  });

  it('refuses a call whose field is of the wrong type', () => {
    expect(
      expectToolError(
        dispatchToolCall('add_node', { label: 42, typeId: REAL_NODE_TYPE_ID }, emptyGraph())
      )
    ).toContain('label');
  });
});

describe('dispatchToolCall: update_node', () => {
  it('produces an update_node operation whose patch matches NodePatch', () => {
    const result = dispatchToolCall(
      'update_node',
      { description: 'Updated', label: 'New Label', nodeId: 'a' },
      twoNodeGraph()
    );

    expect(result).toEqual({
      kind: 'graph_operation',
      operation: {
        kind: 'update_node',
        nodeId: 'a',
        patch: { description: 'Updated', label: 'New Label', position: undefined }
      }
    });
  });

  it('produces an operation applyGraphOperation actually accepts', () => {
    const graph = twoNodeGraph();
    const operation = expectOperation(
      dispatchToolCall('update_node', { label: 'Gateway', nodeId: 'a' }, graph)
    );

    expect(applyGraphOperation(graph, operation).nodes[0]).toMatchObject({
      data: { label: 'Gateway' }
    });
  });

  it('refuses a call with no nodeId', () => {
    expect(
      expectToolError(dispatchToolCall('update_node', { label: 'New' }, twoNodeGraph()))
    ).toContain('nodeId');
  });
});

describe('dispatchToolCall: remove_node', () => {
  it('produces a remove_node operation', () => {
    expect(dispatchToolCall('remove_node', { nodeId: 'a' }, twoNodeGraph())).toEqual({
      kind: 'graph_operation',
      operation: { kind: 'remove_node', nodeId: 'a' }
    });
  });

  it('produces an operation applyGraphOperation actually accepts', () => {
    const graph = graphWithEdge();
    const operation = expectOperation(dispatchToolCall('remove_node', { nodeId: 'a' }, graph));
    const applied = applyGraphOperation(graph, operation);

    expect(applied.nodes).toHaveLength(1);
    expect(applied.edges).toHaveLength(0);
  });

  it('refuses a call with no nodeId', () => {
    expect(expectToolError(dispatchToolCall('remove_node', {}, twoNodeGraph()))).toContain(
      'nodeId'
    );
  });
});

describe('dispatchToolCall: add_edge', () => {
  it('produces an add_edge operation', () => {
    expect(
      dispatchToolCall(
        'add_edge',
        { edgeType: REAL_EDGE_TYPE, source: 'a', target: 'b' },
        twoNodeGraph()
      )
    ).toEqual({
      kind: 'graph_operation',
      operation: {
        input: {
          description: undefined,
          edgeType: REAL_EDGE_TYPE,
          label: undefined,
          protocol: undefined,
          source: 'a',
          target: 'b'
        },
        kind: 'add_edge'
      }
    });
  });

  it('produces an operation applyGraphOperation actually accepts', () => {
    const graph = twoNodeGraph();
    const operation = expectOperation(
      dispatchToolCall(
        'add_edge',
        { edgeType: REAL_EDGE_TYPE, label: 'Query', source: 'a', target: 'b' },
        graph
      )
    );
    const applied = applyGraphOperation(graph, operation);

    expect(applied.edges).toHaveLength(1);
    expect(applied.edges[0]).toMatchObject({ source: 'a', target: 'b' });
  });

  it('refuses an unrecognised edgeType with a message naming the valid values', () => {
    const message = expectToolError(
      dispatchToolCall(
        'add_edge',
        { edgeType: 'not-a-real-edge-type', source: 'a', target: 'b' },
        twoNodeGraph()
      )
    );

    expect(message).toContain('not-a-real-edge-type');
    for (const edge of EDGE_TYPES) {
      expect(message).toContain(edge.edgeType);
    }
  });

  it('refuses a call missing an endpoint', () => {
    expect(
      expectToolError(
        dispatchToolCall('add_edge', { edgeType: REAL_EDGE_TYPE, source: 'a' }, twoNodeGraph())
      )
    ).toContain('target');
  });
});

describe('dispatchToolCall: update_edge', () => {
  it('produces an update_edge operation whose patch matches EdgePatch', () => {
    expect(
      dispatchToolCall('update_edge', { edgeId: 'e1', label: 'New label' }, graphWithEdge())
    ).toEqual({
      kind: 'graph_operation',
      operation: {
        edgeId: 'e1',
        kind: 'update_edge',
        patch: {
          description: undefined,
          edgeType: undefined,
          label: 'New label',
          protocol: undefined
        }
      }
    });
  });

  it('produces an operation applyGraphOperation actually accepts', () => {
    const graph = graphWithEdge();
    const operation = expectOperation(
      dispatchToolCall('update_edge', { edgeId: 'e1', label: 'Reads' }, graph)
    );

    expect(applyGraphOperation(graph, operation).edges[0]).toMatchObject({
      data: { label: 'Reads' }
    });
  });

  it('accepts a real edgeType on a patch', () => {
    const operation = expectOperation(
      dispatchToolCall('update_edge', { edgeId: 'e1', edgeType: REAL_EDGE_TYPE }, graphWithEdge())
    );

    if (operation.kind !== 'update_edge') {
      throw new Error('Expected an update_edge operation.');
    }
    expect(operation.patch.edgeType).toBe(REAL_EDGE_TYPE);
  });

  it('refuses an unrecognised edgeType on a patch', () => {
    const message = expectToolError(
      dispatchToolCall(
        'update_edge',
        { edgeId: 'e1', edgeType: 'not-a-real-edge-type' },
        graphWithEdge()
      )
    );

    expect(message).toContain('not-a-real-edge-type');
    expect(message).toContain(REAL_EDGE_TYPE);
  });

  it('refuses a call with no edgeId', () => {
    expect(
      expectToolError(dispatchToolCall('update_edge', { label: 'New' }, graphWithEdge()))
    ).toContain('edgeId');
  });
});

describe('dispatchToolCall: remove_edge', () => {
  it('produces a remove_edge operation', () => {
    expect(dispatchToolCall('remove_edge', { edgeId: 'e1' }, graphWithEdge())).toEqual({
      kind: 'graph_operation',
      operation: { edgeId: 'e1', kind: 'remove_edge' }
    });
  });

  it('produces an operation applyGraphOperation actually accepts', () => {
    const graph = graphWithEdge();
    const operation = expectOperation(dispatchToolCall('remove_edge', { edgeId: 'e1' }, graph));
    const applied = applyGraphOperation(graph, operation);

    expect(applied.edges).toHaveLength(0);
    expect(applied.nodes).toHaveLength(2);
  });

  it('refuses a call with no edgeId', () => {
    expect(expectToolError(dispatchToolCall('remove_edge', {}, graphWithEdge()))).toContain(
      'edgeId'
    );
  });
});

describe('dispatchToolCall: rename_diagram', () => {
  it('produces a rename_diagram result carrying both fields', () => {
    expect(
      dispatchToolCall(
        'rename_diagram',
        { description: 'A real-time strategy game backend', title: 'Game Backend' },
        emptyGraph()
      )
    ).toEqual({
      description: 'A real-time strategy game backend',
      kind: 'rename_diagram',
      title: 'Game Backend'
    });
  });

  it('accepts a title alone', () => {
    expect(dispatchToolCall('rename_diagram', { title: 'Game Backend' }, emptyGraph())).toEqual({
      description: undefined,
      kind: 'rename_diagram',
      title: 'Game Backend'
    });
  });

  it('accepts a null description, which clears it', () => {
    expect(dispatchToolCall('rename_diagram', { description: null }, emptyGraph())).toEqual({
      description: null,
      kind: 'rename_diagram',
      title: undefined
    });
  });

  it('refuses a call naming neither field, which is not a rename', () => {
    expect(expectToolError(dispatchToolCall('rename_diagram', {}, emptyGraph()))).toContain(
      'rename_diagram requires'
    );
  });
});

describe('dispatchToolCall: search_cloudflare_documentation', () => {
  it('produces a search result carrying the query', () => {
    expect(
      dispatchToolCall(
        'search_cloudflare_documentation',
        { query: 'Durable Objects WebSocket hibernation' },
        emptyGraph()
      )
    ).toEqual({
      kind: 'search_cloudflare_documentation',
      query: 'Durable Objects WebSocket hibernation'
    });
  });

  it('refuses a call with no query', () => {
    expect(
      expectToolError(dispatchToolCall('search_cloudflare_documentation', {}, emptyGraph()))
    ).toContain('query');
  });

  it('refuses an empty query', () => {
    expect(
      expectToolError(
        dispatchToolCall('search_cloudflare_documentation', { query: '' }, emptyGraph())
      )
    ).toContain('query');
  });
});

describe('dispatchToolCall: an invented tool', () => {
  it('refuses a tool name no tool has, rather than throwing', () => {
    expect(expectToolError(dispatchToolCall('delete_everything', {}, emptyGraph()))).toContain(
      'delete_everything'
    );
  });

  it('refuses a non-object arguments value', () => {
    // The model's arguments arrive as a JSON string the caller parses; a string or a number is a
    // shape zod must refuse rather than a shape this module should trust.
    expect(expectToolError(dispatchToolCall('add_node', 'not an object', emptyGraph()))).toContain(
      'add_node'
    );
  });
});
