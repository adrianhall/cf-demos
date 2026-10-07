import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import type { CFEdgeData, CFNodeData } from '../../src/client/components/editor/types.ts';

vi.mock('@xyflow/react', () => import('./mock-xyflow.tsx'));

const { useDiagramStore } = await import('../../src/client/stores/diagramStore.ts');

/**
 * @file Covers the editor's whole client-side state. The store is where the dirty flag, the undo
 *   history and the selection are kept in step, so every canvas mutation goes through it — and a
 *   rule that only held in a component would be one a later caller could bypass. These tests drive
 *   the actions directly for that reason: they are the contract the components rely on.
 */

/**
 * Builds a minimal node.
 *
 * @param id Node id.
 * @param typeId Catalogue type, defaulting to Workers.
 * @returns The node.
 */
function makeNode(id: string, typeId = 'worker'): Node<CFNodeData> {
  return { data: { label: typeId, typeId }, id, position: { x: 0, y: 0 }, type: 'cf-node' };
}

/**
 * Builds a minimal edge.
 *
 * @param id Edge id.
 * @param source Source node id.
 * @param target Target node id.
 * @returns The edge.
 */
function makeEdge(id: string, source = 'a', target = 'b'): Edge<CFEdgeData> {
  return { data: { edgeType: 'data-flow' }, id, source, target } as Edge<CFEdgeData>;
}

beforeEach(() => {
  localStorage.clear();
  useDiagramStore.setState({
    description: '',
    diagramId: null,
    dirty: false,
    detailsPanelExpanded: false,
    edges: [],
    lastSavedAt: null,
    minimapOpen: true,
    nodes: [],
    paletteOpen: true,
    printMode: false,
    propertiesOpen: false,
    redoStack: [],
    saveError: null,
    saving: false,
    selectedEdgeId: null,
    selectedNodeId: null,
    title: 'Untitled Diagram',
    undoStack: [],
    viewport: { x: 0, y: 0, zoom: 1 }
  });
});

describe('loading a diagram', () => {
  it('replaces the whole session and clears dirty state and history', () => {
    useDiagramStore.getState().addNode(makeNode('a'));

    useDiagramStore
      .getState()
      .setDiagram('diagram-1', 'My Diagram', 'A description', [makeNode('b')], [], {
        x: 1,
        y: 2,
        zoom: 1.5
      });

    const state = useDiagramStore.getState();

    expect(state.diagramId).toBe('diagram-1');
    expect(state.title).toBe('My Diagram');
    expect(state.description).toBe('A description');
    expect(state.nodes.map((node) => node.id)).toEqual(['b']);
    expect(state.viewport).toEqual({ x: 1, y: 2, zoom: 1.5 });
    // A freshly loaded diagram matches what the server holds, so there is nothing to save and
    // nothing to undo back to — an undo entry from the previous diagram would restore a graph
    // belonging to a different document entirely.
    expect(state.dirty).toBe(false);
    expect(state.undoStack).toHaveLength(0);
    expect(state.redoStack).toHaveLength(0);
  });
});

describe('graph mutations', () => {
  it('adds a node, marks the diagram dirty, and records an undo entry', () => {
    useDiagramStore.getState().addNode(makeNode('a'));

    const state = useDiagramStore.getState();

    expect(state.nodes).toHaveLength(1);
    expect(state.dirty).toBe(true);
    expect(state.undoStack).toHaveLength(1);
  });

  it('merges partial data into one node and leaves the others alone', () => {
    useDiagramStore.getState().addNode(makeNode('a'));
    const untouched = makeNode('b');
    useDiagramStore.getState().addNode(untouched);

    useDiagramStore.getState().updateNodeData('a', { label: 'Renamed' });

    const nodes = useDiagramStore.getState().nodes;

    expect(nodes.find((node) => node.id === 'a')?.data.label).toBe('Renamed');
    expect(nodes.find((node) => node.id === 'b')?.data).toEqual(untouched.data);
  });

  it('merges partial data into one edge and leaves the others alone', () => {
    const untouched = makeEdge('e2', 'b', 'c');
    useDiagramStore.setState({ edges: [makeEdge('e1'), untouched] });

    useDiagramStore.getState().updateEdgeData('e1', { label: 'New label' });

    const edges = useDiagramStore.getState().edges;

    expect(edges.find((edge) => edge.id === 'e1')?.data?.label).toBe('New label');
    expect(edges.find((edge) => edge.id === 'e2')?.data).toEqual(untouched.data);
  });

  it('removes only the selected nodes and edges, and clears the selection', () => {
    useDiagramStore.setState({
      edges: [
        { ...makeEdge('e1'), selected: true },
        { ...makeEdge('e2', 'b', 'a'), selected: false }
      ],
      nodes: [
        { ...makeNode('a'), selected: true },
        { ...makeNode('b'), selected: false }
      ]
    });

    useDiagramStore.getState().removeSelected();

    const state = useDiagramStore.getState();

    expect(state.nodes.map((node) => node.id)).toEqual(['b']);
    expect(state.edges.map((edge) => edge.id)).toEqual(['e2']);
    expect(state.selectedNodeId).toBeNull();
    expect(state.selectedEdgeId).toBeNull();
  });

  it('replaces the node and edge arrays wholesale for auto-layout', () => {
    useDiagramStore.getState().setNodes([makeNode('z')]);
    useDiagramStore.getState().setEdges([makeEdge('e9')]);

    const state = useDiagramStore.getState();

    expect(state.nodes.map((node) => node.id)).toEqual(['z']);
    expect(state.edges.map((edge) => edge.id)).toEqual(['e9']);
    expect(state.dirty).toBe(true);
  });
});

describe('React Flow change handlers', () => {
  // Dragging a node fires a position change on every pointer move. Recording undo history for each
  // would fill the stack with a hundred entries for one drag and make Ctrl+Z move the node a pixel
  // at a time.
  it('applies a position change without recording undo history', () => {
    useDiagramStore.getState().addNode(makeNode('a'));
    useDiagramStore.setState({ undoStack: [] });

    useDiagramStore
      .getState()
      .onNodesChange([{ id: 'a', position: { x: 5, y: 5 }, type: 'position' }]);

    expect(useDiagramStore.getState().undoStack).toHaveLength(0);
    expect(useDiagramStore.getState().dirty).toBe(true);
  });

  it('records undo history for a structural node change', () => {
    useDiagramStore.getState().addNode(makeNode('a'));
    useDiagramStore.setState({ undoStack: [] });

    useDiagramStore.getState().onNodesChange([{ id: 'a', type: 'remove' }]);

    expect(useDiagramStore.getState().nodes).toHaveLength(0);
    expect(useDiagramStore.getState().undoStack).toHaveLength(1);
  });

  it('records undo history for a structural edge change', () => {
    useDiagramStore.getState().onEdgesChange([{ item: makeEdge('e1'), type: 'add' }]);

    expect(useDiagramStore.getState().edges).toHaveLength(1);
    expect(useDiagramStore.getState().undoStack).toHaveLength(1);
  });

  it('applies a selection change to an edge without recording undo history', () => {
    useDiagramStore.setState({ edges: [makeEdge('e1')] });

    useDiagramStore.getState().onEdgesChange([{ id: 'e1', selected: true, type: 'select' }]);

    expect(useDiagramStore.getState().undoStack).toHaveLength(0);
  });

  // Panning and zooming change what the visitor is looking at, not what the diagram contains, so
  // they must not make the editor claim unsaved work or offer to undo them.
  it('stores a viewport change without marking the diagram dirty', () => {
    useDiagramStore.getState().onViewportChange({ x: 10, y: 20, zoom: 2 });

    const state = useDiagramStore.getState();

    expect(state.viewport).toEqual({ x: 10, y: 20, zoom: 2 });
    expect(state.dirty).toBe(false);
    expect(state.undoStack).toHaveLength(0);
  });

  it('creates a data-flow edge from a pointer-drag connection', () => {
    useDiagramStore
      .getState()
      .onConnect({ source: 'a', sourceHandle: null, target: 'b', targetHandle: null });

    const edges = useDiagramStore.getState().edges;

    expect(edges).toHaveLength(1);
    expect(edges[0]?.data).toEqual({ edgeType: 'data-flow' });
    expect(useDiagramStore.getState().undoStack).toHaveLength(1);
  });
});

describe('connectNodes', () => {
  beforeEach(() => {
    useDiagramStore.setState({
      nodes: [
        { ...makeNode('a'), position: { x: 0, y: 0 } },
        { ...makeNode('b'), position: { x: 300, y: 0 } }
      ]
    });
  });

  it('creates an edge with resolved handles and selects it', () => {
    const newId = useDiagramStore.getState().connectNodes('a', 'b', 'data-flow');

    const state = useDiagramStore.getState();

    expect(newId).not.toBeNull();
    expect(state.edges[0]).toMatchObject({
      data: { edgeType: 'data-flow' },
      id: newId,
      source: 'a',
      sourceHandle: 'source-right',
      target: 'b',
      targetHandle: 'target-left',
      type: 'cf-edge'
    });
    expect(state.dirty).toBe(true);
    expect(state.undoStack).toHaveLength(1);
    // Selecting the new edge opens the properties panel on it, so the visitor lands on the fields
    // for the thing they just created rather than having to find it on the canvas.
    expect(state.selectedEdgeId).toBe(newId);
    expect(state.propertiesOpen).toBe(true);
  });

  it('allows a second edge of a different type between the same nodes', () => {
    useDiagramStore.getState().connectNodes('a', 'b', 'data-flow');

    expect(useDiagramStore.getState().connectNodes('a', 'b', 'trigger')).not.toBeNull();
    expect(useDiagramStore.getState().edges).toHaveLength(2);
  });

  it('refuses a self-connection and changes nothing', () => {
    expect(useDiagramStore.getState().connectNodes('a', 'a', 'data-flow')).toBeNull();

    const state = useDiagramStore.getState();

    expect(state.edges).toHaveLength(0);
    expect(state.undoStack).toHaveLength(0);
    expect(state.dirty).toBe(false);
  });

  it('refuses an exact duplicate and changes nothing', () => {
    useDiagramStore.getState().connectNodes('a', 'b', 'data-flow');
    useDiagramStore.setState({ dirty: false, undoStack: [] });

    expect(useDiagramStore.getState().connectNodes('a', 'b', 'data-flow')).toBeNull();

    const state = useDiagramStore.getState();

    expect(state.edges).toHaveLength(1);
    expect(state.dirty).toBe(false);
    expect(state.undoStack).toHaveLength(0);
  });

  it('refuses a connection to a node that is not on the canvas', () => {
    expect(useDiagramStore.getState().connectNodes('a', 'gone', 'data-flow')).toBeNull();
    expect(useDiagramStore.getState().edges).toHaveLength(0);
  });
});

describe('selection', () => {
  it('holds one selection at a time across nodes and edges', () => {
    useDiagramStore.getState().setSelectedNode('a');

    expect(useDiagramStore.getState().selectedNodeId).toBe('a');

    useDiagramStore.getState().setSelectedEdge('e1');

    expect(useDiagramStore.getState().selectedEdgeId).toBe('e1');
    expect(useDiagramStore.getState().selectedNodeId).toBeNull();
  });

  it.each([
    ['a node', (): void => useDiagramStore.getState().setSelectedNode('a')],
    ['an edge', (): void => useDiagramStore.getState().setSelectedEdge('e1')]
  ])('opens the properties panel when %s is selected', (_description, select) => {
    expect(useDiagramStore.getState().propertiesOpen).toBe(false);

    select();

    expect(useDiagramStore.getState().propertiesOpen).toBe(true);
  });

  // Closing the panel on every deselection would mean a visitor who clicks the canvas between two
  // selections has to reopen it each time. It stays open showing its empty state instead.
  it('leaves the panel open when the selection is cleared', () => {
    useDiagramStore.getState().setSelectedNode('a');
    useDiagramStore.getState().setSelectedNode(null);

    expect(useDiagramStore.getState().propertiesOpen).toBe(true);
  });

  it('does not open the panel when a selection is cleared while it is closed', () => {
    useDiagramStore.getState().setSelectedEdge(null);

    expect(useDiagramStore.getState().propertiesOpen).toBe(false);
  });
});

describe('panel preferences', () => {
  it('toggles the palette, the properties panel, and the minimap', () => {
    useDiagramStore.getState().togglePalette();
    useDiagramStore.getState().toggleProperties();
    useDiagramStore.getState().toggleMinimap();

    const state = useDiagramStore.getState();

    expect(state.paletteOpen).toBe(false);
    expect(state.propertiesOpen).toBe(true);
    expect(state.minimapOpen).toBe(false);
  });

  // Unlike every other panel flag, the width outlives the session: a visitor who widened the panel
  // to read a long description wants it wide the next time too.
  it('persists the details panel width so it survives a reload', () => {
    useDiagramStore.getState().toggleDetailsPanelExpanded();

    expect(useDiagramStore.getState().detailsPanelExpanded).toBe(true);
    expect(localStorage.getItem('details-panel-expanded')).toBe('true');

    useDiagramStore.getState().toggleDetailsPanelExpanded();

    expect(useDiagramStore.getState().detailsPanelExpanded).toBe(false);
    expect(localStorage.getItem('details-panel-expanded')).toBe('false');
  });
});

describe('metadata and save state', () => {
  it.each([
    ['the title', (): void => useDiagramStore.getState().setTitle('New Title')],
    ['the description', (): void => useDiagramStore.getState().setDescription('New description')]
  ])('marks the diagram dirty when %s changes', (_description, change) => {
    change();

    expect(useDiagramStore.getState().dirty).toBe(true);
  });

  it('moves through saving, saved, and failed states', () => {
    useDiagramStore.getState().markSaving();

    expect(useDiagramStore.getState().saving).toBe(true);

    useDiagramStore.getState().markSaved();

    let state = useDiagramStore.getState();

    expect(state.saving).toBe(false);
    expect(state.dirty).toBe(false);
    expect(state.lastSavedAt).not.toBeNull();

    useDiagramStore.getState().markSaveError('Network error');
    state = useDiagramStore.getState();

    expect(state.saving).toBe(false);
    expect(state.saveError).toBe('Network error');
  });

  // A new attempt starts from a clean slate: leaving the previous failure on screen beside a save
  // that is currently succeeding would report the wrong state.
  it('clears a previous failure when a new save begins', () => {
    useDiagramStore.getState().markSaveError('Network error');
    useDiagramStore.getState().markSaving();

    expect(useDiagramStore.getState().saveError).toBeNull();
  });

  it('toggles print mode', () => {
    useDiagramStore.getState().setPrintMode(true);

    expect(useDiagramStore.getState().printMode).toBe(true);

    useDiagramStore.getState().setPrintMode(false);

    expect(useDiagramStore.getState().printMode).toBe(false);
  });
});

describe('undo and redo', () => {
  it('undoes and redoes an added node', () => {
    useDiagramStore.getState().addNode(makeNode('a'));

    useDiagramStore.getState().undo();

    expect(useDiagramStore.getState().nodes).toHaveLength(0);
    expect(useDiagramStore.getState().redoStack).toHaveLength(1);

    useDiagramStore.getState().redo();

    expect(useDiagramStore.getState().nodes).toHaveLength(1);
    expect(useDiagramStore.getState().undoStack).toHaveLength(1);
  });

  it.each([
    ['undo', (): void => useDiagramStore.getState().undo()],
    ['redo', (): void => useDiagramStore.getState().redo()]
  ])('does nothing when there is no %s history', (_description, act) => {
    act();

    expect(useDiagramStore.getState().nodes).toHaveLength(0);
  });

  // A new edit invalidates whatever was undone: the visitor has chosen a different future, so
  // redoing into the old one would produce a graph that never existed.
  it('discards the redo history when a new change is made', () => {
    useDiagramStore.getState().addNode(makeNode('a'));
    useDiagramStore.getState().undo();

    expect(useDiagramStore.getState().redoStack).toHaveLength(1);

    useDiagramStore.getState().addNode(makeNode('b'));

    expect(useDiagramStore.getState().redoStack).toHaveLength(0);
  });

  // Each entry is a complete copy of the graph, so the stack is bounded: an unbounded one would
  // hold every version of a large diagram for as long as the tab is open.
  it('keeps at most fifty undo entries', () => {
    for (let index = 0; index < 60; index += 1) {
      useDiagramStore.getState().addNode(makeNode(`n${index}`));
    }

    expect(useDiagramStore.getState().undoStack).toHaveLength(50);
  });

  // Snapshots are deep copies: holding the same node objects would mean a later edit mutated the
  // history it was supposed to be able to return to.
  it('snapshots the graph rather than referencing the live nodes', () => {
    useDiagramStore.getState().addNode(makeNode('a'));
    useDiagramStore.getState().updateNodeData('a', { label: 'Renamed' });

    useDiagramStore.getState().undo();

    expect(useDiagramStore.getState().nodes[0]?.data.label).toBe('worker');
  });
});
