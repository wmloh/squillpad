import { describe, expect, it } from "vitest";

import {
  DEFAULT_DRAWING_PREFERENCES,
  DEFAULT_PROFILE_DRAWING_PALETTES,
  DRAWING_PREFERENCES_KEY,
  HIGHLIGHTER_WIDTH_MAX,
  HIGHLIGHTER_WIDTH_MIN,
  HIGHLIGHTER_WIDTH_STEP,
  INK_PALETTE,
  INK_WIDTH_MAX,
  INK_WIDTH_MIN,
  loadDrawingPreferences,
  loadProfileDrawingPreferences,
  normalizeProfileDrawingPalettes,
  SHAPE_WIDTH_MAX,
  saveDrawingPreferences,
} from "./drawing-preferences";
import { clampInkWidth } from "./drawing-limits";

describe("drawing preferences", () => {
  it("exposes the ordered six-color ink palette", () => {
    expect(INK_PALETTE).toEqual(["#9ca3af", "#60a5fa", "#fb923c", "#4ade80", "#f87171", "#c4b5fd"]);
  });

  it("starts pen and highlighter colors at the first palette color", () => {
    expect(DEFAULT_DRAWING_PREFERENCES.pen.color).toBe(INK_PALETTE[0]);
    expect(DEFAULT_DRAWING_PREFERENCES.highlighter.color).toBe(INK_PALETTE[0]);
  });

  it("enables the fullscreen radial toolbar by default", () => {
    expect(DEFAULT_DRAWING_PREFERENCES.radialToolbarEnabled).toBe(true);
    expect(
      loadDrawingPreferences({
        getItem: () =>
          JSON.stringify({ ...DEFAULT_DRAWING_PREFERENCES, radialToolbarEnabled: false }),
      }).radialToolbarEnabled,
    ).toBe(false);
  });

  it("round-trips local tool style without project persistence", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const preferences = {
      ...DEFAULT_DRAWING_PREFERENCES,
      lastTool: "pen" as const,
      pen: { ...DEFAULT_DRAWING_PREFERENCES.pen, color: "#123456", width: 7 },
    };
    saveDrawingPreferences(preferences, storage);
    expect(values.has(DRAWING_PREFERENCES_KEY)).toBe(true);
    expect(loadDrawingPreferences(storage)).toEqual(preferences);
  });

  it("falls back safely for malformed stored data", () => {
    expect(loadDrawingPreferences({ getItem: () => "not json" })).toBe(DEFAULT_DRAWING_PREFERENCES);
  });

  it("migrates the retired standalone lasso tool to Select", () => {
    const stored = JSON.stringify({ ...DEFAULT_DRAWING_PREFERENCES, lastTool: "lasso" });
    expect(loadDrawingPreferences({ getItem: () => stored }).lastTool).toBe("select");
  });

  it("clamps persisted ink widths to each tool's slider range", () => {
    const stored = JSON.stringify({
      ...DEFAULT_DRAWING_PREFERENCES,
      pen: { ...DEFAULT_DRAWING_PREFERENCES.pen, width: 90.4 },
      highlighter: { ...DEFAULT_DRAWING_PREFERENCES.highlighter, width: 90.4 },
      eraserWidth: 90.4,
      shape: { ...DEFAULT_DRAWING_PREFERENCES.shape, strokeWidth: 90.4 },
    });
    const preferences = loadDrawingPreferences({ getItem: () => stored });
    expect(preferences.pen.width).toBe(INK_WIDTH_MAX);
    expect(preferences.highlighter.width).toBe(HIGHLIGHTER_WIDTH_MAX);
    expect(preferences.eraserWidth).toBe(INK_WIDTH_MAX);
    expect(preferences.shape.strokeWidth).toBe(SHAPE_WIDTH_MAX);
    expect(INK_WIDTH_MIN).toBe(2);
    expect(HIGHLIGHTER_WIDTH_MIN).toBe(10);
    expect(HIGHLIGHTER_WIDTH_STEP).toBe(2);
  });

  it("starts highlighters at the minimum height", () => {
    expect(DEFAULT_DRAWING_PREFERENCES.highlighter.width).toBe(HIGHLIGHTER_WIDTH_MIN);
  });

  it("moves highlighter heights in two-pixel increments", () => {
    expect(clampInkWidth(9, true)).toBe(10);
    expect(clampInkWidth(11, true)).toBe(12);
    expect(clampInkWidth(39, true)).toBe(40);
    expect(clampInkWidth(45, true)).toBe(40);
  });

  it("seeds independent profile palettes with default styles", () => {
    expect(DEFAULT_PROFILE_DRAWING_PALETTES.pen.slots).toHaveLength(6);
    expect(DEFAULT_PROFILE_DRAWING_PALETTES.pen.slots[0]).toEqual({
      color: INK_PALETTE[0],
      width: DEFAULT_DRAWING_PREFERENCES.pen.width,
      opacity: 1,
    });
    expect(DEFAULT_PROFILE_DRAWING_PALETTES.highlighter.slots[0]?.opacity).toBe(0.35);
    expect(DEFAULT_PROFILE_DRAWING_PALETTES.shape.slots[0]?.opacity).toBe(1);
  });

  it("normalizes profile palette widths while preserving custom mode", () => {
    const stored = JSON.parse(JSON.stringify(DEFAULT_PROFILE_DRAWING_PALETTES));
    stored.pen.custom = true;
    stored.pen.selectedIndex = 4;
    stored.pen.slots[4].width = 90;
    stored.highlighter.slots[2].width = 9;
    const normalized = normalizeProfileDrawingPalettes(stored);
    expect(normalized.pen.custom).toBe(true);
    expect(normalized.pen.selectedIndex).toBe(4);
    expect(normalized.pen.slots[4]?.width).toBe(INK_WIDTH_MAX);
    expect(normalized.highlighter.slots[2]?.width).toBe(HIGHLIGHTER_WIDTH_MIN);
  });

  it("keeps account caches isolated while migrating the old cache once", () => {
    const values = new Map<string, string>([
      [
        DRAWING_PREFERENCES_KEY,
        JSON.stringify({ ...DEFAULT_DRAWING_PREFERENCES, lastTool: "pen" }),
      ],
    ]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };

    expect(loadProfileDrawingPreferences(storage, "alice").lastTool).toBe("pen");
    expect(loadProfileDrawingPreferences(storage, "bob")).toBe(DEFAULT_DRAWING_PREFERENCES);
  });
});
