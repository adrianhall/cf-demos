import { describe, expect, it } from 'vitest';
import { parseClientFrame } from '../../src/worker/domain/client-frame.ts';
import { expectProblemStatus } from './problem-details.ts';

/**
 * @file Covers the one place the application accepts input from a browser over a socket. This is a
 *   trust boundary, so the tests are mostly about refusal. The positive cases establish that a
 *   well-formed frame survives intact; everything else establishes that a malformed one is refused
 *   rather than reaching the graph as `undefined` — which is the failure that matters, because an
 *   operation with a missing field would otherwise change nothing while reporting success.
 */

/**
 * Builds a raw operation frame payload.
 *
 * @param operation Operation payload to embed.
 * @param operationId Client operation id.
 * @returns The serialized frame, as a client would send it.
 */
function frame(operation: unknown, operationId = 'op-1'): string {
  return JSON.stringify({ operation, operationId, type: 'operation' });
}

describe('parseClientFrame', () => {
  it('accepts a resync request, which carries nothing', () => {
    expect(parseClientFrame(JSON.stringify({ type: 'resync' }))).toEqual({ type: 'resync' });
  });

  it('accepts finite cursor coordinates without an asserted identity', () => {
    expect(parseClientFrame(JSON.stringify({ type: 'cursor_moved', x: 12.5, y: -8 }))).toEqual({
      type: 'cursor_moved',
      x: 12.5,
      y: -8
    });
  });

  it.each([
    ['a selected node', { edgeId: null, nodeId: 'api', type: 'selection_changed' }],
    ['a selected edge', { edgeId: 'link', nodeId: null, type: 'selection_changed' }],
    ['a cleared selection', { edgeId: null, nodeId: null, type: 'selection_changed' }]
  ])('accepts %s awareness selection', (_label, value) => {
    expect(parseClientFrame(JSON.stringify(value))).toEqual(value);
  });

  it.each([
    ['a cursor with a missing coordinate', { type: 'cursor_moved', x: 1 }],
    [
      'a cursor with an infinite coordinate serialized as null',
      { type: 'cursor_moved', x: null, y: 1 }
    ],
    [
      'a selection naming node and edge',
      { edgeId: 'link', nodeId: 'api', type: 'selection_changed' }
    ],
    ['a selection with a missing node field', { edgeId: null, type: 'selection_changed' }],
    ['a selection with a numeric edge id', { edgeId: 4, nodeId: null, type: 'selection_changed' }]
  ])('refuses %s', (_label, value) => {
    expectProblemStatus(() => parseClientFrame(JSON.stringify(value)), 400);
  });

  it.each([
    [
      'add_node',
      {
        input: { id: 'kv', label: 'Cache', position: { x: 1, y: 2 }, typeId: 'kv' },
        kind: 'add_node'
      }
    ],
    ['update_node', { kind: 'update_node', nodeId: 'api', patch: { label: 'Gateway' } }],
    ['remove_node', { kind: 'remove_node', nodeId: 'api' }],
    [
      'add_edge',
      { input: { edgeType: 'data-flow', source: 'api', target: 'db' }, kind: 'add_edge' }
    ],
    ['update_edge', { edgeId: 'link', kind: 'update_edge', patch: { label: 'reads' } }],
    ['remove_edge', { edgeId: 'link', kind: 'remove_edge' }],
    ['auto_layout', { kind: 'auto_layout' }]
  ])('accepts a well-formed %s operation', (_label, operation) => {
    expect(parseClientFrame(frame(operation))).toEqual({
      operation,
      operationId: 'op-1',
      type: 'operation'
    });
  });

  // Every optional field of every operation, because each is an independent branch and a dropped
  // one would be an edit the client made and the server silently did not.
  it.each([
    [
      'add_node',
      {
        input: {
          description: 'Edge cache',
          id: 'kv',
          label: 'Cache',
          position: { x: 1, y: 2 },
          typeId: 'kv'
        },
        kind: 'add_node'
      }
    ],
    [
      'update_node',
      {
        kind: 'update_node',
        nodeId: 'api',
        patch: { description: 'The front door', label: 'Gateway', position: { x: 3, y: 4 } }
      }
    ],
    [
      'add_edge',
      {
        input: {
          description: 'Reads the cache',
          edgeType: 'data-flow',
          id: 'link',
          label: 'reads',
          protocol: 'http',
          source: 'api',
          target: 'db'
        },
        kind: 'add_edge'
      }
    ],
    [
      'update_edge',
      {
        edgeId: 'link',
        kind: 'update_edge',
        patch: {
          description: 'Now over a binding',
          edgeType: 'service-binding',
          label: 'calls',
          protocol: 'binding'
        }
      }
    ]
  ])('keeps every optional field a client supplied on %s', (_label, operation) => {
    expect(parseClientFrame(frame(operation))).toEqual({
      operation,
      operationId: 'op-1',
      type: 'operation'
    });
  });

  it('omits an optional field the client did not send, rather than writing undefined', () => {
    const parsed = parseClientFrame(
      frame({ input: { edgeType: 'data-flow', source: 'a', target: 'b' }, kind: 'add_edge' })
    );

    // Present-but-undefined and absent are different things downstream: the mutations treat an
    // absent patch field as "leave it alone", and an explicit `undefined` would be indistinguishable
    // from a client asking to clear it.
    expect(Object.keys((parsed as { operation: { input: object } }).operation.input)).toEqual([
      'edgeType',
      'source',
      'target'
    ]);
  });

  // The wire protocol has no author field. A payload that invents one is refused rather than
  // quietly stripped, so the attempt is visible to whoever made it.
  it.each(['actor', 'author', 'viewer', 'origin', 'ownerEmail'])(
    'refuses an operation asserting its own %s',
    (field) => {
      expectProblemStatus(
        () => parseClientFrame(frame({ [field]: 'alice@example.com', kind: 'auto_layout' })),
        400
      );
    }
  );

  it.each([
    ['a binary frame', new ArrayBuffer(8)],
    ['text that is not JSON', 'not json at all'],
    ['a JSON array', '[]'],
    ['JSON null', 'null'],
    ['a JSON string', '"hello"']
  ])('refuses %s', (_label, payload) => {
    expectProblemStatus(() => parseClientFrame(payload as string | ArrayBuffer), 400);
  });

  it.each([
    ['no type', JSON.stringify({})],
    ['an unknown type', JSON.stringify({ type: 'presence' })],
    [
      'an operation with no id',
      JSON.stringify({ operation: { kind: 'auto_layout' }, type: 'operation' })
    ],
    [
      'an operation with an empty id',
      JSON.stringify({ operation: { kind: 'auto_layout' }, operationId: '', type: 'operation' })
    ],
    [
      'an operation id that is not a string',
      JSON.stringify({ operation: { kind: 'auto_layout' }, operationId: 7, type: 'operation' })
    ]
  ])('refuses a frame with %s', (_label, payload) => {
    expectProblemStatus(() => parseClientFrame(payload), 400);
  });

  it.each([
    ['an operation that is not an object', frame('remove everything')],
    ['no operation at all', JSON.stringify({ operationId: 'x', type: 'operation' })],
    ['an unknown operation kind', frame({ kind: 'drop_database' })],
    ['no kind', frame({ nodeId: 'api' })],
    ['remove_node with no nodeId', frame({ kind: 'remove_node' })],
    ['remove_node with an empty nodeId', frame({ kind: 'remove_node', nodeId: '' })],
    ['update_node with no nodeId', frame({ kind: 'update_node', patch: {} })],
    ['remove_edge with no edgeId', frame({ kind: 'remove_edge' })],
    ['update_edge with no edgeId', frame({ kind: 'update_edge', patch: {} })],
    [
      'add_node with no label',
      frame({ input: { position: { x: 0, y: 0 }, typeId: 'kv' }, kind: 'add_node' })
    ],
    [
      'add_node with no typeId',
      frame({ input: { label: 'x', position: { x: 0, y: 0 } }, kind: 'add_node' })
    ],
    ['add_node with no position', frame({ input: { label: 'x', typeId: 'kv' }, kind: 'add_node' })],
    ['add_node with no input', frame({ kind: 'add_node' })],
    [
      'add_edge with no source',
      frame({ input: { edgeType: 'data-flow', target: 'b' }, kind: 'add_edge' })
    ],
    [
      'add_edge with no target',
      frame({ input: { edgeType: 'data-flow', source: 'a' }, kind: 'add_edge' })
    ],
    ['add_edge with no edgeType', frame({ input: { source: 'a', target: 'b' }, kind: 'add_edge' })],
    ['add_edge with no input', frame({ kind: 'add_edge' })]
  ])('refuses %s', (_label, payload) => {
    expectProblemStatus(() => parseClientFrame(payload), 400);
  });

  // A field that is present but the wrong type means the client meant to set something. Treating
  // it as absent would silently lose the edit, so it is refused instead.
  it.each([
    ['a non-string label', frame({ kind: 'update_node', nodeId: 'a', patch: { label: 7 } })],
    [
      'a non-string edge label',
      frame({ edgeId: 'e', kind: 'update_edge', patch: { label: { text: 'x' } } })
    ],
    [
      'a non-string node id in add_node',
      frame({
        input: { id: 9, label: 'x', position: { x: 0, y: 0 }, typeId: 'kv' },
        kind: 'add_node'
      })
    ]
  ])('refuses %s', (_label, payload) => {
    expectProblemStatus(() => parseClientFrame(payload), 400);
  });

  // `NaN` and `Infinity` both pass a `typeof 'number'` check and both place a node where React
  // Flow cannot draw it, so the check is for finiteness rather than for type.
  it.each([
    ['a string coordinate', { x: 'left', y: 0 }],
    ['a missing coordinate', { x: 0 }],
    ['a non-object position', 'centre'],
    // `Infinity` has no JSON literal, so it reaches a real server as `null` — which is exactly
    // what a client sending one would produce, and must be refused the same way.
    ['a null coordinate, which is what JSON makes of Infinity', { x: null, y: 0 }],
    ['a boolean coordinate', { x: true, y: 0 }]
  ])('refuses a node position with %s', (_label, position) => {
    expectProblemStatus(
      () =>
        parseClientFrame(
          frame({ input: { label: 'x', position, typeId: 'kv' }, kind: 'add_node' })
        ),
      400
    );
  });

  it('refuses a malformed position in an update patch too', () => {
    expectProblemStatus(
      () =>
        parseClientFrame(
          frame({ kind: 'update_node', nodeId: 'a', patch: { position: { x: 0, y: 'down' } } })
        ),
      400
    );
  });

  // An operation whose payload is the wrong shape entirely is refused rather than being read as
  // an empty patch, which would be a successful write that changed nothing.
  it('treats a non-object patch as empty rather than failing, since every field is optional', () => {
    expect(
      parseClientFrame(frame({ kind: 'update_node', nodeId: 'a', patch: 'everything' }))
    ).toMatchObject({ operation: { kind: 'update_node', nodeId: 'a', patch: {} } });
  });
});
