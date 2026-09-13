/** The fixed number of slots shown in each customizable drawing palette. */
export const DRAWING_PALETTE_SLOT_COUNT = 6;

export interface DrawingPaletteSlot {
  readonly color: string;
  readonly width: number;
  readonly opacity: number;
}

export interface DrawingPalettePreferences {
  readonly custom: boolean;
  readonly selectedIndex: number;
  readonly slots: readonly DrawingPaletteSlot[];
}

/** Profile-scoped drawing palettes shared by a signed-in user across devices. */
export interface ProfileDrawingPalettes {
  readonly pen: DrawingPalettePreferences;
  readonly highlighter: DrawingPalettePreferences;
  readonly shape: DrawingPalettePreferences;
}

/** Checks the persisted profile palette shape without coercing user input. */
export function isProfileDrawingPalettes(value: unknown): value is ProfileDrawingPalettes {
  return (
    isRecord(value) &&
    isDrawingPalettePreferences(value.pen) &&
    isDrawingPalettePreferences(value.highlighter) &&
    isDrawingPalettePreferences(value.shape)
  );
}

function isDrawingPalettePreferences(value: unknown): value is DrawingPalettePreferences {
  if (!isRecord(value)) return false;
  if (typeof value.custom !== "boolean") return false;
  if (
    typeof value.selectedIndex !== "number" ||
    !Number.isSafeInteger(value.selectedIndex) ||
    value.selectedIndex < 0 ||
    value.selectedIndex >= DRAWING_PALETTE_SLOT_COUNT
  ) {
    return false;
  }
  return (
    Array.isArray(value.slots) &&
    value.slots.length === DRAWING_PALETTE_SLOT_COUNT &&
    value.slots.every(isDrawingPaletteSlot)
  );
}

function isDrawingPaletteSlot(value: unknown): value is DrawingPaletteSlot {
  return (
    isRecord(value) &&
    isHexColor(value.color) &&
    isPositiveFiniteNumber(value.width) &&
    isUnitInterval(value.opacity)
  );
}

function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isUnitInterval(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
