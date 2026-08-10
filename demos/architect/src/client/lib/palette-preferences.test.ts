import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getStoredCollapsedCategories,
  PALETTE_COLLAPSED_STORAGE_KEY,
  setStoredCollapsedCategories,
} from "./palette-preferences";

describe("palette-preferences", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe("getStoredCollapsedCategories", () => {
    it("seeds every category except compute as collapsed when nothing is stored", () => {
      expect(getStoredCollapsedCategories()).toEqual({
        ai: true,
        compute: false,
        external: true,
        media: true,
        network: true,
        storage: true,
      });
    });

    it("returns a stored valid collapsed list", () => {
      localStorage.setItem(
        PALETTE_COLLAPSED_STORAGE_KEY,
        JSON.stringify(["storage", "ai"]),
      );
      expect(getStoredCollapsedCategories()).toEqual({
        ai: true,
        compute: false,
        external: false,
        media: false,
        network: false,
        storage: true,
      });
    });

    it("treats an explicitly stored empty list as every category expanded, not the seeded default", () => {
      localStorage.setItem(PALETTE_COLLAPSED_STORAGE_KEY, JSON.stringify([]));
      expect(getStoredCollapsedCategories()).toEqual({
        ai: false,
        compute: false,
        external: false,
        media: false,
        network: false,
        storage: false,
      });
    });

    it("filters out unknown/stale category ids from a stored list", () => {
      localStorage.setItem(
        PALETTE_COLLAPSED_STORAGE_KEY,
        JSON.stringify(["storage", "not-a-real-category"]),
      );
      expect(getStoredCollapsedCategories().storage).toBe(true);
      expect(Object.keys(getStoredCollapsedCategories())).not.toContain(
        "not-a-real-category",
      );
    });

    it("falls back to the seeded default when the stored value isn't a JSON array", () => {
      localStorage.setItem(
        PALETTE_COLLAPSED_STORAGE_KEY,
        JSON.stringify({ storage: true }),
      );
      expect(getStoredCollapsedCategories().compute).toBe(false);
      expect(getStoredCollapsedCategories().storage).toBe(true);
    });

    it("falls back to the seeded default when the stored value isn't valid JSON", () => {
      localStorage.setItem(PALETTE_COLLAPSED_STORAGE_KEY, "not json");
      expect(getStoredCollapsedCategories().compute).toBe(false);
      expect(getStoredCollapsedCategories().storage).toBe(true);
    });

    it("falls back to the seeded default when localStorage access throws", () => {
      const spy = vi
        .spyOn(Storage.prototype, "getItem")
        .mockImplementation(() => {
          throw new Error("blocked");
        });
      expect(getStoredCollapsedCategories().compute).toBe(false);
      expect(getStoredCollapsedCategories().storage).toBe(true);
      spy.mockRestore();
    });
  });

  describe("setStoredCollapsedCategories", () => {
    it("persists only the collapsed category keys as a JSON array", () => {
      setStoredCollapsedCategories({
        ai: false,
        compute: true,
        storage: true,
      });
      expect(
        JSON.parse(localStorage.getItem(PALETTE_COLLAPSED_STORAGE_KEY) ?? "[]"),
      ).toEqual(["compute", "storage"]);
    });

    it("round-trips through getStoredCollapsedCategories", () => {
      setStoredCollapsedCategories({ media: true, network: true });
      expect(getStoredCollapsedCategories()).toEqual({
        ai: false,
        compute: false,
        external: false,
        media: true,
        network: true,
        storage: false,
      });
    });

    it("silently tolerates a localStorage write failure", () => {
      const spy = vi
        .spyOn(Storage.prototype, "setItem")
        .mockImplementation(() => {
          throw new Error("blocked");
        });
      expect(() =>
        setStoredCollapsedCategories({ compute: true }),
      ).not.toThrow();
      spy.mockRestore();
    });
  });
});
