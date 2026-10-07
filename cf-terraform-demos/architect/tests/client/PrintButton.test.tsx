import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PrintButton } from '../../src/client/components/editor/toolbar/PrintButton.tsx';
import { useDiagramStore } from '../../src/client/stores/diagramStore.ts';

/**
 * @file Covers the print control, which deliberately has almost nothing to cover: it sets a flag
 *   and nothing else. Every side effect of printing belongs to the canvas, which owns the document
 *   and the viewport — so the one behaviour this component has is the one asserted here, and the
 *   rest lives in `./DiagramCanvas.test.tsx`.
 */

beforeEach(() => {
  useDiagramStore.setState({ printMode: false });
});

describe('PrintButton', () => {
  it('enters print mode', () => {
    render(<PrintButton />);

    fireEvent.click(screen.getByRole('button', { name: 'Print' }));

    expect(useDiagramStore.getState().printMode).toBe(true);
  });

  // The icon is decorative, so the accessible name is the only thing identifying the control.
  it('names itself for assistive technology', () => {
    render(<PrintButton />);

    const button = screen.getByRole('button', { name: 'Print' });

    expect(button).toHaveAttribute('title', 'Print');
    expect(button).toHaveAttribute('type', 'button');
  });

  // It only sets a flag: reaching into `document` here would make the control untestable as a
  // control and leave the canvas with no way to clean up after it.
  it('touches nothing but the store', () => {
    const previousColorScheme = document.documentElement.style.colorScheme;
    render(<PrintButton />);

    fireEvent.click(screen.getByRole('button', { name: 'Print' }));

    expect(document.documentElement.style.colorScheme).toBe(previousColorScheme);
    expect(document.body.classList.contains('diagram-editor-print-mode')).toBe(false);
  });
});
