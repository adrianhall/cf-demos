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
            { id: 'horizontal-straight', source: 'a', target: 'b' },
            { id: 'horizontal-bent', source: 'b', target: 'c' },
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
    expect(paths[4]).toBe('M 0 27 L -60 27');
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
});
