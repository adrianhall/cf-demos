import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as mockXyflow from './mock-xyflow.tsx';

vi.mock('@xyflow/react', () => mockXyflow);

const { mockDeleteAnyDiagram, mockGetAnyDiagram } = vi.hoisted(() => ({
  mockDeleteAnyDiagram: vi.fn(),
  mockGetAnyDiagram: vi.fn()
}));
vi.mock('../../src/client/api/admin.ts', () => ({
  deleteAnyDiagram: mockDeleteAnyDiagram,
  getAnyDiagram: mockGetAnyDiagram
}));

const { DiagramModerationPanel } =
  await import('../../src/client/components/admin/DiagramModerationPanel.tsx');

/**
 * @file Covers the moderation panel. Deletion here is unrecoverable and crosses an ownership
 *   boundary, so the cases that matter are the ones protecting against doing it by accident: the
 *   confirmation, cancelling it, and the guard against confirming a diagram that is no longer on
 *   screen.
 */

/**
 * A diagram as the moderation preview returns it: owner-blind, by the server's construction.
 */
const DIAGRAM = {
  description: 'A test diagram',
  graphData: JSON.stringify({ edges: [], nodes: [] }),
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Reviewed Diagram'
};

beforeEach(() => {
  mockGetAnyDiagram.mockReset();
  mockDeleteAnyDiagram.mockReset().mockResolvedValue(undefined);
});

/**
 * Enters an id and submits the form.
 *
 * @param id Diagram id to look up.
 */
function openDiagram(id: string): void {
  fireEvent.change(screen.getByLabelText('Diagram id'), { target: { value: id } });
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
}

/**
 * Loads the diagram and waits for its preview.
 *
 * @returns A promise fulfilled once the preview is on screen.
 */
async function openPreview(): Promise<void> {
  mockGetAnyDiagram.mockResolvedValue(DIAGRAM);
  render(<DiagramModerationPanel />);
  openDiagram(DIAGRAM.id);
  await waitFor(() => expect(screen.getByText('Reviewed Diagram')).toBeInTheDocument());
}

describe('looking a diagram up', () => {
  it('loads and previews the diagram named by its id', async () => {
    await openPreview();

    expect(mockGetAnyDiagram).toHaveBeenCalledWith(DIAGRAM.id);
    expect(screen.getByText('A test diagram')).toBeInTheDocument();
  });

  // The point of the preview: an administrator decides whether to delete a diagram by looking at
  // what it contains.
  it('renders the diagram\u2019s graph', async () => {
    await openPreview();

    expect(screen.getByTestId('react-flow')).toBeInTheDocument();
  });

  it('trims surrounding whitespace from a pasted id', async () => {
    mockGetAnyDiagram.mockResolvedValue(DIAGRAM);
    render(<DiagramModerationPanel />);

    openDiagram(`  ${DIAGRAM.id}  `);

    await waitFor(() => expect(mockGetAnyDiagram).toHaveBeenCalledWith(DIAGRAM.id));
  });

  it.each([
    ['an empty field', ''],
    ['a field of whitespace', '   ']
  ])('asks the server nothing for %s', (_description, value) => {
    render(<DiagramModerationPanel />);

    openDiagram(value);

    expect(mockGetAnyDiagram).not.toHaveBeenCalled();
  });

  it('labels the field for assistive technology', () => {
    render(<DiagramModerationPanel />);

    expect(screen.getByLabelText('Diagram id')).toBeInTheDocument();
  });

  it('reports a diagram that could not be loaded', async () => {
    mockGetAnyDiagram.mockRejectedValue(new Error('Diagram not found.'));
    render(<DiagramModerationPanel />);

    openDiagram('11111111-1111-4111-8111-111111111111');

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Diagram not found.'));
  });

  it('falls back to a usable message when the failure carried none', async () => {
    mockGetAnyDiagram.mockRejectedValue('boom');
    render(<DiagramModerationPanel />);

    openDiagram('11111111-1111-4111-8111-111111111111');

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Could not load that diagram.')
    );
  });

  // A stale preview above a fresh refusal would read as though the failed lookup had succeeded.
  it('clears the previous preview when a later lookup fails', async () => {
    await openPreview();

    mockGetAnyDiagram.mockRejectedValue(new Error('Diagram not found.'));
    openDiagram('22222222-2222-4222-8222-222222222222');

    await waitFor(() => expect(screen.queryByText('Reviewed Diagram')).not.toBeInTheDocument());
  });
});

describe('deleting a diagram', () => {
  // Deletion is unrecoverable and crosses an ownership boundary, so it gets exactly the same
  // interruption an owner's own delete does rather than a quieter one.
  it('asks for confirmation before deleting anything', async () => {
    await openPreview();

    fireEvent.click(screen.getByRole('button', { name: 'Delete diagram' }));

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(mockDeleteAnyDiagram).not.toHaveBeenCalled();
  });

  // The confirmation names the diagram, so an operator can see which one they are about to lose.
  it('names the diagram in the confirmation', async () => {
    await openPreview();

    fireEvent.click(screen.getByRole('button', { name: 'Delete diagram' }));

    expect(screen.getByRole('alertdialog')).toHaveTextContent('Reviewed Diagram');
  });

  it('deletes once confirmed and reports that it did', async () => {
    await openPreview();

    fireEvent.click(screen.getByRole('button', { name: 'Delete diagram' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Diagram deleted.'));
    expect(mockDeleteAnyDiagram).toHaveBeenCalledWith(DIAGRAM.id);
    expect(screen.queryByText('Reviewed Diagram')).not.toBeInTheDocument();
  });

  it('deletes nothing when the confirmation is dismissed', async () => {
    await openPreview();

    fireEvent.click(screen.getByRole('button', { name: 'Delete diagram' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(mockDeleteAnyDiagram).not.toHaveBeenCalled();
    expect(screen.getByText('Reviewed Diagram')).toBeInTheDocument();
  });

  it('reports a deletion that failed', async () => {
    await openPreview();
    mockDeleteAnyDiagram.mockRejectedValue(new Error('Diagram not found.'));

    fireEvent.click(screen.getByRole('button', { name: 'Delete diagram' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Diagram not found.'));
  });

  it('falls back to a usable message when the deletion failure carried none', async () => {
    await openPreview();
    mockDeleteAnyDiagram.mockRejectedValue('boom');

    fireEvent.click(screen.getByRole('button', { name: 'Delete diagram' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Could not delete that diagram.')
    );
  });

  // The dialog tracks its own open state, so a diagram cleared while it was on screen would
  // otherwise reach the confirm handler with nothing to delete — and the id of whatever was
  // loaded next would be the one at risk.
  it('deletes nothing when the previewed diagram was cleared while the dialog was open', async () => {
    mockGetAnyDiagram.mockResolvedValueOnce(DIAGRAM).mockRejectedValueOnce(new Error('gone'));
    render(<DiagramModerationPanel />);
    openDiagram(DIAGRAM.id);
    await waitFor(() => expect(screen.getByText('Reviewed Diagram')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Delete diagram' }));
    openDiagram('22222222-2222-4222-8222-222222222222');
    await waitFor(() => expect(screen.queryByText('Reviewed Diagram')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(mockDeleteAnyDiagram).not.toHaveBeenCalled();
  });

  // A success message sitting above a freshly opened diagram reads as though *this* one has just
  // been deleted.
  it('clears the success message when another diagram is opened', async () => {
    await openPreview();
    fireEvent.click(screen.getByRole('button', { name: 'Delete diagram' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());

    mockGetAnyDiagram.mockResolvedValue({ ...DIAGRAM, title: 'Another Diagram' });
    openDiagram('22222222-2222-4222-8222-222222222222');

    await waitFor(() => expect(screen.getByText('Another Diagram')).toBeInTheDocument());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  // Polite rather than assertive: a completed deletion is the outcome the operator asked for,
  // not an interruption.
  it('announces the deletion politely rather than as an alert', async () => {
    await openPreview();

    fireEvent.click(screen.getByRole('button', { name: 'Delete diagram' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
