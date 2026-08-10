import { useCallback, useEffect, useState } from "react";
import { Moon, Sun } from "react-feather";
import {
  applyTheme,
  getStoredTheme,
  isDarkActive,
  prefersDark,
  setStoredTheme,
  type Theme,
} from "../lib/theme";

/**
 * A single, reusable dark-mode toggle backed by `../lib/theme.ts`'s `localStorage` preference.
 * Ported from CF-Architect's `src/islands/toolbar/DarkToggle.tsx` (docs/09-ARCHITECT.md Phase
 * 5), adapted to this port's `color-scheme`-driven theming.
 *
 * CF-Architect renders its equivalent (`DarkToggle`) in two independent places -- a shared
 * `Navbar` on every "chrome" page (dashboard, admin, blueprints) and *again* inside the editor's
 * own `Toolbar`, since CF-Architect's editor page never renders that `Navbar` at all. This port's
 * `../views/AppShellView.tsx` header, by contrast, already wraps *both* the dashboard and the
 * editor (it is what carries the sign-out control across both), so a single instance there
 * covers both cases CF-Architect needed two components for; `../views/BlueprintsView.tsx`'s own
 * header gets its own instance for the same reason CF-Architect's `blueprints.astro` page did.
 *
 * Mounting more than one instance is safe: each tracks its own `dark` state independently, but
 * every instance reads and writes the same `THEME_STORAGE_KEY`, so a toggle in one instance is
 * reflected the next time any instance mounts (there is no cross-instance live sync while both
 * are mounted simultaneously, which never happens in this app -- the editor and the dashboard
 * are never both on screen at once).
 *
 * @param className CSS class for the underlying `<button>`, so this component fits either the
 * editor toolbar's (`../components/editor/toolbar/Toolbar.tsx`) or a page header's button style.
 * Defaults to the shared generic `.button` class used elsewhere outside the toolbar.
 */
export function DarkModeToggle({
  className = "button",
}: {
  className?: string;
}) {
  const [dark, setDark] = useState(isDarkActive);

  // Only the OS preference can change out from under this component while it's mounted -- once
  // the user has picked an explicit theme, `isDarkActive()` no longer depends on it at all.
  useEffect(() => {
    if (getStoredTheme()) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => setDark(prefersDark());
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  const toggle = useCallback(() => {
    const next: Theme = dark ? "light" : "dark";
    applyTheme(next);
    setStoredTheme(next);
    setDark(next === "dark");
  }, [dark]);

  return (
    <button
      type="button"
      className={className}
      onClick={toggle}
      title="Toggle dark mode"
      aria-pressed={dark}
      aria-label={dark ? "Light mode" : "Dark mode"}
    >
      {dark ? (
        <Sun size={18} aria-hidden="true" />
      ) : (
        <Moon size={18} aria-hidden="true" />
      )}
    </button>
  );
}
