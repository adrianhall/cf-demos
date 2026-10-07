import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@xyflow/react', () => import('./mock-xyflow.tsx'));

const { BlueprintPreview } =
  await import('../../src/client/components/blueprints/BlueprintPreview.tsx');

/**
 * @file Covers the thumbnail's two jobs: parse a graph without ever failing loudly, and stay
 *   completely out of the accessibility tree and the tab order. The focusability assertions are the
 *   reason this file exists. React Flow defaults `nodesFocusable` and `edgesFocusable` to `true`
 *   regardless of `elementsSelectable`, so a preview that forgets to pass `false` puts real tab
 *   stops inside an `aria-hidden` wrapper — and on a dashboard of many diagrams it floods the tab
 *   order with stops that announce nothing. Nothing else in the suite can fail on that.
 */

describe('BlueprintPreview', () => {
  it('renders the canvas for a well-formed graph', () => {
    render(
      <BlueprintPreview
        graphData={JSON.stringify({ edges: [{ id: 'e1' }], nodes: [{ id: 'a' }] })}
      />
    );

    const flow = screen.getByTestId('react-flow');

    expect(flow).toHaveAttribute('data-node-count', '1');
    expect(flow).toHaveAttribute('data-edge-count', '1');
  });

  // A thumbnail is decoration. One unreadable graph should cost a visitor that one card, not throw
  // out of render and take the whole gallery or dashboard with it.
  it.each([
    ['malformed JSON', 'not json'],
    ['an empty object', '{}'],
    ['a JSON array', '[]'],
    ['an empty string', '']
  ])('tolerates %s by rendering an empty canvas', (_label, graphData) => {
    render(<BlueprintPreview graphData={graphData} />);

    const flow = screen.getByTestId('react-flow');

    expect(flow).toHaveAttribute('data-node-count', '0');
    expect(flow).toHaveAttribute('data-edge-count', '0');
  });

  it('tolerates a graph carrying nodes but no edges', () => {
    render(<BlueprintPreview graphData={JSON.stringify({ nodes: [{ id: 'a' }] })} />);

    expect(screen.getByTestId('react-flow')).toHaveAttribute('data-edge-count', '0');
  });

  it('hides itself from assistive technology, since the card already carries the name', () => {
    const { container } = render(<BlueprintPreview graphData="{}" />);

    expect(container.querySelector('[aria-hidden="true"]')).toBeInTheDocument();
  });

  // Nothing focusable may live inside `aria-hidden` content (WCAG 4.1.2).
  it('makes no node or edge a tab stop inside its aria-hidden wrapper', () => {
    render(<BlueprintPreview graphData="{}" />);

    const flow = screen.getByTestId('react-flow');

    expect(flow).toHaveAttribute('data-nodes-focusable', 'false');
    expect(flow).toHaveAttribute('data-edges-focusable', 'false');
  });

  it('applies the requested height, and a default when none is given', () => {
    const { container: sized } = render(<BlueprintPreview graphData="{}" height={140} />);

    expect(sized.querySelector('[aria-hidden="true"]')).toHaveStyle({ height: '140px' });

    const { container: defaulted } = render(<BlueprintPreview graphData="{}" />);

    expect(defaulted.querySelector('[aria-hidden="true"]')).toHaveStyle({ height: '200px' });
  });
});
