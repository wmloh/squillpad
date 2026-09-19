import { describe, expect, it } from "vitest";

import {
  createInkRecord,
  decimateInkPoints,
  outlineToSvgPath,
  pointerSampleToWorld,
  renderInkPath,
  strokeOutline,
} from "./ink-engine";

describe("ink engine", () => {
  it("records device-independent canonical world coordinates at any zoom", () => {
    expect(
      pointerSampleToWorld(
        { clientX: 230, clientY: 145, pointerType: "pen" },
        { x: 10, y: 5 },
        { x: 20, y: -10, zoom: 2 },
      ),
    ).toEqual([100, 75]);
  });

  it("stores every sample relative to a canonical stroke origin", () => {
    const record = createInkRecord("423e4567-e89b-42d3-a456-426614174003", 4, [
      [10.1234, -2.3456],
      [14.1234, 3.1544],
    ]);
    expect(record.position).toEqual([10.123, -2.346]);
    expect(record.points).toEqual([
      [0, 0],
      [4, 5.5],
    ]);
  });

  it("creates deterministic smooth fixed-width vector geometry", () => {
    const points = [
      [0, 0],
      [10, 0],
      [20, 5],
    ] as const;
    const outline = strokeOutline(points, 8);
    const path = outlineToSvgPath(outline);
    expect(outline).toHaveLength(20);
    const smoothedCenter = { x: 10, y: (5 / 3) * 0.65 };
    expect(
      Math.hypot((outline[1]?.x ?? 0) - smoothedCenter.x, (outline[1]?.y ?? 0) - smoothedCenter.y),
    ).toBeCloseTo(4);
    expect(path).toBe(outlineToSvgPath(strokeOutline(points, 8)));
    expect(path).toMatch(/^M .+ Q .+ Z$/);
  });

  it("smooths highlighter geometry across noisy pointer samples", () => {
    const points = Array.from(
      { length: 9 },
      (_point, index) => [index % 2 === 0 ? -3 : 3, index * 10] as const,
    );
    const outline = strokeOutline(points, 4, 0.65, 0, true);
    const left = outline.slice(0, points.length);
    const right = outline.slice(points.length).reverse();

    expect(left.every((point, index) => point.y <= (left[index + 1]?.y ?? Infinity))).toBe(true);
    expect(
      Math.max(...left.map((point, index) => Math.abs(point.x - (right[index]?.x ?? point.x)))),
    ).toBeLessThan(4.1);
  });

  it("renders a single accepted sample as a vector dot", () => {
    const outline = strokeOutline([[3, 4]], 4);
    const first = outline[0]!;
    const second = outline[1]!;
    const seamX = (first.x + second.x) / 2;
    const seamY = (first.y + second.y) / 2;
    const path = outlineToSvgPath(outline);
    const coordinates = path.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];

    expect(outline).toHaveLength(12);
    expect(coordinates[0]).toBeCloseTo(seamX, 3);
    expect(coordinates[1]).toBeCloseTo(seamY, 3);
    expect(coordinates.at(-2)).toBe(coordinates[0]);
    expect(coordinates.at(-1)).toBe(coordinates[1]);
    expect(path.match(/ Q /g)).toHaveLength(outline.length);
  });

  it("gives a near-stationary stroke complete round caps", () => {
    const outline = strokeOutline(
      [
        [0, 0],
        [0.001, 0],
      ],
      4,
    );
    const path = outlineToSvgPath(outline);
    const xValues = outline.map((point) => point.x);
    const yValues = outline.map((point) => point.y);

    expect(Math.min(...xValues)).toBeCloseTo(-2);
    expect(Math.max(...xValues)).toBeCloseTo(2.001);
    expect(Math.min(...yValues)).toBeCloseTo(-2);
    expect(Math.max(...yValues)).toBeCloseTo(2);
    expect(path).toContain(" Z");
  });

  it("renders a single highlighter sample as a thin vertical mark", () => {
    const outline = strokeOutline([[3, 4]], 10, 0.65, 0, true);
    const xValues = outline.map((point) => point.x);
    const yValues = outline.map((point) => point.y);

    expect(outline).toHaveLength(4);
    expect(Math.max(...xValues) - Math.min(...xValues)).toBe(1);
    expect(Math.max(...yValues) - Math.min(...yValues)).toBe(10);
  });

  it("decimates visually redundant samples while preserving geometry landmarks", () => {
    const points = Array.from(
      { length: 101 },
      (_point, index) => [index, index === 50 ? 2 : 0] as const,
    );
    const decimated = decimateInkPoints(points, 0.5);
    expect(decimated[0]).toEqual(points[0]);
    expect(decimated.at(-1)).toEqual(points.at(-1));
    expect(decimated.some((point) => point[0] === 50 && point[1] === 2)).toBe(true);
    expect(decimated.length).toBeLessThan(points.length);
  });

  it("keeps render-only paths out of canonical ink records", () => {
    const record = createInkRecord("423e4567-e89b-42d3-a456-426614174003", 0, [
      [0, 0],
      [10, 0],
    ]);
    const path = renderInkPath(record, { x: -2, y: -2, width: 14, height: 4 }, 0.5);
    expect(path).toContain("M");
    expect(record.points).toHaveLength(2);
    expect(record).not.toHaveProperty("path");
  });
});
