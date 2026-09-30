import { describe, expect, it } from "vitest";
import type { InkPoint } from "@squillpad/core-model";

import { recognizeInkShape } from "./ink-shape-recognition";

function rectangle(): InkPoint[] {
  return [
    [0, 0],
    [41, -2],
    [100, 2],
    [103, 40],
    [100, 80],
    [54, 83],
    [-2, 80],
    [1, 37],
    [2, 2],
  ];
}

function ellipse(start = 0, direction = 1): InkPoint[] {
  return Array.from({ length: 65 }, (_, index) => {
    const angle = start + (direction * index * Math.PI) / 32;
    const jitter =
      index === 0 || index === 64 ? 0 : Math.sin(index * 1.7) * 1.5;
    return [
      80 + (80 + jitter) * Math.cos(angle),
      40 + (40 + jitter) * Math.sin(angle),
    ];
  });
}

describe("single-stroke shape recognition", () => {
  it.each([false, true])(
    "recognizes a rough rectangle in either direction (reversed: %s)",
    (reverse) => {
      const points = rectangle();
      expect(recognizeInkShape(reverse ? points.reverse() : points)?.kind).toBe(
        "rectangle",
      );
    },
  );

  it("recognizes a rectangle starting midway along an edge with a small closure gap", () => {
    expect(
      recognizeInkShape([
        [50, 0],
        [100, 0],
        [100, 80],
        [0, 80],
        [0, 0],
        [47, 2],
      ])?.kind,
    ).toBe("rectangle");
  });

  it.each([
    [0, 1],
    [1.3, -1],
    [Math.PI / 2, 1],
  ])(
    "recognizes a rough ellipse from angle %s in direction %s",
    (start, direction) => {
      expect(recognizeInkShape(ellipse(start, direction))?.kind).toBe(
        "ellipse",
      );
    },
  );

  it("recognizes circles as ellipses", () => {
    expect(recognizeInkShape(ellipse().map(([x, y]) => [x, y * 2]))?.kind).toBe(
      "ellipse",
    );
  });

  it.each([0, Math.PI / 2, 0.7, 2.4])(
    "fits rough lines at angle %s",
    (angle) => {
      const points: InkPoint[] = Array.from({ length: 20 }, (_, index) => {
        const along = index * 6;
        const jitter = Math.sin(index * 2) * 1.1;
        return [
          along * Math.cos(angle) - jitter * Math.sin(angle),
          along * Math.sin(angle) + jitter * Math.cos(angle),
        ];
      });
      expect(recognizeInkShape(points)?.kind).toBe("line");
      expect(recognizeInkShape([...points].reverse())?.kind).toBe("line");
    },
  );

  it.each([0.25, 1, 4])(
    "uses screen-size thresholds consistently at zoom %s",
    (zoom) => {
      const points = rectangle().map(
        ([x, y]): InkPoint => [x / zoom + 300, y / zoom - 200],
      );
      expect(recognizeInkShape(points, zoom)?.kind).toBe("rectangle");
      expect(
        recognizeInkShape(
          [
            [0, 0],
            [10 / zoom, 0],
          ],
          zoom,
        ),
      ).toBeUndefined();
    },
  );

  it("ignores duplicate samples and uneven sampling without mutating ink", () => {
    const points = rectangle();
    const original = structuredClone(points);
    const uneven = points.flatMap((point, index) =>
      Array.from({ length: index === 2 ? 100 : 1 }, () => point),
    );
    expect(recognizeInkShape(uneven)?.kind).toBe("rectangle");
    expect(points).toEqual(original);
  });

  it.each([
    {
      name: "dot",
      points: [
        [1, 1],
        [1, 1],
      ],
    },
    {
      name: "tiny loop",
      points: [
        [0, 0],
        [3, 0],
        [3, 3],
        [0, 3],
        [0, 0],
      ],
    },
    {
      name: "open rectangle",
      points: [
        [0, 0],
        [100, 0],
        [100, 80],
        [0, 80],
      ],
    },
    {
      name: "triangle",
      points: [
        [0, 0],
        [100, 80],
        [0, 80],
        [0, 0],
      ],
    },
    {
      name: "scribble",
      points: [
        [0, 0],
        [100, 80],
        [0, 80],
        [100, 0],
        [0, 0],
      ],
    },
    {
      name: "backtracking",
      points: [
        [0, 0],
        [100, 0],
        [20, 0],
        [90, 0],
      ],
    },
    {
      name: "arrow",
      points: [
        [0, 0],
        [100, 0],
        [75, -20],
        [100, 0],
        [75, 20],
      ],
    },
    {
      name: "invalid coordinate",
      points: [
        [0, 0],
        [Infinity, 20],
      ],
    },
  ])("leaves $name as ink", ({ points }) => {
    expect(
      recognizeInkShape(points.map(([x, y]): InkPoint => [x!, y!])),
    ).toBeUndefined();
  });

  it("rejects multiple laps around an ellipse", () => {
    const points = ellipse();
    expect(recognizeInkShape([...points, ...points.slice(1)])).toBeUndefined();
  });
});
