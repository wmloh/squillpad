/** Minimum width for pen strokes. */
export const PEN_WIDTH_MIN = 2;

/** Maximum width for pen strokes. */
export const PEN_WIDTH_MAX = 30;

/** Minimum width for shape outlines, matching pen strokes. */
export const DRAWING_WIDTH_MIN = PEN_WIDTH_MIN;

/** Width range and slider step for highlighter strokes. */
export const HIGHLIGHTER_WIDTH_MIN = 10;
export const HIGHLIGHTER_WIDTH_MAX = 40;
export const HIGHLIGHTER_WIDTH_STEP = 2;

/** Maximum width for semantic shape outlines. */
export const SHAPE_WIDTH_MAX = PEN_WIDTH_MAX;

/** Clamps an ink width to the limit for its drawing tool. */
export function clampInkWidth(value: number, highlighter: boolean): number {
  if (highlighter) {
    const clamped = Math.min(HIGHLIGHTER_WIDTH_MAX, Math.max(HIGHLIGHTER_WIDTH_MIN, value));
    return (
      HIGHLIGHTER_WIDTH_MIN +
      Math.round((clamped - HIGHLIGHTER_WIDTH_MIN) / HIGHLIGHTER_WIDTH_STEP) *
        HIGHLIGHTER_WIDTH_STEP
    );
  }
  return Math.min(PEN_WIDTH_MAX, Math.max(PEN_WIDTH_MIN, Math.round(value)));
}

/** Clamps a semantic shape outline width to the shared shape limit. */
export function clampShapeWidth(value: number): number {
  return Math.min(SHAPE_WIDTH_MAX, Math.max(DRAWING_WIDTH_MIN, Math.round(value)));
}
