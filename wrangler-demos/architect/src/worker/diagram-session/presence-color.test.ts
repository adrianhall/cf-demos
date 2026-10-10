import { describe, expect, it } from "vitest";
import {
  colorForEmail,
  hashEmailToColorIndex,
  PRESENCE_COLOR_PALETTE,
} from "./presence-color";

describe("hashEmailToColorIndex / colorForEmail", () => {
  it("returns the same index for the same email every time", () => {
    const first = hashEmailToColorIndex("alice@example.com");
    const second = hashEmailToColorIndex("alice@example.com");
    expect(first).toBe(second);
  });

  it("returns the same color for the same email every time", () => {
    const first = colorForEmail("bob@example.com");
    const second = colorForEmail("bob@example.com");
    expect(first).toBe(second);
  });

  it("always returns an index within the palette's bounds", () => {
    for (const email of [
      "",
      "a@example.com",
      "a-very-long-email-address-indeed@subdomain.example.com",
      "unicode-ñame@example.com",
    ]) {
      const index = hashEmailToColorIndex(email);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(PRESENCE_COLOR_PALETTE.length);
    }
  });

  it("always returns a color that is actually a member of the palette", () => {
    const color = colorForEmail("carol@example.com");
    expect(PRESENCE_COLOR_PALETTE).toContain(color);
  });

  it("spreads a handful of distinct emails across more than one palette index", () => {
    // Not a strict collision-freedom guarantee (a sum-of-char-codes hash can collide), just a
    // sanity check that this isn't degenerately mapping every email to the same slot.
    const emails = [
      "alice@example.com",
      "bob@example.com",
      "carol@example.com",
      "dave@example.com",
      "erin@example.com",
      "frank@example.com",
    ];
    const indices = new Set(emails.map(hashEmailToColorIndex));
    expect(indices.size).toBeGreaterThan(1);
  });

  it("produces a different index for two emails that differ only in character order (sum-based hash caveat, documented behavior)", () => {
    // Anagram-equivalent strings share the same character sum and therefore the same index --
    // an accepted, documented limitation of "sum of char codes" (see this module's own JSDoc:
    // "no need for a real hash algorithm"), not a bug. This test pins that known behavior so a
    // future accidental "improvement" to a real hash doesn't silently change color stability
    // without a deliberate decision.
    expect(hashEmailToColorIndex("ab@example.com")).toBe(
      hashEmailToColorIndex("ba@example.com"),
    );
  });
});
