import { describe, expect, it } from "vitest";

import {
  DRAWING_PALETTE_SLOT_COUNT,
  isProfileDrawingPalettes,
  type ProfileDrawingPalettes,
} from "./profile-preferences";

function palettes(): ProfileDrawingPalettes {
  const slots = Array.from({ length: DRAWING_PALETTE_SLOT_COUNT }, (_, index) => ({
    color: `#${String(index + 1).repeat(6)}`,
    width: index + 1,
    opacity: index / DRAWING_PALETTE_SLOT_COUNT,
  }));
  return {
    pen: { custom: false, selectedIndex: 0, slots },
    highlighter: { custom: true, selectedIndex: 2, slots },
    shape: { custom: false, selectedIndex: 1, slots },
  };
}

describe("profile drawing palettes", () => {
  it("accepts the six-slot profile shape", () => {
    expect(isProfileDrawingPalettes(palettes())).toBe(true);
  });

  it("rejects malformed slots and indexes", () => {
    const value = palettes();
    expect(
      isProfileDrawingPalettes({
        ...value,
        pen: { ...value.pen, selectedIndex: DRAWING_PALETTE_SLOT_COUNT },
      }),
    ).toBe(false);
    expect(
      isProfileDrawingPalettes({
        ...value,
        shape: { ...value.shape, slots: value.shape.slots.slice(0, -1) },
      }),
    ).toBe(false);
    expect(
      isProfileDrawingPalettes({
        ...value,
        highlighter: {
          ...value.highlighter,
          slots: value.highlighter.slots.map((slot, index) =>
            index === 0 ? { ...slot, opacity: 1.1 } : slot,
          ),
        },
      }),
    ).toBe(false);
  });
});
