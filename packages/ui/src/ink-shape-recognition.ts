import type { InkPoint } from "@squillpad/core-model";

import type { Point } from "./canvas-camera";

export interface RecognizedInkShape {
  readonly kind: "line" | "rectangle" | "ellipse";
  readonly start: Point;
  readonly end: Point;
}

const RESAMPLE_COUNT = 96;

/** Fits one complete stroke conservatively, without changing its original samples. */
export function recognizeInkShape(
  samples: readonly InkPoint[],
  screenScale = 1,
): RecognizedInkShape | undefined {
  if (samples.length < 2 || !Number.isFinite(screenScale) || screenScale <= 0)
    return;
  const points: Point[] = [];
  for (const [x, y] of samples) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const previous = points[points.length - 1];
    if (previous?.x !== x || previous.y !== y) points.push({ x, y });
  }
  if (points.length < 2) return;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  let length = 0;
  points.forEach((point, index) => {
    left = Math.min(left, point.x);
    top = Math.min(top, point.y);
    right = Math.max(right, point.x);
    bottom = Math.max(bottom, point.y);
    if (index > 0) length += distance(points[index - 1]!, point);
  });
  if (length * screenScale < 24) return;
  const sampled = resample(points, length);
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const width = right - left;
  const height = bottom - top;
  const diagonal = Math.hypot(width, height);
  if (distance(first, last) > diagonal * 0.3) {
    return fitLine(sampled, length, screenScale);
  }
  if (width * screenScale < 12 || height * screenScale < 12) return;
  if (distance(first, last) > Math.min(width, height) * 0.18 + 3 / screenScale)
    return;
  const normalized = sampled.map((point) => ({
    x: (2 * (point.x - left)) / width - 1,
    y: (2 * (point.y - top)) / height - 1,
  }));
  if (!coversSingleLoop(normalized)) return;

  const rectangleErrors = normalized.map((point) =>
    Math.min(Math.abs(Math.abs(point.x) - 1), Math.abs(Math.abs(point.y) - 1)),
  );
  const ellipseErrors = normalized.map((point) =>
    Math.abs(Math.hypot(point.x, point.y) - 1),
  );
  const rectangleScore = rms(rectangleErrors);
  const ellipseScore = rms(ellipseErrors);
  const cornersCovered = [-1, 1].every((x) =>
    [-1, 1].every((y) =>
      normalized.some((point) => distance(point, { x, y }) < 0.38),
    ),
  );
  const rectangle =
    cornersCovered &&
    rectangleScore <= 0.12 &&
    Math.max(...rectangleErrors) <= 0.3;
  const ellipse = ellipseScore <= 0.1 && Math.max(...ellipseErrors) <= 0.28;
  if (!rectangle && !ellipse) return;
  if (rectangle && ellipse && Math.abs(rectangleScore - ellipseScore) < 0.025)
    return;
  return {
    kind:
      rectangle && (!ellipse || rectangleScore < ellipseScore)
        ? "rectangle"
        : "ellipse",
    start: { x: left, y: top },
    end: { x: right, y: bottom },
  };
}

function fitLine(
  points: readonly Point[],
  length: number,
  scale: number,
): RecognizedInkShape | undefined {
  const center = points.reduce(
    (sum, point) => ({
      x: sum.x + point.x / points.length,
      y: sum.y + point.y / points.length,
    }),
    { x: 0, y: 0 },
  );
  let xx = 0;
  let yy = 0;
  let xy = 0;
  for (const point of points) {
    const x = point.x - center.x;
    const y = point.y - center.y;
    xx += x * x;
    yy += y * y;
    xy += x * y;
  }
  const angle = Math.atan2(2 * xy, xx - yy) / 2;
  const axis = { x: Math.cos(angle), y: Math.sin(angle) };
  const projections = points.map(
    (point) => (point.x - center.x) * axis.x + (point.y - center.y) * axis.y,
  );
  const extent = Math.max(...projections) - Math.min(...projections);
  if (extent * scale < 24 || length > extent * 1.25) return;
  const errors = points.map((point) =>
    Math.abs((point.x - center.x) * axis.y - (point.y - center.y) * axis.x),
  );
  if (rms(errors) > extent * 0.035 || Math.max(...errors) > extent * 0.075)
    return;
  const startProjection = projections[0]!;
  const endProjection = projections[projections.length - 1]!;
  if (Math.abs(endProjection - startProjection) < extent * 0.85) return;
  const direction = Math.sign(endProjection - startProjection);
  let backtracking = 0;
  for (let index = 1; index < projections.length; index++) {
    backtracking += Math.max(
      0,
      direction * (projections[index - 1]! - projections[index]!),
    );
  }
  if (backtracking > extent * 0.12) return;
  return {
    kind: "line",
    start: {
      x: center.x + axis.x * startProjection,
      y: center.y + axis.y * startProjection,
    },
    end: {
      x: center.x + axis.x * endProjection,
      y: center.y + axis.y * endProjection,
    },
  };
}

/** Equal arc-length sampling prevents drawing speed and stationary jitter from biasing a fit. */
function resample(points: readonly Point[], length: number): Point[] {
  const result: Point[] = [points[0]!];
  let index = 1;
  let traversed = 0;
  for (let sample = 1; sample < RESAMPLE_COUNT - 1; sample++) {
    const target = (length * sample) / (RESAMPLE_COUNT - 1);
    while (
      index < points.length - 1 &&
      traversed + distance(points[index - 1]!, points[index]!) < target
    ) {
      traversed += distance(points[index - 1]!, points[index]!);
      index++;
    }
    const start = points[index - 1]!;
    const end = points[index]!;
    const fraction = Math.min(1, (target - traversed) / distance(start, end));
    result.push({
      x: start.x + (end.x - start.x) * fraction,
      y: start.y + (end.y - start.y) * fraction,
    });
  }
  result.push(points[points.length - 1]!);
  return result;
}

function coversSingleLoop(points: readonly Point[]): boolean {
  const sectors = new Set<number>();
  let winding = 0;
  let travel = 0;
  let perimeter = 0;
  for (let index = 0; index < points.length; index++) {
    const point = points[index]!;
    const angle = Math.atan2(point.y, point.x);
    sectors.add(Math.floor(((angle + Math.PI) / (2 * Math.PI)) * 16) % 16);
    if (index === 0) continue;
    const previous = points[index - 1]!;
    const delta = angle - Math.atan2(previous.y, previous.x);
    const turn = Math.atan2(Math.sin(delta), Math.cos(delta));
    winding += turn;
    travel += Math.abs(turn);
    perimeter += distance(previous, point);
  }
  return (
    sectors.size >= 15 &&
    Math.abs(winding) >= 5.2 &&
    Math.abs(winding) <= 7.1 &&
    travel <= 8 &&
    perimeter <= 10
  );
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function rms(errors: readonly number[]): number {
  return Math.sqrt(
    errors.reduce((sum, error) => sum + error * error, 0) / errors.length,
  );
}
