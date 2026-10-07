import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDismissableMenu } from '../../src/client/hooks/useDismissableMenu.ts';
import { useModalFocus } from '../../src/client/hooks/useModalFocus.ts';

/**
 * @file Covers the two shared interaction hooks directly, rather than only through the components
 *   that use them. Both exist because the behaviour they implement is easy to get subtly wrong in a
 *   way no visual check reveals: a focus trap that lets Tab escape contradicts the `aria-modal` its
 *   dialog advertises, and a menu that closes only on an outside click cannot be dismissed by
 *   keyboard at all. Testing them here covers the edge cases — an empty dialog, focus already
 *   outside it — that a component test would have to contrive.
 */

afterEach(() => {
  document.body.replaceChildren();
});

/**
 * Builds a trigger button that holds focus, plus an attached dialog element.
 *
 * @returns The dialog and the trigger that "opened" it.
 */
function buildDialog(): { dialog: HTMLDivElement; trigger: HTMLButtonElement } {
  const trigger = document.createElement('button');
  document.body.appendChild(trigger);
  trigger.focus();

  const dialog = document.createElement('div');
  dialog.tabIndex = -1;
  document.body.appendChild(dialog);
  return { dialog, trigger };
}

/**
 * Builds a ref already pointing at an element, as a mounted component's ref would be.
 *
 * @param element Element the ref should hold.
 * @returns The populated ref.
 */
function refTo(element: HTMLElement | null): React.RefObject<HTMLElement | null> {
  const ref = createRef<HTMLElement>();
  (ref as { current: HTMLElement | null }).current = element;
  return ref;
}

/**
 * Dispatches a key press on the document, where both hooks listen.
 *
 * @param key Key to press.
 * @param shiftKey Whether Shift is held.
 * @returns The dispatched event, so a test can read `defaultPrevented`.
 */
function pressKey(key: string, shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, shiftKey });
  document.dispatchEvent(event);
  return event;
}

describe('useModalFocus', () => {
  it('moves focus to the first focusable control on open', () => {
    const { dialog } = buildDialog();
    const first = document.createElement('button');
    const second = document.createElement('button');
    dialog.appendChild(first);
    dialog.appendChild(second);

    renderHook(() => useModalFocus(true, refTo(dialog), vi.fn()));

    expect(document.activeElement).toBe(first);
  });

  // `tabIndex={-1}` on the dialog is what gives focus somewhere to land, so a dialog that is only
  // a message still takes focus rather than leaving it on the page behind.
  it('focuses the dialog itself when it has no focusable control', () => {
    const { dialog } = buildDialog();

    renderHook(() => useModalFocus(true, refTo(dialog), vi.fn()));

    expect(document.activeElement).toBe(dialog);
  });

  it('does nothing while closed', () => {
    const { dialog, trigger } = buildDialog();
    dialog.appendChild(document.createElement('button'));

    renderHook(() => useModalFocus(false, refTo(dialog), vi.fn()));

    expect(document.activeElement).toBe(trigger);
  });

  it('closes on Escape', () => {
    const { dialog } = buildDialog();
    const onClose = vi.fn();

    renderHook(() => useModalFocus(true, refTo(dialog), onClose));
    const event = pressKey('Escape');

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('restores focus to the trigger on close', () => {
    const { dialog, trigger } = buildDialog();
    dialog.appendChild(document.createElement('button'));

    const { rerender } = renderHook(
      ({ open }: { open: boolean }) => useModalFocus(open, refTo(dialog), vi.fn()),
      { initialProps: { open: true } }
    );
    rerender({ open: false });

    expect(document.activeElement).toBe(trigger);
  });

  describe('the Tab trap', () => {
    /**
     * Builds a dialog with three focusable controls.
     *
     * @returns The dialog and its first, middle and last controls.
     */
    function buildThreeControlDialog(): {
      dialog: HTMLDivElement;
      first: HTMLButtonElement;
      middle: HTMLButtonElement;
      last: HTMLButtonElement;
    } {
      const { dialog } = buildDialog();
      const first = document.createElement('button');
      const middle = document.createElement('button');
      const last = document.createElement('button');
      dialog.appendChild(first);
      dialog.appendChild(middle);
      dialog.appendChild(last);
      return { dialog, first, last, middle };
    }

    it('wraps Tab from the last control to the first', () => {
      const { dialog, first, last } = buildThreeControlDialog();
      renderHook(() => useModalFocus(true, refTo(dialog), vi.fn()));
      last.focus();

      pressKey('Tab');

      expect(document.activeElement).toBe(first);
    });

    it('wraps Shift+Tab from the first control to the last', () => {
      const { dialog, first, last } = buildThreeControlDialog();
      renderHook(() => useModalFocus(true, refTo(dialog), vi.fn()));
      first.focus();

      pressKey('Tab', true);

      expect(document.activeElement).toBe(last);
    });

    // Only the boundaries are intercepted. Interfering mid-dialog would break the browser's own
    // tab order, including for controls this selector does not know about.
    it.each([
      ['Tab', false],
      ['Shift+Tab', true]
    ])('leaves %s from a middle control to the browser', (_label, shiftKey) => {
      const { dialog, middle } = buildThreeControlDialog();
      renderHook(() => useModalFocus(true, refTo(dialog), vi.fn()));
      middle.focus();

      const event = pressKey('Tab', shiftKey);

      expect(event.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(middle);
    });

    it.each([
      ['Tab', false, 'first'],
      ['Shift+Tab', true, 'last']
    ])('pulls focus back into the dialog on %s if it escaped', (_label, shiftKey, expected) => {
      const { dialog, first, last } = buildThreeControlDialog();
      const outside = document.createElement('button');
      document.body.appendChild(outside);
      renderHook(() => useModalFocus(true, refTo(dialog), vi.fn()));
      outside.focus();

      pressKey('Tab', shiftKey);

      expect(document.activeElement).toBe(expected === 'first' ? first : last);
    });

    it('holds focus on an empty dialog rather than letting Tab leave it', () => {
      const { dialog } = buildDialog();
      renderHook(() => useModalFocus(true, refTo(dialog), vi.fn()));

      const event = pressKey('Tab');

      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(dialog);
    });

    it('ignores keys other than Tab and Escape', () => {
      const { dialog } = buildDialog();
      const first = document.createElement('button');
      dialog.appendChild(first);
      const onClose = vi.fn();
      renderHook(() => useModalFocus(true, refTo(dialog), onClose));
      first.focus();

      const event = pressKey('a');

      expect(event.defaultPrevented).toBe(false);
      expect(onClose).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(first);
    });

    it('skips a disabled control, which is not a tab stop', () => {
      const { dialog } = buildDialog();
      const disabled = document.createElement('button');
      disabled.disabled = true;
      const enabled = document.createElement('button');
      dialog.appendChild(disabled);
      dialog.appendChild(enabled);

      renderHook(() => useModalFocus(true, refTo(dialog), vi.fn()));

      expect(document.activeElement).toBe(enabled);
    });

    it('tolerates a ref that holds nothing yet', () => {
      const { trigger } = buildDialog();

      renderHook(() => useModalFocus(true, refTo(null), vi.fn()));
      const event = pressKey('Tab');

      expect(document.activeElement).toBe(trigger);
      expect(event.defaultPrevented).toBe(false);
    });
  });
});

describe('useDismissableMenu', () => {
  it('does nothing while closed', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const onDismiss = vi.fn();

    renderHook(() => useDismissableMenu(false, refTo(container), onDismiss));
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    pressKey('Escape');

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('dismisses on a press outside the container', () => {
    const container = document.createElement('div');
    const outside = document.createElement('div');
    document.body.appendChild(container);
    document.body.appendChild(outside);
    const onDismiss = vi.fn();

    renderHook(() => useDismissableMenu(true, refTo(container), onDismiss));
    outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('stays open on a press inside the container', () => {
    const container = document.createElement('div');
    const inner = document.createElement('button');
    container.appendChild(inner);
    document.body.appendChild(container);
    const onDismiss = vi.fn();

    renderHook(() => useDismissableMenu(true, refTo(container), onDismiss));
    inner.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    expect(onDismiss).not.toHaveBeenCalled();
  });

  // The keyboard path. Without it a keyboard user can tab away but the menu stays visibly open
  // over whatever they moved to.
  it('dismisses on Escape', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const onDismiss = vi.fn();

    renderHook(() => useDismissableMenu(true, refTo(container), onDismiss));
    pressKey('Escape');

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('ignores other keys', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const onDismiss = vi.fn();

    renderHook(() => useDismissableMenu(true, refTo(container), onDismiss));
    pressKey('Enter');

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('stops listening once unmounted', () => {
    const container = document.createElement('div');
    const outside = document.createElement('div');
    document.body.appendChild(container);
    document.body.appendChild(outside);
    const onDismiss = vi.fn();

    const { unmount } = renderHook(() => useDismissableMenu(true, refTo(container), onDismiss));
    unmount();
    outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    pressKey('Escape');

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('tolerates a ref that holds nothing yet', () => {
    const onDismiss = vi.fn();

    renderHook(() => useDismissableMenu(true, refTo(null), onDismiss));
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    expect(onDismiss).not.toHaveBeenCalled();
  });
});
