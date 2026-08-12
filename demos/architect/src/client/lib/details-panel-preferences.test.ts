import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DETAILS_PANEL_EXPANDED_STORAGE_KEY,
  getStoredDetailsPanelExpanded,
  setStoredDetailsPanelExpanded,
} from "./details-panel-preferences";

describe("details-panel-preferences", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe("getStoredDetailsPanelExpanded", () => {
    it("defaults to collapsed (false) when nothing is stored", () => {
      expect(getStoredDetailsPanelExpanded()).toBe(false);
    });

    it("returns true when the stored value is the literal string 'true'", () => {
      localStorage.setItem(DETAILS_PANEL_EXPANDED_STORAGE_KEY, "true");
      expect(getStoredDetailsPanelExpanded()).toBe(true);
    });

    it("returns false for a stored value of 'false'", () => {
      localStorage.setItem(DETAILS_PANEL_EXPANDED_STORAGE_KEY, "false");
      expect(getStoredDetailsPanelExpanded()).toBe(false);
    });

    it("returns false for a malformed stored value", () => {
      localStorage.setItem(DETAILS_PANEL_EXPANDED_STORAGE_KEY, "not-a-bool");
      expect(getStoredDetailsPanelExpanded()).toBe(false);
    });

    it("returns false when localStorage access throws", () => {
      const spy = vi
        .spyOn(Storage.prototype, "getItem")
        .mockImplementation(() => {
          throw new Error("blocked");
        });
      expect(getStoredDetailsPanelExpanded()).toBe(false);
      spy.mockRestore();
    });
  });

  describe("setStoredDetailsPanelExpanded", () => {
    it("persists true", () => {
      setStoredDetailsPanelExpanded(true);
      expect(localStorage.getItem(DETAILS_PANEL_EXPANDED_STORAGE_KEY)).toBe(
        "true",
      );
    });

    it("persists false", () => {
      setStoredDetailsPanelExpanded(false);
      expect(localStorage.getItem(DETAILS_PANEL_EXPANDED_STORAGE_KEY)).toBe(
        "false",
      );
    });

    it("round-trips through getStoredDetailsPanelExpanded", () => {
      setStoredDetailsPanelExpanded(true);
      expect(getStoredDetailsPanelExpanded()).toBe(true);
    });

    it("silently swallows a storage error", () => {
      const spy = vi
        .spyOn(Storage.prototype, "setItem")
        .mockImplementation(() => {
          throw new Error("blocked");
        });
      expect(() => setStoredDetailsPanelExpanded(true)).not.toThrow();
      spy.mockRestore();
    });
  });
});
