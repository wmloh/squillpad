import {
  DRAWING_PALETTE_SLOT_COUNT,
  isProfileDrawingPalettes,
  type DrawingPalettePreferences,
  type DrawingPaletteSlot,
  type InkStyle,
  type ProfileDrawingPreferences,
  type ProfileDrawingTool,
  type ProfileDrawingPalettes,
  type ShapeStyle,
} from "@squillpad/core-model";

import {
  clampInkWidth,
  clampShapeWidth,
  DRAWING_WIDTH_MIN,
  HIGHLIGHTER_WIDTH_MIN,
  PEN_WIDTH_MIN,
  PEN_WIDTH_MAX,
} from "./drawing-limits";
import { DEFAULT_INK_STYLE } from "./ink-engine";

export const DRAWING_PREFERENCES_KEY = "squillpad:drawing-preferences:v1";
const DRAWING_PREFERENCES_OWNER_KEY = "squillpad:drawing-preferences-owner:v1";

export const INK_WIDTH_MIN = PEN_WIDTH_MIN;
export const INK_WIDTH_MAX = PEN_WIDTH_MAX;
export {
  HIGHLIGHTER_WIDTH_MAX,
  HIGHLIGHTER_WIDTH_MIN,
  HIGHLIGHTER_WIDTH_STEP,
  PEN_WIDTH_MIN,
  PEN_WIDTH_MAX,
  SHAPE_WIDTH_MAX,
} from "./drawing-limits";

export const INK_PALETTE = [
  "#9ca3af",
  "#60a5fa",
  "#fb923c",
  "#4ade80",
  "#f87171",
  "#c4b5fd",
] as const;

export type DrawingPaletteKind = "pen" | "highlighter" | "shape";

export type DrawingTool = ProfileDrawingTool;
export type DrawingPreferences = ProfileDrawingPreferences;

export const DEFAULT_DRAWING_PREFERENCES: DrawingPreferences = {
  lastTool: "select",
  pen: { ...DEFAULT_INK_STYLE, color: INK_PALETTE[0] },
  highlighter: {
    ...DEFAULT_INK_STYLE,
    color: INK_PALETTE[0],
    width: HIGHLIGHTER_WIDTH_MIN,
    opacity: 0.35,
    highlighter: true,
  },
  penDrawsTouchNavigates: true,
  radialToolbarEnabled: true,
  eraserMode: "stroke",
  eraserWidth: 14,
  shape: { strokeColor: "#38245f", strokeWidth: 3, fillColor: null, opacity: 1 },
};

/** Default six-slot styles used to seed and reset profile palettes. */
export const DEFAULT_PROFILE_DRAWING_PALETTES: ProfileDrawingPalettes = {
  pen: createDefaultPalette(DEFAULT_INK_STYLE.width, DEFAULT_INK_STYLE.opacity),
  highlighter: createDefaultPalette(
    HIGHLIGHTER_WIDTH_MIN,
    DEFAULT_DRAWING_PREFERENCES.highlighter.opacity,
  ),
  shape: createDefaultPalette(3, 1),
};

/** Returns a validated, range-clamped copy of profile palettes from the auth API. */
export function normalizeProfileDrawingPalettes(value: unknown): ProfileDrawingPalettes {
  if (!isProfileDrawingPalettes(value)) return cloneProfileDrawingPalettes();
  return {
    pen: normalizePalette(value.pen, DEFAULT_PROFILE_DRAWING_PALETTES.pen, false),
    highlighter: normalizePalette(
      value.highlighter,
      DEFAULT_PROFILE_DRAWING_PALETTES.highlighter,
      true,
    ),
    shape: normalizeShapePalette(value.shape),
  };
}

/** Clones the built-in profile defaults so callers can safely update nested values. */
export function cloneProfileDrawingPalettes(): ProfileDrawingPalettes {
  return {
    pen: clonePalette(DEFAULT_PROFILE_DRAWING_PALETTES.pen),
    highlighter: clonePalette(DEFAULT_PROFILE_DRAWING_PALETTES.highlighter),
    shape: clonePalette(DEFAULT_PROFILE_DRAWING_PALETTES.shape),
  };
}

/** Returns the default slot for one palette and slot index. */
export function defaultProfilePaletteSlot(
  kind: DrawingPaletteKind,
  index: number,
): DrawingPaletteSlot {
  const palette = DEFAULT_PROFILE_DRAWING_PALETTES[kind];
  return { ...(palette.slots[index] ?? palette.slots[0]!) };
}

/** Reads validated local drawing preferences without touching project files. */
export function loadDrawingPreferences(
  storage?: Pick<Storage, "getItem">,
  profileUsername?: string,
): DrawingPreferences {
  return loadStoredDrawingPreferences(storage, drawingPreferencesKey(profileUsername));
}

/** Loads one account's cache, migrating the legacy unscoped cache only once. */
export function loadProfileDrawingPreferences(
  storage: Pick<Storage, "getItem" | "setItem"> | undefined,
  profileUsername: string,
): DrawingPreferences {
  if (storage === undefined) return DEFAULT_DRAWING_PREFERENCES;
  const profileKey = drawingPreferencesKey(profileUsername);
  try {
    if (storage.getItem(profileKey) !== null) {
      if (storage.getItem(DRAWING_PREFERENCES_OWNER_KEY) === null) {
        storage.setItem(DRAWING_PREFERENCES_OWNER_KEY, profileUsername);
      }
      return loadStoredDrawingPreferences(storage, profileKey);
    }
    const owner = storage.getItem(DRAWING_PREFERENCES_OWNER_KEY);
    if (owner !== null && owner !== profileUsername) return DEFAULT_DRAWING_PREFERENCES;
    const legacy = loadStoredDrawingPreferences(storage, DRAWING_PREFERENCES_KEY);
    storage.setItem(DRAWING_PREFERENCES_OWNER_KEY, profileUsername);
    storage.setItem(profileKey, JSON.stringify(legacy));
    return legacy;
  } catch {
    return DEFAULT_DRAWING_PREFERENCES;
  }
}

/** Stores drawing preferences in the optional account-specific browser cache. */
export function saveDrawingPreferences(
  preferences: DrawingPreferences,
  storage?: Pick<Storage, "setItem">,
  profileUsername?: string,
): void {
  try {
    storage?.setItem(drawingPreferencesKey(profileUsername), JSON.stringify(preferences));
  } catch {
    // Private browsing and restricted storage must not prevent notebook editing.
  }
}

export function drawingPreferencesKey(profileUsername?: string): string {
  return profileUsername === undefined
    ? DRAWING_PREFERENCES_KEY
    : `${DRAWING_PREFERENCES_KEY}:profile:${encodeURIComponent(profileUsername)}`;
}

function loadStoredDrawingPreferences(
  storage: Pick<Storage, "getItem"> | undefined,
  key: string,
): DrawingPreferences {
  if (storage === undefined) return DEFAULT_DRAWING_PREFERENCES;
  try {
    const value: unknown = JSON.parse(storage.getItem(key) ?? "null");
    if (!isRecord(value)) return DEFAULT_DRAWING_PREFERENCES;
    return {
      lastTool: drawingTool(value.lastTool),
      pen: inkStyle(value.pen, DEFAULT_DRAWING_PREFERENCES.pen),
      highlighter: inkStyle(value.highlighter, DEFAULT_DRAWING_PREFERENCES.highlighter),
      penDrawsTouchNavigates:
        typeof value.penDrawsTouchNavigates === "boolean"
          ? value.penDrawsTouchNavigates
          : DEFAULT_DRAWING_PREFERENCES.penDrawsTouchNavigates,
      radialToolbarEnabled:
        typeof value.radialToolbarEnabled === "boolean"
          ? value.radialToolbarEnabled
          : DEFAULT_DRAWING_PREFERENCES.radialToolbarEnabled,
      eraserMode: value.eraserMode === "segment" ? "segment" : "stroke",
      eraserWidth: positive(value.eraserWidth, DEFAULT_DRAWING_PREFERENCES.eraserWidth),
      shape: shapeStyle(value.shape, DEFAULT_DRAWING_PREFERENCES.shape),
    };
  } catch {
    return DEFAULT_DRAWING_PREFERENCES;
  }
}

function drawingTool(value: unknown): DrawingTool {
  if (value === "lasso") return "select";
  return isDrawingTool(value) ? value : DEFAULT_DRAWING_PREFERENCES.lastTool;
}

function isDrawingTool(value: unknown): value is DrawingTool {
  return (
    value === "select" ||
    value === "pan" ||
    value === "insert-space" ||
    value === "laser" ||
    value === "text" ||
    value === "pen" ||
    value === "highlighter" ||
    value === "eraser" ||
    value === "line" ||
    value === "arrow" ||
    value === "rectangle" ||
    value === "ellipse"
  );
}

function inkStyle(value: unknown, fallback: InkStyle): InkStyle {
  if (!isRecord(value)) return fallback;
  return {
    ...fallback,
    color: typeof value.color === "string" ? hexColor(value.color, fallback.color) : fallback.color,
    width: inkWidth(value.width, fallback.width, fallback.highlighter),
    opacity: unit(value.opacity, fallback.opacity),
  };
}

function createDefaultPalette(width: number, opacity: number): DrawingPalettePreferences {
  return {
    custom: false,
    selectedIndex: 0,
    slots: INK_PALETTE.map((color) => ({ color, width, opacity })),
  };
}

function normalizePalette(
  value: DrawingPalettePreferences,
  fallback: DrawingPalettePreferences,
  highlighter: boolean,
): DrawingPalettePreferences {
  return {
    custom: value.custom,
    selectedIndex: selectedPaletteIndex(value.selectedIndex),
    slots: value.slots.map((slot, index) => {
      const defaultSlot = fallback.slots[index] ?? fallback.slots[0]!;
      return {
        color: hexColor(slot.color, defaultSlot.color),
        width: clampInkWidth(slot.width, highlighter),
        opacity: unit(slot.opacity, defaultSlot.opacity),
      };
    }),
  };
}

function normalizeShapePalette(value: DrawingPalettePreferences): DrawingPalettePreferences {
  const fallback = DEFAULT_PROFILE_DRAWING_PALETTES.shape;
  return {
    custom: value.custom,
    selectedIndex: selectedPaletteIndex(value.selectedIndex),
    slots: value.slots.map((slot, index) => {
      const defaultSlot = fallback.slots[index] ?? fallback.slots[0]!;
      return {
        color: hexColor(slot.color, defaultSlot.color),
        width: shapeWidth(slot.width, defaultSlot.width),
        opacity: unit(slot.opacity, defaultSlot.opacity),
      };
    }),
  };
}

function clonePalette(value: DrawingPalettePreferences): DrawingPalettePreferences {
  return { ...value, slots: value.slots.map((slot) => ({ ...slot })) };
}

function selectedPaletteIndex(value: number): number {
  return Number.isInteger(value) && value >= 0 && value < DRAWING_PALETTE_SLOT_COUNT ? value : 0;
}

function hexColor(value: string, fallback: string): string {
  return /^#[0-9a-fA-F]{6}$/u.test(value) ? value.toLowerCase() : fallback;
}

function shapeStyle(value: unknown, fallback: ShapeStyle): ShapeStyle {
  if (!isRecord(value)) return fallback;
  return {
    strokeColor:
      typeof value.strokeColor === "string"
        ? hexColor(value.strokeColor, fallback.strokeColor)
        : fallback.strokeColor,
    strokeWidth: shapeWidth(value.strokeWidth, fallback.strokeWidth),
    fillColor: optionalHexColor(value.fillColor, fallback.fillColor),
    opacity: unit(value.opacity, fallback.opacity),
  };
}

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function inkWidth(value: unknown, fallback: number, highlighter: boolean): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return clampInkWidth(value, highlighter);
}

function shapeWidth(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return clampShapeWidth(value);
}

function optionalHexColor(value: unknown, fallback: string | null): string | null {
  return value === null
    ? null
    : typeof value === "string"
      ? hexColor(value, fallback ?? "#38245f")
      : fallback;
}

function unit(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
