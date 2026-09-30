import { describe, expect, it } from "vitest";

import {
  validateCanvasRecords,
  type CanvasElement,
  type InkCanvasRecord,
  type ShapeStyle,
} from "@squillpad/core-model";

import {
  acceptsDrawingPointer,
  createShapeRecord,
  elementContainsSelectionPoint,
  eraseElements,
  eraseInk,
  insertVerticalSpace,
  lassoSelectElements,
  lassoSelectInk,
  updateSelectedInkStyle,
  updateSelectedShapeStyle,
} from "./drawing-tools";

const ID = "423e4567-e89b-42d3-a456-426614174003";
const SHAPE_STYLE: ShapeStyle = {
  strokeColor: "#111111",
  strokeWidth: 2,
  fillColor: null,
  opacity: 1,
};
const ink: InkCanvasRecord = {
  id: ID,
  kind: "ink",
  position: [0, 0],
  z: 0,
  points: [
    [0, 0],
    [50, 0],
    [100, 0],
  ],
  style: { color: "#111111", width: 4, opacity: 1, highlighter: false },
};
const markdown: CanvasElement = {
  id: "a23e4567-e89b-42d3-a456-426614174009",
  kind: "markdown",
  position: [20, 20],
  z: 1,
  width: 80,
  height: 50,
  source: "markdown/a23e4567-e89b-42d3-a456-426614174009.md",
};

describe("drawing tools", () => {
  it("accepts pen and generic mouse drawing while reserving touch for navigation", () => {
    expect(acceptsDrawingPointer("pen", 0, true, true)).toBe(true);
    expect(acceptsDrawingPointer("mouse", 0, true, true)).toBe(true);
    expect(acceptsDrawingPointer("touch", 0, true, true)).toBe(false);
    expect(acceptsDrawingPointer("touch", 0, true, false)).toBe(true);
    expect(acceptsDrawingPointer("pen", 5, true, true)).toBe(true);
  });

  it("creates semantic constrained arrows and circles", () => {
    const arrow = createShapeRecord(
      ID,
      0,
      "arrow",
      { x: 10, y: 10 },
      { x: 34, y: 18 },
      SHAPE_STYLE,
      true,
    );
    expect(arrow.geometry.kind).toBe("arrow");
    if (arrow.geometry.kind === "arrow") expect(arrow.geometry.end[1]).toBe(0);
    const ellipse = createShapeRecord(
      ID,
      0,
      "ellipse",
      { x: 0, y: 0 },
      { x: 30, y: 10 },
      SHAPE_STYLE,
      true,
    );
    expect(ellipse.geometry).toMatchObject({
      kind: "ellipse",
      width: 30,
      height: 30,
    });
  });

  it("whole-stroke erases through an atomic immutable result", () => {
    expect(
      eraseInk(
        [ink],
        [
          { x: 50, y: -10 },
          { x: 50, y: 10 },
        ],
        3,
        "stroke",
      ),
    ).toEqual([]);
    expect(eraseInk([ink], [{ x: 200, y: 0 }], 3, "stroke")).toEqual([ink]);
    expect(
      eraseInk(
        [ink],
        [
          { x: 200, y: 0 },
          { x: 220, y: 0 },
        ],
        3,
        "stroke",
      ),
    ).toEqual([ink]);
  });

  it("splits segment-erased ink into deterministic editable records", () => {
    const first = eraseInk(
      [ink],
      [
        { x: 50, y: -5 },
        { x: 50, y: 5 },
      ],
      5,
      "segment",
    );
    const second = eraseInk(
      [ink],
      [
        { x: 50, y: -5 },
        { x: 50, y: 5 },
      ],
      5,
      "segment",
    );
    expect(first).toEqual(second);
    expect(first).toHaveLength(2);
    expect(first.every((element) => element.kind === "ink")).toBe(true);
    expect(validateCanvasRecords(first).success).toBe(true);
  });

  it("lassos by detailed stroke geometry after bounds prefiltering", () => {
    expect(
      lassoSelectInk(
        [ink],
        [
          { x: 40, y: -10 },
          { x: 60, y: -10 },
          { x: 60, y: 10 },
          { x: 40, y: 10 },
        ],
      ),
    ).toEqual(new Set([ID]));
    expect(
      lassoSelectInk(
        [ink],
        [
          { x: 120, y: -10 },
          { x: 140, y: -10 },
          { x: 140, y: 10 },
        ],
      ),
    ).toEqual(new Set());
  });

  it("hits ink strokes, dots and highlighters without hitting empty ink bounds", () => {
    const loop: InkCanvasRecord = {
      ...ink,
      points: [
        [0, 0],
        [100, 0],
        [100, 100],
        [0, 100],
        [0, 0],
      ],
      style: { ...ink.style, smoothing: 0 },
    };
    expect(elementContainsSelectionPoint(loop, { x: 50, y: 50 }, 4)).toBe(false);
    expect(elementContainsSelectionPoint(loop, { x: 50, y: 5 }, 4)).toBe(true);
    expect(elementContainsSelectionPoint(loop, { x: 50, y: 8 }, 4)).toBe(false);
    const dot = {
      ...ink,
      position: [20, 30] as const,
      points: [[0, 0] as const],
    };
    expect(elementContainsSelectionPoint(dot, { x: 20, y: 30 })).toBe(true);
    expect(elementContainsSelectionPoint(dot, { x: 30, y: 30 }, 4)).toBe(false);
    const highlighter = {
      ...ink,
      style: { ...ink.style, highlighter: true, width: 30 },
    };
    expect(elementContainsSelectionPoint(highlighter, { x: 50, y: 12 })).toBe(true);
    expect(elementContainsSelectionPoint(highlighter, { x: 50, y: 22 }, 4)).toBe(false);
    expect(elementContainsSelectionPoint(ink, { x: 50, y: 5 }, 4)).toBe(true);
    expect(elementContainsSelectionPoint(ink, { x: 50, y: 5 }, 1)).toBe(false);
  });

  it.each(["rectangle", "ellipse"] as const)("hits only %s outlines regardless of fill", (kind) => {
    for (const fillColor of [null, "#111111"]) {
      const shape = createShapeRecord(
        ID,
        0,
        kind,
        { x: 10, y: 20 },
        { x: 110, y: 120 },
        {
          ...SHAPE_STYLE,
          fillColor,
          strokeWidth: 12,
        },
      );
      expect(elementContainsSelectionPoint(shape, { x: 60, y: 70 }, 4)).toBe(false);
      expect(elementContainsSelectionPoint(shape, { x: 60, y: 29 }, 0)).toBe(true);
      expect(elementContainsSelectionPoint(shape, { x: 60, y: 17 }, 4)).toBe(true);
      expect(elementContainsSelectionPoint(shape, { x: 60, y: 14 }, 4)).toBe(false);
      if (kind === "ellipse") {
        expect(elementContainsSelectionPoint(shape, { x: 12, y: 22 }, 4)).toBe(false);
      }
    }
  });

  it("hits diagonal line and arrow geometry instead of their bounding boxes", () => {
    const line = createShapeRecord(ID, 0, "line", { x: 0, y: 0 }, { x: 100, y: 100 }, SHAPE_STYLE);
    expect(elementContainsSelectionPoint(line, { x: 50, y: 50 }, 4)).toBe(true);
    expect(elementContainsSelectionPoint(line, { x: 10, y: 80 }, 4)).toBe(false);
    const arrow = createShapeRecord(
      ID,
      0,
      "arrow",
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      {
        ...SHAPE_STYLE,
        strokeWidth: 6,
      },
    );
    expect(elementContainsSelectionPoint(arrow, { x: 78, y: 10 })).toBe(true);
    expect(elementContainsSelectionPoint(arrow, { x: 50, y: 10 })).toBe(false);
    expect(
      lassoSelectElements(
        [arrow],
        [
          { x: 76, y: 8 },
          { x: 80, y: 8 },
          { x: 80, y: 12 },
          { x: 76, y: 12 },
        ],
      ),
    ).toEqual(new Set([arrow.id]));
  });

  it.each(["rectangle", "ellipse"] as const)(
    "lassos nested ink without selecting a surrounding filled %s",
    (kind) => {
      const shape = createShapeRecord(
        "shape",
        1,
        kind,
        { x: 0, y: 0 },
        { x: 200, y: 200 },
        {
          ...SHAPE_STYLE,
          fillColor: "#111111",
        },
      );
      const nestedInk = { ...ink, position: [50, 100] as const };
      const polygon = [
        { x: 40, y: 90 },
        { x: 160, y: 90 },
        { x: 160, y: 110 },
        { x: 40, y: 110 },
      ];
      expect(lassoSelectElements([shape, nestedInk], polygon)).toEqual(new Set([ink.id]));
      expect(
        lassoSelectElements(
          [shape],
          [
            { x: -10, y: -10 },
            { x: 210, y: -10 },
            { x: 210, y: 210 },
            { x: -10, y: 210 },
          ],
        ),
      ).toEqual(new Set([shape.id]));
      expect(
        lassoSelectElements(
          [shape],
          [
            { x: 90, y: -10 },
            { x: 110, y: -10 },
            { x: 110, y: 10 },
            { x: 90, y: 10 },
          ],
        ),
      ).toEqual(new Set([shape.id]));
    },
  );

  it("keeps Markdown interior selection intact", () => {
    expect(elementContainsSelectionPoint(markdown, { x: 50, y: 40 })).toBe(true);
    expect(elementContainsSelectionPoint(markdown, { x: 10, y: 40 }, 4)).toBe(false);
  });

  it("lassos all semantic shapes and erases each shape geometry", () => {
    const shapes: readonly CanvasElement[] = [
      {
        kind: "shape",
        id: "623e4567-e89b-42d3-a456-426614174005",
        position: [0, 0],
        z: 0,
        geometry: { kind: "line", start: [0, 0], end: [40, 0] },
        style: SHAPE_STYLE,
      },
      {
        kind: "shape",
        id: "723e4567-e89b-42d3-a456-426614174006",
        position: [0, 20],
        z: 1,
        geometry: { kind: "arrow", start: [0, 0], end: [40, 0] },
        style: SHAPE_STYLE,
      },
      {
        kind: "shape",
        id: "823e4567-e89b-42d3-a456-426614174007",
        position: [60, 0],
        z: 2,
        geometry: { kind: "rectangle", width: 30, height: 20 },
        style: SHAPE_STYLE,
      },
      {
        kind: "shape",
        id: "923e4567-e89b-42d3-a456-426614174008",
        position: [110, 0],
        z: 3,
        geometry: { kind: "ellipse", width: 30, height: 20 },
        style: SHAPE_STYLE,
      },
    ];
    const lasso = [
      { x: -10, y: -10 },
      { x: 150, y: -10 },
      { x: 150, y: 40 },
      { x: -10, y: 40 },
    ];
    expect(lassoSelectElements(shapes, lasso)).toEqual(new Set(shapes.map((shape) => shape.id)));
    expect(lassoSelectInk(shapes, lasso)).toEqual(new Set(shapes.map((shape) => shape.id)));

    const eraserPaths = [
      [
        { x: 20, y: -10 },
        { x: 20, y: 10 },
      ],
      [
        { x: 20, y: 10 },
        { x: 20, y: 30 },
      ],
      [
        { x: 60, y: 0 },
        { x: 90, y: 0 },
      ],
      [
        { x: 125, y: -5 },
        { x: 125, y: 5 },
      ],
    ] as const;
    shapes.forEach((shape, index) => {
      expect(eraseElements([shape], eraserPaths[index]!, 1, "stroke")).toEqual([]);
    });
  });

  it("lassos Markdown boxes as part of the combined selection interface", () => {
    expect(
      lassoSelectElements(
        [markdown],
        [
          { x: 0, y: 0 },
          { x: 120, y: 0 },
          { x: 120, y: 90 },
          { x: 0, y: 90 },
        ],
      ),
    ).toEqual(new Set([markdown.id]));
  });

  it("keeps grouped text boxes out of mixed lasso selections", () => {
    const groupedMarkdown = { ...markdown, textGroupId: ID };
    const polygon = [
      { x: -20, y: -20 },
      { x: 140, y: -20 },
      { x: 140, y: 100 },
      { x: -20, y: 100 },
    ];

    expect(lassoSelectElements([groupedMarkdown, ink], polygon)).toEqual(new Set([ink.id]));
    expect(lassoSelectElements([groupedMarkdown], polygon)).toEqual(new Set([groupedMarkdown.id]));
  });

  it("inserts space by moving whole crossing and lower objects", () => {
    const above = { ...ink, id: "b23e4567-e89b-42d3-a456-426614174010" };
    const crossing = {
      ...ink,
      id: "c23e4567-e89b-42d3-a456-426614174011",
      position: [0, 18] as const,
    };
    const below = {
      ...ink,
      id: "d23e4567-e89b-42d3-a456-426614174012",
      position: [0, 40] as const,
    };
    const moved = insertVerticalSpace([above, crossing, below], 20, 30);
    expect(moved[0]).toBe(above);
    expect(moved[1]?.position[1]).toBe(48);
    expect(moved[2]?.position[1]).toBe(70);
    const compacted = insertVerticalSpace([above, crossing, below], 20, -10);
    expect(compacted[0]).toBe(above);
    expect(compacted[1]?.position[1]).toBe(8);
    expect(compacted[2]?.position[1]).toBe(30);
  });

  it("recolors and resizes only selected ink", () => {
    const other = { ...ink, id: "523e4567-e89b-42d3-a456-426614174004" };
    const elements: readonly CanvasElement[] = [ink, other];
    const recolored = updateSelectedInkStyle(elements, new Set([ID]), { color: "#ff0000" });
    expect((recolored[0] as InkCanvasRecord).style.color).toBe("#ff0000");
    expect(recolored[1]).toBe(other);
  });

  it("fills only closed shapes in a mixed selection while updating every stroke", () => {
    const shapes = (["line", "arrow", "rectangle", "ellipse"] as const).map((kind, index) =>
      createShapeRecord(
        `${ID.slice(0, -1)}${index}`, index, kind, { x: 0, y: 0 }, { x: 30, y: 20 }, SHAPE_STYLE,
      ),
    );
    const ids = new Set(shapes.map((shape) => shape.id));
    const filled = updateSelectedShapeStyle(shapes, ids, { fillColor: "#60a5fa" });
    expect(filled[0]).toBe(shapes[0]);
    expect(filled[1]).toBe(shapes[1]);
    expect(filled.slice(2)).toMatchObject([
      { style: { fillColor: "#60a5fa" } },
      { style: { fillColor: "#60a5fa" } },
    ]);
    const recolored = updateSelectedShapeStyle(shapes, ids, {
      strokeColor: "#60a5fa", fillColor: "#60a5fa",
    });
    expect(recolored).toMatchObject([
      { style: { strokeColor: "#60a5fa", fillColor: null } },
      { style: { strokeColor: "#60a5fa", fillColor: null } },
      { style: { strokeColor: "#60a5fa", fillColor: "#60a5fa" } },
      { style: { strokeColor: "#60a5fa", fillColor: "#60a5fa" } },
    ]);
  });

  it("updates only selected shape styles", () => {
    const shape = createShapeRecord(
      ID,
      0,
      "rectangle",
      { x: 0, y: 0 },
      { x: 30, y: 20 },
      SHAPE_STYLE,
    );
    const other = { ...shape, id: "523e4567-e89b-42d3-a456-426614174004" };
    const updated = updateSelectedShapeStyle([shape, other], new Set([ID]), {
      strokeColor: "#60a5fa",
      fillColor: "#60a5fa",
    });
    expect(updated[0]).toMatchObject({ style: { strokeColor: "#60a5fa", fillColor: "#60a5fa" } });
    expect(updated[1]).toBe(other);
  });
});
