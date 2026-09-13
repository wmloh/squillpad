import { describe, expect, it } from "vitest";

import {
  MARKDOWN_BLOCK_HEIGHT_MAX,
  MARKDOWN_BLOCK_HEIGHT_MIN,
  markdownBlockHeightFromContent,
  normalizeMarkdownBlockHeight,
} from "./markdown-layout";

describe("Markdown block layout", () => {
  it("keeps the measured scroll height unchanged apart from rounding", () => {
    expect(normalizeMarkdownBlockHeight(144)).toBe(144);
    expect(normalizeMarkdownBlockHeight(144.2)).toBe(145);
  });

  it("bounds valid heights and rejects invalid measurements", () => {
    expect(normalizeMarkdownBlockHeight(1)).toBe(MARKDOWN_BLOCK_HEIGHT_MIN);
    expect(normalizeMarkdownBlockHeight(MARKDOWN_BLOCK_HEIGHT_MAX + 1)).toBe(
      MARKDOWN_BLOCK_HEIGHT_MAX,
    );
    expect(normalizeMarkdownBlockHeight(Number.NaN)).toBeUndefined();
    expect(normalizeMarkdownBlockHeight(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it("adds only the block box overhead to intrinsic content height", () => {
    expect(markdownBlockHeightFromContent(64, 17.6, 4)).toBe(86);
  });
});
