import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConfirmDeleteModal } from '../../src/client/components/dashboard/ConfirmDeleteModal.tsx';

/**
 * @file Covers the deletion confirmation directly. The dashboard's own suite drives it through a
 *   real card, so what is left here is the component's own contract: it renders nothing while
 *   closed, and when open it names the diagram and announces itself as a dialog that needs an
 *   answer.
 */

describe('ConfirmDeleteModal', () => {
  it('renders nothing while closed', () => {
    const { container } = render(
      <ConfirmDeleteModal
        open={false}
        diagramTitle="My Diagram"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    expect(container).toBeEmptyDOMElement();
  });

  // `alertdialog` rather than `dialog`, so the message is announced on open rather than only the
  // dialog's name. Deletion here is unrecoverable, so that message is the point of the dialog.
  it('announces itself as a dialog carrying a message, labelled by its heading', () => {
    render(
      <ConfirmDeleteModal open diagramTitle="My Diagram" onConfirm={vi.fn()} onCancel={vi.fn()} />
    );

    const dialog = screen.getByRole('alertdialog');

    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Delete Diagram');
  });

  it('names the diagram and warns that the deletion is permanent', () => {
    render(
      <ConfirmDeleteModal open diagramTitle="My Diagram" onConfirm={vi.fn()} onCancel={vi.fn()} />
    );

    expect(screen.getByRole('alertdialog')).toHaveTextContent('My Diagram');
    expect(screen.getByRole('alertdialog')).toHaveTextContent(/cannot be undone/iu);
  });

  it('keeps the backdrop out of the tab order', () => {
    render(<ConfirmDeleteModal open diagramTitle="X" onConfirm={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Close dialog' })).toHaveAttribute('tabindex', '-1');
  });
});
