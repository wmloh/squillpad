export interface MarkdownEditorRect {
  readonly top: number;
  readonly bottom: number;
  readonly height: number;
}

export interface MarkdownEditorViewportRect {
  readonly top: number;
  readonly bottom: number;
}

export interface MarkdownEditorKeyboardAdjustment {
  readonly offsetY: number;
  readonly maxHeight?: number;
}

const MARKDOWN_EDITOR_KEYBOARD_MARGIN_PX = 12;

/** Calculates the smallest keyboard avoidance adjustment for the editor popover. */
export function calculateMarkdownEditorKeyboardAdjustment(
  editorRect: MarkdownEditorRect,
  surfaceRect: MarkdownEditorRect,
  viewportRect: MarkdownEditorViewportRect,
  currentOffsetY: number,
): MarkdownEditorKeyboardAdjustment {
  if (editorRect.height <= 0 || surfaceRect.bottom <= viewportRect.bottom + 1) {
    return { offsetY: 0 };
  }

  const visibleTop =
    Math.max(surfaceRect.top, viewportRect.top) + MARKDOWN_EDITOR_KEYBOARD_MARGIN_PX;
  const visibleBottom =
    Math.min(surfaceRect.bottom, viewportRect.bottom) - MARKDOWN_EDITOR_KEYBOARD_MARGIN_PX;
  const availableHeight = visibleBottom - visibleTop;
  const maxHeight = availableHeight > 0 ? availableHeight : undefined;
  let offsetY = currentOffsetY;

  if (editorRect.bottom > visibleBottom) {
    offsetY += visibleBottom - editorRect.bottom;
  } else if (editorRect.top < visibleTop) {
    offsetY += visibleTop - editorRect.top;
  }

  return maxHeight === undefined ? { offsetY } : { maxHeight, offsetY };
}
