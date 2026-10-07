import { useCallback, useEffect, useState } from 'react';
import { Monitor, Moon, Sun } from 'react-feather';
import {
  applyTheme,
  clearAppliedTheme,
  clearStoredTheme,
  getStoredTheme,
  setStoredTheme,
  type Theme
} from '../lib/theme.ts';

/**
 * The three states the appearance control cycles through.
 *
 * `'system'` is not a stored value — it is the absence of one, which is why `../lib/theme.ts`'s
 * {@link Theme} has only two members. The distinction is load-bearing rather than pedantic: with a
 * dark OS preference, `'system'` and `'dark'` paint identically, but only `'system'` follows the
 * user later changing that preference.
 */
type Appearance = 'system' | Theme;

/**
 * The cycle order, and the single source of truth for "what does clicking do next".
 */
const CYCLE: Appearance[] = ['system', 'light', 'dark'];

/**
 * Human-readable name for each state, used to build the control's accessible name.
 */
const APPEARANCE_LABELS: Record<Appearance, string> = {
  dark: 'Dark',
  light: 'Light',
  system: 'System'
};

/**
 * Rendered icon size, in pixels.
 *
 * Fixed across all three states on purpose. An icon that changed size between states would reflow
 * the surrounding header on every click, which is both visually jarring and — because the control
 * sits in a flex row with the identity and sign-out controls — would shift its own neighbours.
 */
const ICON_SIZE = 18;

/**
 * Icon for each state. A monitor for "follow the system", and the destination scheme's own glyph
 * for the two explicit choices.
 */
const APPEARANCE_ICONS: Record<Appearance, typeof Monitor> = {
  dark: Moon,
  light: Sun,
  system: Monitor
};

/**
 * Reads the appearance the document is currently in.
 *
 * @returns The stored explicit preference, or `'system'` when none is stored.
 */
function currentAppearance(): Appearance {
  return getStoredTheme() ?? 'system';
}

/**
 * Returns the state that follows another in the cycle.
 *
 * @param appearance Current state.
 * @returns The next state, wrapping from `'dark'` back to `'system'`.
 */
function nextAppearance(appearance: Appearance): Appearance {
  return CYCLE[(CYCLE.indexOf(appearance) + 1) % CYCLE.length] as Appearance;
}

/**
 * Props for {@link DarkModeToggle}.
 */
export interface DarkModeToggleProps {
  /**
   * CSS class for the underlying `<button>`, so one component fits both the shared header's button
   * style and the editor toolbar's. Defaults to the generic `.button` class used outside the
   * toolbar.
   */
  className?: string;
}

/**
 * The appearance control, cycling system → light → dark → system.
 *
 * Mounted in two places that are never on screen together: the shared application header, and the
 * editor's own toolbar — the editor route renders no header, so its toolbar carries its own
 * instance. Each tracks its own state, but both read and write the same storage key, so a change
 * made in one is picked up the next time the other mounts.
 *
 * @param props Styling hook; see {@link DarkModeToggleProps}.
 * @returns The appearance control.
 */
export function DarkModeToggle({ className = 'button' }: DarkModeToggleProps) {
  const [appearance, setAppearance] = useState<Appearance>(currentAppearance);

  // Re-renders when the OS preference changes, but only while following it: once an explicit choice
  // is stored, nothing this component renders depends on the OS preference any more, so subscribing
  // would be dead weight. The dependency on `appearance` is what re-evaluates that on every change.
  useEffect(() => {
    if (appearance !== 'system' || typeof window.matchMedia !== 'function') {
      // No subscription to tear down, so the cleanup is a no-op rather than absent: an effect that
      // returns a function on one path and nothing on another is the shape that later grows into a
      // leaked listener.
      return () => {};
    }

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (): void => {
      // The state is unchanged — still 'system' — so this exists purely to repaint the icon's
      // tooltip and any style keyed off the scheme actually in force.
      setAppearance('system');
    };

    media.addEventListener('change', handleChange);
    return () => {
      media.removeEventListener('change', handleChange);
    };
  }, [appearance]);

  const advance = useCallback(() => {
    const next = nextAppearance(appearance);

    if (next === 'system') {
      clearStoredTheme();
      clearAppliedTheme();
    } else {
      applyTheme(next);
      setStoredTheme(next);
    }

    setAppearance(next);
  }, [appearance]);

  const Icon = APPEARANCE_ICONS[appearance];
  const nextLabel = APPEARANCE_LABELS[nextAppearance(appearance)];

  // The icon is decorative, so this name is the only thing telling a screen-reader user which of
  // three states the control is in. Naming the next state as well makes the control's effect
  // predictable without activating it to find out.
  const label = `Appearance: ${APPEARANCE_LABELS[appearance]}. Switch to ${nextLabel}.`;

  return (
    <button type="button" className={className} onClick={advance} title={label} aria-label={label}>
      <Icon size={ICON_SIZE} width={ICON_SIZE} height={ICON_SIZE} aria-hidden="true" />
    </button>
  );
}
