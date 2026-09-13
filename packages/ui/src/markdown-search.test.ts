import { describe, expect, it } from "vitest";

import { searchMarkdown } from "./markdown-search";

describe("Markdown search", () => {
  it("indexes case-insensitive matches in visual canvas order", () => {
    const result = searchMarkdown(
      [
        {
          id: "markdown-two",
          kind: "markdown",
          position: [0, 0],
          z: 2,
          width: 100,
          height: 72,
          source: "",
        },
        {
          id: "markdown-one",
          kind: "markdown",
          position: [0, 0],
          z: 1,
          width: 100,
          height: 72,
          source: "",
        },
      ],
      { "markdown-one": "Alpha alpha", "markdown-two": "No match" },
      "alpha",
    );

    expect(result.blocks).toEqual([
      { elementId: "markdown-one", matchOffset: 0, matchCount: 2 },
      { elementId: "markdown-two", matchOffset: 2, matchCount: 0 },
    ]);
    expect(result.matches).toEqual([
      { elementId: "markdown-one", occurrence: 0, index: 0 },
      { elementId: "markdown-one", occurrence: 1, index: 1 },
    ]);
  });

  it("ignores empty and whitespace-only queries", () => {
    expect(searchMarkdown([], {}, "   ")).toEqual({ blocks: [], matches: [] });
  });
});
