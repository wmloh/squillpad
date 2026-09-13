import { describe, expect, it } from "vitest";

import {
  linearizeMarkdownBlocks,
  markdownExportBlocks,
  markdownSourceForElement,
  orderMarkdownBlocks,
  type CanvasRecord,
} from "./index";

const FIRST_ID = "323e4567-e89b-42d3-a456-426614174002";
const SECOND_ID = "423e4567-e89b-42d3-a456-426614174003";
const INK_ID = "523e4567-e89b-42d3-a456-426614174004";

const first: CanvasRecord = {
  kind: "markdown",
  id: FIRST_ID,
  position: [160, 20],
  z: 2,
  width: 200,
  height: 80,
  source: `markdown/${FIRST_ID}.md`,
};
const second: CanvasRecord = {
  kind: "markdown",
  id: SECOND_ID,
  position: [10, 20],
  z: 1,
  width: 200,
  height: 80,
  source: `markdown/${SECOND_ID}.md`,
};
const ink: CanvasRecord = {
  kind: "ink",
  id: INK_ID,
  position: [0, 0],
  z: 0,
  points: [[0, 0]],
  style: { color: "#111111", width: 4, opacity: 1, highlighter: false },
};

describe("Markdown interoperability", () => {
  it("orders blocks top-to-bottom and left-to-right without mutating the page", () => {
    const elements = [first, ink, second];
    expect(orderMarkdownBlocks(elements).map((element) => element.id)).toEqual([
      SECOND_ID,
      FIRST_ID,
    ]);
    expect(elements).toEqual([first, ink, second]);
  });

  it("round-trips imported source semantics and leaves relative asset links untouched", () => {
    const source =
      "# Imported\n\n![diagram](assets/diagram.svg)\n\n$\\alpha^2$\n\n- supported syntax";
    const sources = { [FIRST_ID]: source };

    expect(markdownSourceForElement(first, sources)).toBe(source);
    expect(markdownExportBlocks([first], sources)).toEqual([{ record: first, source }]);
    expect(linearizeMarkdownBlocks([first], sources)).toBe(source);
  });

  it("documents the unavoidable separator used by a two-dimensional page export", () => {
    expect(
      linearizeMarkdownBlocks([first, second], { [FIRST_ID]: "top", [SECOND_ID]: "left" }),
    ).toBe("left\n\ntop");
  });
});
