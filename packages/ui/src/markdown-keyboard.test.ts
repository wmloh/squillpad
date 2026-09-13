import { describe, expect, it } from "vitest";

import { calculateMarkdownEditorKeyboardAdjustment } from "./markdown-keyboard";

describe("Markdown editor keyboard avoidance", () => {
  it("returns no adjustment when the canvas is within the visible viewport", () => {
    expect(
      calculateMarkdownEditorKeyboardAdjustment(
        { top: 250, bottom: 550, height: 300 },
        { top: 100, bottom: 700, height: 600 },
        { top: 0, bottom: 720 },
        -24,
      ),
    ).toEqual({ offsetY: 0 });
  });

  it("moves an overlapping editor above the visible viewport bottom", () => {
    expect(
      calculateMarkdownEditorKeyboardAdjustment(
        { top: 350, bottom: 650, height: 300 },
        { top: 100, bottom: 900, height: 800 },
        { top: 0, bottom: 500 },
        0,
      ),
    ).toEqual({ maxHeight: 376, offsetY: -162 });
  });

  it("preserves an existing offset while the editor remains visible", () => {
    expect(
      calculateMarkdownEditorKeyboardAdjustment(
        { top: 120, bottom: 420, height: 300 },
        { top: 100, bottom: 900, height: 800 },
        { top: 0, bottom: 500 },
        -100,
      ),
    ).toEqual({ maxHeight: 376, offsetY: -100 });
  });
});
