import { describe, expect, it } from "vitest";

import { createMarkdownInlineFormattingEdit, createMarkdownLinkEdit } from "./markdown-formatting";

describe("Markdown inline formatting", () => {
  it("wraps a selection and keeps the formatted text selected", () => {
    expect(createMarkdownInlineFormattingEdit("hello world", 6, 11, "**")).toEqual({
      changes: [{ from: 6, to: 11, insert: "**world**" }],
      selection: { anchor: 8, head: 13 },
    });
  });

  it("removes markers outside a selected range", () => {
    expect(createMarkdownInlineFormattingEdit("hello **world**", 8, 13, "**")).toEqual({
      changes: [
        { from: 6, to: 8, insert: "" },
        { from: 13, to: 15, insert: "" },
      ],
      selection: { anchor: 6, head: 11 },
    });
  });

  it("inserts an empty pair and places the cursor between markers", () => {
    expect(createMarkdownInlineFormattingEdit("hello", 5, 5, "*")).toEqual({
      changes: [{ from: 5, to: 5, insert: "**" }],
      selection: { anchor: 6, head: 6 },
    });
  });

  it("turns selected text into a link and selects its URL placeholder", () => {
    expect(createMarkdownLinkEdit("Read this", 0, 4)).toEqual({
      changes: [{ from: 0, to: 4, insert: "[Read](url)" }],
      selection: { anchor: 7, head: 10 },
    });
  });
});
