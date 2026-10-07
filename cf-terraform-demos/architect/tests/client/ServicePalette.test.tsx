import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ServicePalette } from '../../src/client/components/editor/panels/ServicePalette.tsx';
import { PALETTE_COLLAPSED_STORAGE_KEY } from '../../src/client/lib/palette-preferences.ts';

/**
 * @file Covers the service palette: finding a service, and adding one without a pointer. The second
 *   is the reason the component is built from buttons rather than `draggable` divs — drag and drop
 *   has no keyboard equivalent, so a palette that only dragged would make the editor's primary
 *   action mouse-only.
 */

beforeEach(() => {
  localStorage.clear();
});

describe('finding a service', () => {
  it('groups every service under its catalogue category', () => {
    render(<ServicePalette onAddNode={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Compute' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Storage & Data' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'AI' })).toBeInTheDocument();
  });

  it('filters across every category as the visitor types', () => {
    render(<ServicePalette onAddNode={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Search services'), { target: { value: 'd1' } });

    expect(screen.getByText('D1 Database')).toBeInTheDocument();
    expect(screen.queryByText('Workers KV')).not.toBeInTheDocument();
  });

  // Storage starts collapsed, so a search that did not override that would show the visitor a
  // category header with their result hidden underneath it.
  it('reveals a match inside a collapsed category', () => {
    render(<ServicePalette onAddNode={vi.fn()} />);

    expect(screen.queryByText('D1 Database')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Search services'), { target: { value: 'd1' } });

    expect(screen.getByText('D1 Database')).toBeInTheDocument();
  });

  it('drops a category entirely when nothing in it matches', () => {
    render(<ServicePalette onAddNode={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Search services'), { target: { value: 'd1' } });

    expect(screen.queryByRole('button', { name: 'Compute' })).not.toBeInTheDocument();
  });

  it('matches on the catalogue identifier as well as the label', () => {
    render(<ServicePalette onAddNode={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Search services'), {
      target: { value: 'durable-object' }
    });

    expect(screen.getByText('Durable Objects')).toBeInTheDocument();
  });
});

describe('adding a service', () => {
  it('reports the catalogue type when an item is activated', () => {
    const onAddNode = vi.fn();
    render(<ServicePalette onAddNode={onAddNode} />);

    fireEvent.click(screen.getByRole('button', { name: 'Workers' }));

    expect(onAddNode).toHaveBeenCalledWith('worker');
  });

  it('attaches the catalogue type to a drag', () => {
    render(<ServicePalette onAddNode={vi.fn()} />);
    const setData = vi.fn();

    fireEvent.dragStart(screen.getByRole('button', { name: 'Workers' }), {
      dataTransfer: { effectAllowed: '', setData }
    });

    expect(setData).toHaveBeenCalledWith('application/cf-node-type', 'worker');
  });

  // The description is linked rather than folded into the name, so a screen reader announces
  // "Workers, button" and then the description, instead of a sentence of prose as the control's
  // name.
  it('names an item by its product and describes it separately', () => {
    render(<ServicePalette onAddNode={vi.fn()} />);

    const item = screen.getByRole('button', { name: 'Workers' });
    const description = screen.getByText('Cloudflare Workers serverless compute');

    expect(item).toHaveAttribute('aria-describedby', description.id);
  });
});

describe('collapsing categories', () => {
  it('collapses and expands one category', () => {
    render(<ServicePalette onAddNode={vi.fn()} />);
    const header = screen.getByRole('button', { name: 'Compute' });

    expect(header).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(header);

    expect(screen.queryByRole('button', { name: 'Workers' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Compute' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );

    fireEvent.click(screen.getByRole('button', { name: 'Compute' }));

    expect(screen.getByRole('button', { name: 'Workers' })).toBeVisible();
  });

  it('collapses and expands every category at once', () => {
    render(<ServicePalette onAddNode={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));

    expect(screen.queryByRole('button', { name: 'Workers' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));

    expect(screen.getByRole('button', { name: 'Workers' })).toBeVisible();
    expect(screen.getByText('D1 Database')).toBeInTheDocument();
  });

  // Six expanded sections of 42 products puts everything useful below the fold, and compute is
  // where a Cloudflare diagram nearly always starts.
  it('opens compute alone on a first visit', () => {
    render(<ServicePalette onAddNode={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Workers' })).toBeVisible();
    expect(screen.queryByText('D1 Database')).not.toBeInTheDocument();
  });

  it('remembers a category toggle for the next visit', () => {
    const { unmount } = render(<ServicePalette onAddNode={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Storage & Data' }));

    expect(screen.getByText('D1 Database')).toBeInTheDocument();
    unmount();

    render(<ServicePalette onAddNode={vi.fn()} />);

    expect(screen.getByText('D1 Database')).toBeInTheDocument();
  });

  it('remembers collapsing everything for the next visit', () => {
    const { unmount } = render(<ServicePalette onAddNode={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));

    expect(JSON.parse(localStorage.getItem(PALETTE_COLLAPSED_STORAGE_KEY) ?? '[]')).toContain(
      'compute'
    );
    unmount();

    render(<ServicePalette onAddNode={vi.fn()} />);

    expect(screen.queryByRole('button', { name: 'Workers' })).not.toBeInTheDocument();
  });

  // The control reflects the stored preference, not what a search is currently forcing open, so
  // it still offers to collapse what the visitor actually chose to leave open.
  it('still offers to collapse everything while a search is expanding matches', () => {
    render(<ServicePalette onAddNode={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Search services'), { target: { value: 'd1' } });

    expect(screen.getByRole('button', { name: 'Collapse all' })).toBeInTheDocument();
  });
});
