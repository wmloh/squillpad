import { describe, expect, it } from "vitest";

import type { CanvasElement } from "@squillpad/core-model";

import { applyGeometryPreviews, parseGeometryPreview } from "./geometry-preview";

const MARKDOWN_ID = "323e4567-e89b-42d3-a456-426614174002";
const markdown: CanvasElement = {
  id: MARKDOWN_ID,
  kind: "markdown",
  position: [10, 20],
  z: 0,
  width: 320,
  height: 160,
  source: `markdown/${MARKDOWN_ID}.md`,
};

describe("geometry previews", () => {
  it("projects movement and resize without mutating canonical elements", () => {
    const moved = applyGeometryPreviews(
      [markdown],
      [
        { kind: "move", elementIds: [MARKDOWN_ID], delta: { x: 5, y: -2 } },
        {
          kind: "resize",
          elementId: MARKDOWN_ID,
          bounds: { x: 15, y: 18, width: 400, height: 200 },
        },
      ],
    );

    expect(moved[0]).toMatchObject({
      position: [15, 18],
      width: 400,
      height: 200,
    });
    expect(markdown).toMatchObject({ position: [10, 20], width: 320, height: 160 });
  });

  it("rejects malformed awareness payloads", () => {
    expect(
      parseGeometryPreview({
        kind: "move",
        elementIds: [MARKDOWN_ID],
        delta: { x: 3, y: 4 },
      }),
    ).toEqual({
      kind: "move",
      elementIds: [MARKDOWN_ID],
      delta: { x: 3, y: 4 },
    });
    expect(parseGeometryPreview({ kind: "resize", elementId: MARKDOWN_ID, bounds: {} })).toBe(
      undefined,
    );
    expect(
      parseGeometryPreview({
        kind: "text-group-move",
        elementId: MARKDOWN_ID,
        deltaY: 18,
      }),
    ).toEqual({ kind: "text-group-move", elementId: MARKDOWN_ID, deltaY: 18 });
    expect(
      parseGeometryPreview({ kind: "text-group-move", elementId: MARKDOWN_ID, deltaY: "18" }),
    ).toBe(undefined);
    expect(parseGeometryPreview({ kind: "vertical-space", cutY: 120, distance: -24 })).toEqual({
      kind: "vertical-space",
      cutY: 120,
      distance: -24,
    });
  });
});
