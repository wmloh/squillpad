/** Minimum height retained by a Markdown canvas block. */
export const MARKDOWN_BLOCK_HEIGHT_MIN = 72;

/** Generous safety limit for Markdown canvas block heights in CSS pixels. */
export const MARKDOWN_BLOCK_HEIGHT_MAX = 32_768;

/** Normalizes a measured Markdown height without feeding extra pixels back into layout. */
export function normalizeMarkdownBlockHeight(value: number): number | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(MARKDOWN_BLOCK_HEIGHT_MAX, Math.max(MARKDOWN_BLOCK_HEIGHT_MIN, Math.ceil(value)));
}

/** Converts intrinsic content height into the outer Markdown block height. */
export function markdownBlockHeightFromContent(
  contentHeight: number,
  verticalPadding: number,
  verticalBorder: number,
): number | undefined {
  if (
    !Number.isFinite(contentHeight) ||
    !Number.isFinite(verticalPadding) ||
    !Number.isFinite(verticalBorder) ||
    contentHeight < 0 ||
    verticalPadding < 0 ||
    verticalBorder < 0
  ) {
    return undefined;
  }
  return normalizeMarkdownBlockHeight(contentHeight + verticalPadding + verticalBorder);
}
