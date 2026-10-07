import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { DarkModeToggle } from '../../src/client/components/DarkModeToggle.tsx';
import { THEME_STORAGE_KEY } from '../../src/client/lib/theme.ts';

/**
 * @file Covers the appearance control's three-state cycle. The behaviour worth pinning is the
 *   distinction between _following_ the system preference and _choosing_ the scheme the system
 *   happens to prefer: those look identical on screen and are different states, because only the
 *   latter survives the user changing their OS setting.
 */

/**
 * Captured `change` listeners registered against the stubbed media query, so a test can simulate
 * the OS preference changing while the control is mounted.
 */
let changeHandlers: (() => void)[] = [];

/**
 * Replaces `window.matchMedia` with a stub reporting a fixed preference.
 *
 * @param matches Whether the OS reports a dark preference.
 * @returns The `removeEventListener` spy, so a test can assert the listener is cleaned up.
 */
function stubMatchMedia(matches: boolean): ReturnType<typeof vi.fn> {
  const removeEventListener = vi.fn();
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      addEventListener: vi.fn((_event: string, handler: () => void) => {
        changeHandlers.push(handler);
      }),
      matches,
      removeEventListener
    }))
  );
  return removeEventListener;
}

/**
 * Returns the control, found by role rather than by its label, since the label changes per state.
 *
 * @returns The appearance control's button element.
 */
function control(): HTMLElement {
  return screen.getByRole('button');
}

beforeEach(() => {
  changeHandlers = [];
  localStorage.clear();
  document.documentElement.style.removeProperty('color-scheme');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('DarkModeToggle', () => {
  describe('initial state', () => {
    it('starts in the system state when nothing is stored', () => {
      stubMatchMedia(false);

      render(<DarkModeToggle />);

      expect(control()).toHaveAccessibleName(/system/iu);
    });

    it.each(['light', 'dark'] as const)('starts in the stored %s state', (theme) => {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
      stubMatchMedia(false);

      render(<DarkModeToggle />);

      expect(control()).toHaveAccessibleName(new RegExp(theme, 'iu'));
    });

    // The state a two-state control cannot represent. With the OS preferring dark and nothing
    // stored, "system" and "dark" render the same scheme — but only "system" follows a later change
    // to the OS setting, so starting in the wrong one is a real defect rather than a cosmetic one.
    it('starts in the system state even when the OS already prefers dark', () => {
      stubMatchMedia(true);

      render(<DarkModeToggle />);

      expect(control()).toHaveAccessibleName(/system/iu);
    });
  });

  describe('the cycle', () => {
    it('cycles system → light → dark → system', () => {
      stubMatchMedia(false);
      render(<DarkModeToggle />);

      expect(control()).toHaveAccessibleName(/system/iu);

      fireEvent.click(control());
      expect(control()).toHaveAccessibleName(/light/iu);
      expect(document.documentElement.style.colorScheme).toBe('light');
      expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');

      fireEvent.click(control());
      expect(control()).toHaveAccessibleName(/dark/iu);
      expect(document.documentElement.style.colorScheme).toBe('dark');
      expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');

      fireEvent.click(control());
      expect(control()).toHaveAccessibleName(/system/iu);
    });

    // Following the system preference is the *absence* of an override, not a third stored value.
    // Writing `color-scheme: light dark` here would shadow the `:root` rule with an identical value
    // and leave the document looking overridden to anything inspecting it.
    it('clears both the stored preference and the document override on returning to system', () => {
      localStorage.setItem(THEME_STORAGE_KEY, 'dark');
      stubMatchMedia(false);
      render(<DarkModeToggle />);

      fireEvent.click(control());

      expect(control()).toHaveAccessibleName(/system/iu);
      expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
      expect(document.documentElement.style.colorScheme).toBe('');
      expect(document.documentElement.getAttribute('style') ?? '').not.toContain('color-scheme');
    });

    it('completes a second full cycle', () => {
      stubMatchMedia(false);
      render(<DarkModeToggle />);

      for (let index = 0; index < 3; index += 1) {
        fireEvent.click(control());
      }

      expect(control()).toHaveAccessibleName(/system/iu);

      fireEvent.click(control());
      expect(control()).toHaveAccessibleName(/light/iu);
    });
  });

  describe('accessible name and target', () => {
    // The icon is decorative, so the accessible name is the only thing conveying the current state
    // to a screen reader. It must say both what the state is and what activating will do, or the
    // control announces itself identically in all three states.
    it.each([
      [0, /system/iu, /light/iu],
      [1, /light/iu, /dark/iu],
      [2, /dark/iu, /system/iu]
    ])('names the current state and the next one after %i clicks', (clicks, current, next) => {
      stubMatchMedia(false);
      render(<DarkModeToggle />);

      for (let index = 0; index < clicks; index += 1) {
        fireEvent.click(control());
      }

      const name = control().getAttribute('aria-label') ?? '';

      expect(name).toMatch(current);
      expect(name).toMatch(next);
    });

    it('keeps its icon decorative so the name is not read twice', () => {
      stubMatchMedia(false);
      render(<DarkModeToggle />);

      expect(control().querySelector('[aria-hidden="true"]')).not.toBeNull();
    });

    // A control whose icon changed size between states would shift the surrounding header layout on
    // every click. Every state renders at the same fixed dimensions for that reason.
    it.each([0, 1, 2])('renders a fixed icon size in every state (%i clicks)', (clicks) => {
      stubMatchMedia(false);
      render(<DarkModeToggle />);

      for (let index = 0; index < clicks; index += 1) {
        fireEvent.click(control());
      }

      const icon = control().querySelector('svg');

      expect(icon).toHaveAttribute('width', '18');
      expect(icon).toHaveAttribute('height', '18');
    });
  });

  describe('the OS preference', () => {
    // Only meaningful in the system state: once an explicit choice is stored, the OS preference no
    // longer decides anything, so listening to it would be dead weight.
    it('tracks a live OS preference change while in the system state', () => {
      stubMatchMedia(false);
      render(<DarkModeToggle />);

      expect(changeHandlers.length).toBeGreaterThan(0);

      stubMatchMedia(true);
      act(() => {
        for (const handler of changeHandlers) {
          handler();
        }
      });

      // Still following the system, which is the point: the state did not change, only the scheme
      // the system reports.
      expect(control()).toHaveAccessibleName(/system/iu);
    });

    it('registers no OS listener once an explicit preference is stored', () => {
      localStorage.setItem(THEME_STORAGE_KEY, 'light');
      stubMatchMedia(true);

      render(<DarkModeToggle />);

      expect(changeHandlers).toHaveLength(0);
    });

    it('removes its listener on unmount', () => {
      const removeEventListener = stubMatchMedia(false);

      render(<DarkModeToggle />).unmount();

      expect(removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    });
  });

  describe('styling hook', () => {
    it('defaults to the shared button class', () => {
      stubMatchMedia(false);
      render(<DarkModeToggle />);

      expect(control()).toHaveClass('button');
    });

    // The editor renders its own instance inside a toolbar with a different button style, so the
    // class has to be overridable without a second component.
    it('accepts a caller-supplied class', () => {
      stubMatchMedia(false);
      render(<DarkModeToggle className="toolbar__button" />);

      expect(control()).toHaveClass('toolbar__button');
      expect(control()).not.toHaveClass('button');
    });
  });
});
