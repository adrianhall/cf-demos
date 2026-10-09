import { describe, expect, it } from 'vitest';
import { BLUEPRINT_MAP } from '../../src/blueprints.ts';
import { renderGraphSvg } from '../../src/worker/domain/graph-svg.ts';
import type { GraphData } from '../../src/worker/domain/graph.ts';

/**
 * @file Structural tests for the pure server-side SVG transform. These parse every generated
 *   document as XML rather than matching plausible-looking fragments. An unclosed tag, a raw `&`, a
 *   second root, or user text that escaped its `<text>` element all produce a parser error before
 *   an assertion can mistake the output for a real image.
 */

/**
 * Parses an exported document as SVG and proves the XML parser accepted it.
 *
 * `innerHTML` and a regex are both explicitly wrong here. HTML parsing recovers from malformed
 * markup — exactly what this test must detect — and a regex can say the string contains `<svg>`
 * without proving there is one valid XML document around it.
 *
 * @param source Complete SVG source from {@link renderGraphSvg}.
 * @returns The parsed root element.
 */
function parseSvg(source: string): Element {
  const document = new DOMParser().parseFromString(source, 'image/svg+xml');
  const errors = document.querySelectorAll('parsererror');

  expect(errors, errors[0]?.textContent ?? 'valid XML').toHaveLength(0);
  expect(document.documentElement.namespaceURI).toBe('http://www.w3.org/2000/svg');
  expect(document.documentElement.tagName).toBe('svg');
  return document.documentElement;
}

/**
 * Builds the smallest canonical graph useful to a test.
 *
 * @param nodes Nodes to include.
 * @param edges Edges to include.
 * @returns A canonical-shape graph with a neutral viewport; the viewport is intentionally ignored
 *   by the export because the file frames graph extents rather than the user's last pan and zoom.
 */
function graph(nodes: Record<string, unknown>[], edges: Record<string, unknown>[] = []): GraphData {
  return { edges, nodes, viewport: { x: 200, y: -50, zoom: 0.4 } };
}

describe('renderGraphSvg', () => {
  it('parses as a standalone image and carries an accessible title', () => {
    const svg = parseSvg(
      renderGraphSvg(
        graph([
          {
            data: { description: 'Runs the API', label: 'Gateway', typeId: 'worker' },
            id: 'gateway',
            position: { x: 10, y: 20 }
          }
        ]),
        { title: 'Checkout architecture' }
      )
    );

    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.querySelector(':scope > title')?.textContent).toBe('Checkout architecture');
    expect(svg.querySelectorAll(':scope > rect')).toHaveLength(1);
    expect(svg.querySelectorAll('g:last-child > rect')).toHaveLength(2);
    expect([...svg.querySelectorAll('text')].map((element) => element.textContent)).toEqual([
      'Gateway',
      'Workers',
      'Runs the API'
    ]);
  });

  it('escapes markup, ampersands and both quote forms without changing the parsed text', () => {
    const malicious = '<script>alert("x" & \'y\')</script>';
    const source = renderGraphSvg(
      graph(
        [
          {
            data: { label: malicious, typeId: 'worker' },
            id: 'source',
            position: { x: 0, y: 0 }
          },
          {
            data: { label: 'Target', typeId: 'd1' },
            id: 'target',
            position: { x: 0, y: 160 }
          }
        ],
        [
          {
            data: { edgeType: 'data-flow', label: malicious },
            id: 'edge',
            source: 'source',
            target: 'target'
          }
        ]
      ),
      { title: malicious }
    );
    const svg = parseSvg(source);

    expect(svg.querySelector('script')).toBeNull();
    expect(svg.querySelector('title')?.textContent).toBe(malicious);
    // The node and edge versions are both deliberately long enough to exercise truncation. What
    // matters is that the XML parser reconstructs their literal text rather than an element, and
    // that quote characters survive as characters rather than breaking an attribute.
    const textValues = [...svg.querySelectorAll('text')].map((element) => element.textContent);
    expect(
      textValues.filter((value) => value?.includes('<script>alert("x" &')).length
    ).toBeGreaterThan(0);
    expect(textValues.filter((value) => value?.includes("'y'")).length).toBeGreaterThan(0);
    expect(textValues.some((value) => value?.startsWith('<script>'))).toBe(true);
    expect(source).toContain(
      '&lt;script&gt;alert(&quot;x&quot; &amp; &apos;y&apos;)&lt;/script&gt;'
    );
    expect(source).not.toContain('<script>');
  });

  it('frames an empty graph with a positive, non-degenerate viewBox', () => {
    const svg = parseSvg(renderGraphSvg(graph([])));
    const values = svg.getAttribute('viewBox')?.split(' ').map(Number);

    expect(values).toEqual([-48, -48, 296, 150]);
    expect(Number(svg.getAttribute('width'))).toBeGreaterThan(0);
    expect(Number(svg.getAttribute('height'))).toBeGreaterThan(0);
    expect(svg.querySelectorAll('g:last-child > rect')).toHaveLength(0);
    expect(svg.querySelector('title')?.textContent).toBe('Architecture diagram');
  });

  it('computes extents from disconnected nodes at negative and positive coordinates', () => {
    const svg = parseSvg(
      renderGraphSvg(
        graph([
          {
            data: { label: 'Left', typeId: 'external-user' },
            id: 'left',
            position: { x: -220, y: -100 }
          },
          {
            data: { description: 'Far away', label: 'Right', typeId: 'r2' },
            id: 'right',
            position: { x: 400, y: 300 }
          }
        ])
      )
    );

    expect(svg.getAttribute('viewBox')).toBe('-268 -148 916 570');
    expect(svg.getAttribute('width')).toBe('916');
    expect(svg.getAttribute('height')).toBe('570');
  });

  it('renders catalogue edge colours, dash styles, markers and labels', () => {
    const nodes = [
      { data: { label: 'A', typeId: 'worker' }, id: 'a', position: { x: 0, y: 0 } },
      { data: { label: 'B', typeId: 'd1' }, id: 'b', position: { x: 0, y: 150 } },
      { data: { label: 'C', typeId: 'kv' }, id: 'c', position: { x: 260, y: 0 } },
      { data: { label: 'D', typeId: 'r2' }, id: 'd', position: { x: 260, y: 150 } }
    ];
    const svg = parseSvg(
      renderGraphSvg(
        graph(nodes, [
          {
            data: { edgeType: 'data-flow', label: 'HTTP' },
            id: 'data',
            source: 'a',
            target: 'b'
          },
          {
            data: { edgeType: 'service-binding' },
            id: 'binding',
            source: 'a',
            target: 'c'
          },
          {
            data: { edgeType: 'trigger' },
            id: 'trigger',
            source: 'c',
            target: 'd'
          },
          {
            data: { edgeType: 'external' },
            id: 'external',
            source: 'b',
            target: 'd'
          }
        ])
      )
    );
    const paths = [...svg.querySelectorAll(':scope > g:first-of-type > path')];

    expect(paths).toHaveLength(4);
    expect(paths[0]).toMatchObject({
      getAttribute: expect.any(Function) as () => string | null
    });
    expect(paths.map((path) => path.getAttribute('stroke'))).toEqual([
      '#F6821F',
      '#3B82F6',
      '#F59E0B',
      '#9CA3AF'
    ]);
    expect(paths.map((path) => path.getAttribute('stroke-dasharray'))).toEqual([
      null,
      '8 4',
      '3 3',
      null
    ]);
    expect(paths.map((path) => path.getAttribute('marker-end'))).toEqual([
      'url(#arrow-data-flow)',
      null,
      'url(#arrow-trigger)',
      'url(#arrow-external)'
    ]);
    expect([...svg.querySelectorAll('marker')].map((marker) => marker.id).sort()).toEqual([
      'arrow-data-flow',
      'arrow-external',
      'arrow-trigger'
    ]);
    expect([...svg.querySelectorAll('text')].map((element) => element.textContent)).toContain(
      'HTTP'
    );
  });

  // The horizontal cases carry the handle pair the **Connect nodes** dialog records, because that
  // is the only thing that makes an edge horizontal — see the `edge anchoring` block below. A
  // handle-less edge is vertical however the boxes sit, which `left` and `up` cover.
  it('routes straight and bent edges horizontally and vertically', () => {
    const svg = parseSvg(
      renderGraphSvg(
        graph(
          [
            { data: { label: 'A' }, id: 'a', position: { x: 0, y: 0 } },
            { data: { label: 'B' }, id: 'b', position: { x: 260, y: 0 } },
            { data: { label: 'C' }, id: 'c', position: { x: 520, y: 100 } },
            { data: { label: 'D' }, id: 'd', position: { x: 0, y: 160 } },
            { data: { label: 'E' }, id: 'e', position: { x: 100, y: 320 } },
            { data: { label: 'F' }, id: 'f', position: { x: -260, y: 0 } },
            { data: { label: 'G' }, id: 'g', position: { x: 0, y: -160 } }
          ],
          [
            {
              id: 'horizontal-straight',
              source: 'a',
              sourceHandle: 'source-right',
              target: 'b',
              targetHandle: 'target-left'
            },
            {
              id: 'horizontal-bent',
              source: 'b',
              sourceHandle: 'source-right',
              target: 'c',
              targetHandle: 'target-left'
            },
            { id: 'vertical-straight', source: 'a', target: 'd' },
            { id: 'vertical-bent', source: 'd', target: 'e' },
            { id: 'left', source: 'a', target: 'f' },
            { id: 'up', source: 'a', target: 'g' }
          ]
        )
      )
    );
    const paths = [...svg.querySelectorAll(':scope > g:first-of-type > path')].map((path) =>
      path.getAttribute('d')
    );

    expect(paths[0]).toBe('M 200 27 L 260 27');
    expect(paths[1]).toContain(' Q ');
    expect(paths[2]).toBe('M 100 54 L 100 160');
    expect(paths[3]).toContain(' Q ');
    // Leftward and upward edges record no handles — the catalogue offers none on those faces — so
    // both run vertically. The leftward one bends because the two boxes share no centre line.
    expect(paths[4]).toContain(' Q ');
    expect(paths[4]?.startsWith('M 100 54 ')).toBe(true);
    expect(paths[5]).toBe('M 100 0 L 100 -106');
  });

  it('degrades malformed but canonical-storable elements instead of dropping valid nodes', () => {
    const svg = parseSvg(
      renderGraphSvg(
        graph(
          [
            { data: { label: 42, typeId: 42 }, id: 'fallback', position: { x: 'bad', y: NaN } },
            { id: 'bare' }
          ],
          [
            {
              data: { edgeType: 'retired-type' },
              id: 'legacy',
              source: 'fallback',
              target: 'bare'
            },
            { id: 'dangling', source: 'fallback', target: 'missing' },
            { id: 'missing-source', target: 'bare' },
            { id: 'non-string-target', source: 'fallback', target: 42 }
          ]
        )
      )
    );
    const textValues = [...svg.querySelectorAll('text')].map((element) => element.textContent);
    const paths = svg.querySelectorAll(':scope > g:first-of-type > path');

    expect(textValues).toEqual(['fallback', '', 'bare', '']);
    expect(paths).toHaveLength(1);
    expect(paths[0].getAttribute('stroke')).toBe('#9CA3AF');
    expect(paths[0].getAttribute('marker-end')).toBeNull();
  });

  it('truncates text to its box instead of letting it overlap another node', () => {
    const svg = parseSvg(
      renderGraphSvg(
        graph([
          {
            data: {
              description: 'A description that is much wider than one node could possibly hold',
              label: 'A user label that is much wider than one node could possibly hold',
              typeId: 'worker'
            },
            id: 'wide',
            position: { x: 0, y: 0 }
          }
        ])
      )
    );
    const values = [...svg.querySelectorAll('text')].map((element) => element.textContent);

    expect(values[0]).toMatch(/…$/u);
    expect(values[1]).toBe('Workers');
    expect(values[2]).toMatch(/…$/u);
  });

  it('renders the Serverless ETL blueprint as the same seven-node, six-edge architecture', () => {
    const blueprint = BLUEPRINT_MAP.get('serverless-etl');
    expect(blueprint).toBeDefined();

    const source = renderGraphSvg(JSON.parse(blueprint?.graphData ?? '') as GraphData, {
      title: blueprint?.title
    });
    const svg = parseSvg(source);
    const nodeGroup = svg.querySelector(':scope > g:last-child');
    const edgeGroup = svg.querySelector(':scope > g:first-of-type');

    // Two rectangles per node: the bordered box and its category swatch. The header band is a path
    // so only its top corners are rounded.
    expect(nodeGroup?.querySelectorAll(':scope > rect')).toHaveLength(14);
    expect(edgeGroup?.querySelectorAll(':scope > path')).toHaveLength(6);
    expect(svg.querySelector('title')?.textContent).toBe('Serverless ETL Pipeline');
    expect([...svg.querySelectorAll('text')].map((element) => element.textContent)).toEqual(
      expect.arrayContaining([
        'Data Source',
        'R2 (Raw)',
        'Queues (Backlog)',
        'Transform Consumer',
        'Pipelines',
        'R2 Data Catalog',
        'R2 SQL',
        'Event notification'
      ])
    );
  });

  // The editor does not route by raw geometry. `chooseConnectionHandles` picks a side and then
  // `resolveHandle` checks the catalogue actually declares it, falling back to the node's first
  // handle of the right kind when it does not. The catalogue only ever puts a source handle on a
  // node's bottom or right and a target handle on its top or left, so an edge running up or to the
  // left has no direct handle and falls back to the vertical pair. A renderer that derived the
  // side from coordinates alone would disagree with the canvas for exactly those edges, and the
  // exported file — the artefact that ends up in a document, where nobody can compare it against
  // the canvas — would show an arrow leaving the wrong face of a node.
  describe('edge anchoring', () => {
    /**
     * Collects the first and last point of every edge path in a rendered document.
     *
     * @param source Complete SVG source from {@link renderGraphSvg}.
     * @returns One `{ from, to }` pair per edge, in document order.
     */
    function endpoints(source: string): { from: string; to: string }[] {
      const svg = parseSvg(source);
      const paths = svg.querySelectorAll(':scope > g:first-of-type > path');

      return [...paths].map((path) => {
        const data = path.getAttribute('d') ?? '';
        const points = [...data.matchAll(/(-?[\d.]+) (-?[\d.]+)/gu)].map((m) => `${m[1]},${m[2]}`);

        return { from: points[0] ?? '', to: points.at(-1) ?? '' };
      });
    }

    // The exact layout `auto_layout_diagram` produced for the "Checkout service" diagram: one
    // source fanning out to a node directly below it and to three placed down and to the right.
    const fanOut = graph(
      [
        {
          data: { label: 'API Gateway', typeId: 'worker-hono' },
          id: 'gateway',
          position: { x: 0, y: 160 }
        },
        {
          data: { label: 'Auth Service', typeId: 'worker-hono' },
          id: 'auth',
          position: { x: 0, y: 320 }
        },
        {
          data: { label: 'Data Service', typeId: 'worker-hono' },
          id: 'data',
          position: { x: 260, y: 320 }
        },
        { data: { label: 'Orders', typeId: 'd1' }, id: 'orders', position: { x: 780, y: 320 } }
      ],
      [
        { data: { edgeType: 'service-binding' }, id: 'e1', source: 'gateway', target: 'auth' },
        { data: { edgeType: 'service-binding' }, id: 'e2', source: 'gateway', target: 'data' },
        { data: { edgeType: 'service-binding' }, id: 'e3', source: 'gateway', target: 'orders' }
      ]
    );

    it('leaves the bottom and arrives at the top for every downward edge', () => {
      const [toAuth, toData, toOrders] = endpoints(renderGraphSvg(fanOut, {}));

      // The gateway's box spans y 160–214, so its bottom edge is y=214 for all three.
      expect(toAuth?.from).toBe('100,214');
      expect(toData?.from).toBe('100,214');
      expect(toOrders?.from).toBe('100,214');

      // Each target's box starts at y=320, so each edge arrives on the top face.
      expect(toAuth?.to).toBe('100,320');
      expect(toData?.to).toBe('360,320');
      expect(toOrders?.to).toBe('880,320');
    });

    /**
     * Renders one edge between a node at the origin and a node 400 to its right.
     *
     * @param edge Edge fields under test, merged over the source/target pair.
     * @returns The single edge's first and last point.
     */
    function sideBySide(edge: Record<string, unknown>): { from: string; to: string } {
      const [only] = endpoints(
        renderGraphSvg(
          graph(
            [
              {
                data: { label: 'Gateway', typeId: 'worker-hono' },
                id: 'gateway',
                position: { x: 0, y: 0 }
              },
              { data: { label: 'Cache', typeId: 'kv' }, id: 'cache', position: { x: 400, y: 0 } }
            ],
            [
              {
                data: { edgeType: 'data-flow' },
                id: 'e1',
                source: 'gateway',
                target: 'cache',
                ...edge
              }
            ]
          ),
          {}
        )
      );

      return only ?? { from: '', to: '' };
    }

    // The dialog is the only writer of handle ids, and this is the pair it records for a node
    // placed to the right. React Flow draws that edge from the right face, so the export must too.
    it('routes side to side when the edge recorded the right and left handles', () => {
      const edge = sideBySide({ sourceHandle: 'source-right', targetHandle: 'target-left' });

      expect(edge.from).toBe('200,27');
      expect(edge.to).toBe('400,27');
    });

    // Same geometry, no recorded handles — a blueprint edge or an MCP-created one. React Flow
    // falls back to each node's first handle of the right kind, which the catalogue orders
    // top/bottom, so the edge runs vertically even though the nodes sit side by side.
    it('routes bottom to top for a handle-less edge between nodes placed side by side', () => {
      const edge = sideBySide({});

      expect(edge.from).toBe('100,54');
      expect(edge.to).toBe('500,0');
    });

    // Only the right/left pair means "draw this sideways". A half-recorded edge — one side named,
    // the other absent — is not something the dialog can produce, and falling back keeps the
    // export matching React Flow rather than anchoring to a face the other end does not share.
    it('ignores a half-recorded handle pair', () => {
      const edge = sideBySide({ sourceHandle: 'source-right' });

      expect(edge.from).toBe('100,54');
      expect(edge.to).toBe('500,0');
    });
  });
});
