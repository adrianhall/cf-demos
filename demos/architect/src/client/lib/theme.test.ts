import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyTheme,
  getStoredTheme,
  isDarkActive,
  prefersDark,
  setStoredTheme,
  THEME_STORAGE_KEY,
} from "./theme";

describe("theme", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.style.colorScheme = "";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("getStoredTheme", () => {
    it("returns null when nothing is stored", () => {
      expect(getStoredTheme()).toBeNull();
    });

    it("returns a stored valid theme", () => {
      localStorage.setItem(THEME_STORAGE_KEY, "dark");
      expect(getStoredTheme()).toBe("dark");
    });

    it("returns null for a stored value that isn't a valid theme", () => {
      localStorage.setItem(THEME_STORAGE_KEY, "sepia");
      expect(getStoredTheme()).toBeNull();
    });

    it("returns null when localStorage access throws", () => {
      const spy = vi
        .spyOn(Storage.prototype, "getItem")
        .mockImplementation(() => {
          throw new Error("blocked");
        });
      expect(getStoredTheme()).toBeNull();
      spy.mockRestore();
    });
  });

  describe("setStoredTheme", () => {
    it("persists the theme under the shared key", () => {
      setStoredTheme("light");
      expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    });

    it("silently tolerates a localStorage write failure", () => {
      const spy = vi
        .spyOn(Storage.prototype, "setItem")
        .mockImplementation(() => {
          throw new Error("blocked");
        });
      expect(() => setStoredTheme("dark")).not.toThrow();
      spy.mockRestore();
    });
  });

  describe("applyTheme", () => {
    it("sets an explicit color-scheme override on the document root", () => {
      applyTheme("dark");
      expect(document.documentElement.style.colorScheme).toBe("dark");
      applyTheme("light");
      expect(document.documentElement.style.colorScheme).toBe("light");
    });
  });

  describe("prefersDark", () => {
    it("reflects the OS-level media query", () => {
      vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
      expect(prefersDark()).toBe(true);
    });

    it("returns false when the OS prefers light", () => {
      vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
      expect(prefersDark()).toBe(false);
    });
  });

  describe("isDarkActive", () => {
    it("prefers an explicit stored theme over the OS preference", () => {
      vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
      setStoredTheme("dark");
      expect(isDarkActive()).toBe(true);
    });

    it("falls back to the OS preference with no stored theme", () => {
      vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
      expect(isDarkActive()).toBe(true);
    });
  });
});
