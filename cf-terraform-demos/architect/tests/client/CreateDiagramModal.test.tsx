import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Blueprint } from '../../src/blueprints.ts';

vi.mock('@xyflow/react', () => import('./mock-xyflow.tsx'));

const { mockCreateDiagram } = vi.hoisted(() => ({ mockCreateDiagram: vi.fn() }));
vi.mock('../../src/client/api/diagrams.ts', () => ({ createDiagram: mockCreateDiagram }));

const { CreateDiagramModal } =
  await import('../../src/client/components/blueprints/CreateDiagramModal.tsx');

/**
 * @file Covers the creation modal: what the form is seeded with, what it sends, how it reports a
 *   failure, and the focus behaviour its `aria-modal` promises. Every dismissal path is asserted
 *   separately — Cancel, the close control, the backdrop and Escape — because they are four
 *   affordances sharing one handler, and a regression that broke only the keyboard one would
 *   otherwise pass.
 */

/**
 * A template with known values, so an assertion names a constant rather than whichever real
 * blueprint happens to sort first.
 */
const SAMPLE: Blueprint = {
  category: 'Serverless',
  description: 'A sample blueprint.',
  graphData: JSON.stringify({ edges: [], nodes: [{ id: 'a' }] }),
  id: 'sample',
  title: 'Sample Blueprint'
};

const originalLocation = Object.getOwnPropertyDescriptor(window, 'location');

beforeEach(() => {
  mockCreateDiagram.mockReset();
  // Replaced wholesale because jsdom's `location` is read-only, and the success path asserts on the
  // document navigation the modal performs.
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, href: '' },
    writable: true
  });
});

afterEach(() => {
  if (originalLocation) {
    Object.defineProperty(window, 'location', originalLocation);
  }
});

describe('CreateDiagramModal', () => {
  it('renders nothing while closed', () => {
    const { container } = render(
      <CreateDiagramModal open={false} onClose={vi.fn()} blueprint={null} />
    );

    expect(container).toBeEmptyDOMElement();
  });

  describe('seeding the form', () => {
    it('prefills the title and description from the chosen template', () => {
      render(<CreateDiagramModal open onClose={vi.fn()} blueprint={SAMPLE} />);

      expect(screen.getByLabelText('Title')).toHaveValue('Sample Blueprint');
      expect(screen.getByLabelText('Description')).toHaveValue('A sample blueprint.');
      expect(screen.getByText('Serverless')).toBeInTheDocument();
    });

    // The server's own default, so the field shows the name the diagram would get anyway rather
    // than an empty box whose consequence the visitor has to guess.
    it('defaults a blank canvas to the server\u2019s own title and an empty description', () => {
      render(<CreateDiagramModal open onClose={vi.fn()} blueprint={null} />);

      expect(screen.getByLabelText('Title')).toHaveValue('Untitled Diagram');
      expect(screen.getByLabelText('Description')).toHaveValue('');
    });

    it('shows the template\u2019s real graph beside the form', () => {
      render(<CreateDiagramModal open onClose={vi.fn()} blueprint={SAMPLE} />);

      expect(screen.getByTestId('react-flow')).toHaveAttribute('data-node-count', '1');
    });

    it('shows a blank-canvas placeholder instead of a canvas when no template is chosen', () => {
      render(<CreateDiagramModal open onClose={vi.fn()} blueprint={null} />);

      expect(screen.getByText(/start with a blank canvas/iu)).toBeInTheDocument();
      expect(screen.queryByTestId('react-flow')).not.toBeInTheDocument();
    });

    it('names the dialog after the template, or after the blank-canvas heading', () => {
      const { unmount } = render(<CreateDiagramModal open onClose={vi.fn()} blueprint={SAMPLE} />);

      expect(screen.getByRole('dialog')).toHaveAccessibleName('Sample Blueprint');
      unmount();

      render(<CreateDiagramModal open onClose={vi.fn()} blueprint={null} />);

      expect(screen.getByRole('dialog')).toHaveAccessibleName('Create New Diagram');
    });

    // Descriptive labels, tied to their controls, rather than placeholder text — which disappears
    // the moment anybody types into the field.
    it('labels both fields with real, associated labels', () => {
      render(<CreateDiagramModal open onClose={vi.fn()} blueprint={null} />);

      expect(screen.getByLabelText('Title')).toHaveAttribute('id', 'diagram-title');
      expect(screen.getByLabelText('Description')).toHaveAttribute('id', 'diagram-description');
    });

    it('bounds both fields to the lengths the server accepts', () => {
      render(<CreateDiagramModal open onClose={vi.fn()} blueprint={null} />);

      expect(screen.getByLabelText('Title')).toHaveAttribute('maxLength', '255');
      expect(screen.getByLabelText('Description')).toHaveAttribute('maxLength', '2000');
    });
  });

  describe('creating', () => {
    it('sends the template, title and description, then opens the new editor', async () => {
      mockCreateDiagram.mockResolvedValue({ id: 'new-id' });
      render(<CreateDiagramModal open onClose={vi.fn()} blueprint={SAMPLE} />);

      fireEvent.click(screen.getByRole('button', { name: 'Create Diagram' }));

      await waitFor(() => {
        expect(mockCreateDiagram).toHaveBeenCalledWith({
          blueprintId: 'sample',
          description: 'A sample blueprint.',
          title: 'Sample Blueprint'
        });
      });
      // A real document navigation, which is what lets Access intercept `/app/*`.
      await waitFor(() => {
        expect(window.location.href).toBe('/app/diagram/new-id');
      });
    });

    it('sends no template for a blank canvas, and omits an empty description', async () => {
      mockCreateDiagram.mockResolvedValue({ id: 'new-id' });
      render(<CreateDiagramModal open onClose={vi.fn()} blueprint={null} />);

      fireEvent.click(screen.getByRole('button', { name: 'Create Diagram' }));

      await waitFor(() => {
        expect(mockCreateDiagram).toHaveBeenCalledWith({
          blueprintId: undefined,
          description: undefined,
          title: 'Untitled Diagram'
        });
      });
    });

    it('sends the edited values rather than the seeded ones', async () => {
      mockCreateDiagram.mockResolvedValue({ id: 'new-id' });
      render(<CreateDiagramModal open onClose={vi.fn()} blueprint={SAMPLE} />);

      fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'My own name' } });
      fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'My notes' } });
      fireEvent.click(screen.getByRole('button', { name: 'Create Diagram' }));

      await waitFor(() => {
        expect(mockCreateDiagram).toHaveBeenCalledWith({
          blueprintId: 'sample',
          description: 'My notes',
          title: 'My own name'
        });
      });
    });

    it('refuses to submit a whitespace-only title', () => {
      render(<CreateDiagramModal open onClose={vi.fn()} blueprint={null} />);

      fireEvent.change(screen.getByLabelText('Title'), { target: { value: '   ' } });

      expect(screen.getByRole('button', { name: 'Create Diagram' })).toBeDisabled();
    });

    it('shows a progress label while the request is in flight', async () => {
      mockCreateDiagram.mockReturnValue(new Promise(() => {}));
      render(<CreateDiagramModal open onClose={vi.fn()} blueprint={null} />);

      fireEvent.click(screen.getByRole('button', { name: 'Create Diagram' }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /creating/iu })).toBeDisabled();
      });
    });
  });

  describe('reporting a failure', () => {
    // Announced, not merely displayed: the visitor's focus is on the button they just pressed, so
    // a message that was only visible would go unnoticed by a screen-reader user.
    it('announces the server\u2019s own message', async () => {
      mockCreateDiagram.mockRejectedValue(new Error('Blueprint "nope" not found.'));
      render(<CreateDiagramModal open onClose={vi.fn()} blueprint={null} />);

      fireEvent.click(screen.getByRole('button', { name: 'Create Diagram' }));

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('Blueprint "nope" not found.');
      });
    });

    it('falls back to a generic message when the failure is not an Error', async () => {
      mockCreateDiagram.mockRejectedValue('boom');
      render(<CreateDiagramModal open onClose={vi.fn()} blueprint={null} />);

      fireEvent.click(screen.getByRole('button', { name: 'Create Diagram' }));

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('Could not create the diagram.');
      });
    });

    // A failure here is usually recoverable, and a dead button would force a reload that discards
    // whatever the visitor typed.
    it('re-enables the button so the visitor can retry', async () => {
      mockCreateDiagram.mockRejectedValue(new Error('Nope.'));
      render(<CreateDiagramModal open onClose={vi.fn()} blueprint={null} />);

      fireEvent.click(screen.getByRole('button', { name: 'Create Diagram' }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Create Diagram' })).not.toBeDisabled();
      });
    });

    it('navigates nowhere when creation failed', async () => {
      mockCreateDiagram.mockRejectedValue(new Error('Nope.'));
      render(<CreateDiagramModal open onClose={vi.fn()} blueprint={null} />);

      fireEvent.click(screen.getByRole('button', { name: 'Create Diagram' }));

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument();
      });
      expect(window.location.href).toBe('');
    });
  });

  describe('dismissal', () => {
    // Four affordances, one handler. Asserted separately so a regression in any one of them fails.
    it.each([
      ['Cancel', () => fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))],
      ['the close control', () => fireEvent.click(screen.getByRole('button', { name: 'Close' }))],
      ['the backdrop', () => fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }))],
      ['Escape', () => fireEvent.keyDown(document, { key: 'Escape' })]
    ])('closes through %s', (_label, dismiss) => {
      const onClose = vi.fn();
      render(<CreateDiagramModal open onClose={onClose} blueprint={null} />);

      dismiss();

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('stays open when the dialog itself is clicked', () => {
      const onClose = vi.fn();
      render(<CreateDiagramModal open onClose={onClose} blueprint={null} />);

      fireEvent.click(screen.getByRole('dialog'));

      expect(onClose).not.toHaveBeenCalled();
    });

    it('creates nothing when dismissed', () => {
      render(<CreateDiagramModal open onClose={vi.fn()} blueprint={SAMPLE} />);

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(mockCreateDiagram).not.toHaveBeenCalled();
    });
  });

  describe('focus management', () => {
    it('moves focus into the dialog on open', () => {
      render(<CreateDiagramModal open onClose={vi.fn()} blueprint={null} />);

      expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
    });

    it('restores focus to whatever opened it on close', () => {
      const trigger = document.createElement('button');
      document.body.appendChild(trigger);
      trigger.focus();

      const { rerender } = render(<CreateDiagramModal open onClose={vi.fn()} blueprint={null} />);
      rerender(<CreateDiagramModal open={false} onClose={vi.fn()} blueprint={null} />);

      expect(document.activeElement).toBe(trigger);
      trigger.remove();
    });

    // `aria-modal="true"` promises the rest of the page is unreachable. Without the trap, Tab
    // would walk straight out of the dialog and the markup would be making a false claim.
    it('wraps Tab from the last control back to the first', () => {
      render(<CreateDiagramModal open onClose={vi.fn()} blueprint={null} />);
      const dialog = screen.getByRole('dialog');
      const focusable = dialog.querySelectorAll<HTMLElement>('button, input, textarea');
      const last = focusable[focusable.length - 1] as HTMLElement;

      last.focus();
      fireEvent.keyDown(document, { key: 'Tab' });

      expect(document.activeElement).toBe(focusable[0]);
    });

    it('wraps Shift+Tab from the first control to the last', () => {
      render(<CreateDiagramModal open onClose={vi.fn()} blueprint={null} />);
      const dialog = screen.getByRole('dialog');
      const focusable = dialog.querySelectorAll<HTMLElement>('button, input, textarea');

      (focusable[0] as HTMLElement).focus();
      fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });

      expect(document.activeElement).toBe(focusable[focusable.length - 1]);
    });

    // The backdrop is a real button so a pointer can dismiss the dialog, but it carries no visible
    // affordance, so it must not be a tab stop a keyboard user lands on.
    it('keeps the backdrop out of the tab order', () => {
      render(<CreateDiagramModal open onClose={vi.fn()} blueprint={null} />);

      expect(screen.getByRole('button', { name: 'Close dialog' })).toHaveAttribute(
        'tabindex',
        '-1'
      );
    });
  });
});
