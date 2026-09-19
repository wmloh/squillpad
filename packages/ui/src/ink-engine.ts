import {
  canonicalCoordinate,
  type CanvasBounds,
  type InkCanvasRecord,
  type InkPoint,
  type InkStyle,
} from "@squillpad/core-model";

import { clientToWorld, type Camera, type Point } from "./canvas-camera";
import { clampInkWidth } from "./drawing-limits";

export const DEFAULT_INK_STYLE: InkStyle = {
  color: "#38245f",
  width: 4,
  opacity: 1,
  highlighter: false,
  smoothing: 0.65,
};

const ROUND_CAP_SEGMENTS = 8;

/** Minimal browser pointer data needed by the device-independent ink engine. */
export interface InkPointerSample {
  readonly clientX: number;
  readonly clientY: number;
  readonly pointerType: string;
}

/** Maps browser pointer data to a canonical world-space ink point at any visual viewport scale. */
export function pointerSampleToWorld(
  sample: InkPointerSample,
  viewportOrigin: Point,
  camera: Camera,
  viewportScale: Point = { x: 1, y: 1 },
): InkPoint {
  const point = clientToWorld(
    { x: sample.clientX, y: sample.clientY },
    viewportOrigin,
    camera,
    viewportScale,
  );
  return [canonicalCoordinate(point.x), canonicalCoordinate(point.y)];
}

/** Converts absolute samples into one reconstructable canonical canvas record. */
export function createInkRecord(
  id: string,
  z: number,
  samples: readonly InkPoint[],
  style: InkStyle = DEFAULT_INK_STYLE,
): InkCanvasRecord {
  if (samples.length === 0) throw new Error("An ink stroke requires at least one sample");
  const origin = samples[0] as InkPoint;
  return {
    kind: "ink",
    id,
    position: [canonicalCoordinate(origin[0]), canonicalCoordinate(origin[1])],
    z,
    points: samples.map((sample) => [
      canonicalCoordinate(sample[0] - origin[0]),
      canonicalCoordinate(sample[1] - origin[1]),
    ]),
    style: { ...style, width: clampInkWidth(style.width, style.highlighter) },
  };
}

/** Decimates render samples while retaining geometric landmarks. */
export function decimateInkPoints(
  points: readonly InkPoint[],
  tolerance: number,
): readonly InkPoint[] {
  if (points.length <= 2 || tolerance <= 0) return points;
  const retained = new Set<number>([0, points.length - 1]);

  const simplify = (startIndex: number, endIndex: number): void => {
    const start = points[startIndex] as InkPoint;
    const end = points[endIndex] as InkPoint;
    let splitIndex = -1;
    let priority = 1;
    for (let index = startIndex + 1; index < endIndex; index += 1) {
      const point = points[index] as InkPoint;
      const nextPriority =
        pointSegmentDistance(asPoint(point), asPoint(start), asPoint(end)) /
        Math.max(0.0001, tolerance);
      if (nextPriority > priority) {
        priority = nextPriority;
        splitIndex = index;
      }
    }
    if (splitIndex < 0) return;
    retained.add(splitIndex);
    simplify(startIndex, splitIndex);
    simplify(splitIndex, endIndex);
  };

  simplify(0, points.length - 1);
  return points.filter((_point, index) => retained.has(index));
}

/** Produces a deterministic fixed-width outline around a sampled centerline. */
export function strokeOutline(
  points: readonly InkPoint[],
  width: number,
  smoothing = 0.65,
  decimationTolerance = 0,
  highlighter = false,
): readonly Point[] {
  const renderPoints = decimateInkPoints(points, decimationTolerance);
  if (renderPoints.length === 0) return [];
  if (renderPoints.length === 1) {
    const point = renderPoints[0] as InkPoint;
    return highlighter ? highlighterPointOutline(point, width) : circularOutline(point, width / 2);
  }

  const smoothed = highlighter
    ? smoothHighlighterPoints(renderPoints, smoothing)
    : smoothPoints(renderPoints, smoothing);
  const left: Point[] = [];
  const right: Point[] = [];
  smoothed.forEach((point, index) => {
    const tangent = pointTangent(smoothed, index);
    const length = Math.hypot(tangent.x, tangent.y) || 1;
    const normal = { x: -tangent.y / length, y: tangent.x / length };
    const radius = width / 2;
    left.push({ x: point[0] + normal.x * radius, y: point[1] + normal.y * radius });
    right.push({ x: point[0] - normal.x * radius, y: point[1] - normal.y * radius });
  });
  if (highlighter) return [...left, ...right.reverse()];
  return roundCappedOutline(smoothed, left, right, width / 2);
}

const renderedInkPathCache = new WeakMap<InkCanvasRecord, { key: string; path: string }>();

/** Builds and caches a render-only SVG path without changing canonical samples. */
export function renderInkPath(
  element: InkCanvasRecord,
  bounds: CanvasBounds,
  decimationTolerance = 0,
): string {
  const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}|${decimationTolerance}`;
  const cached = renderedInkPathCache.get(element);
  if (cached?.key === key) return cached.path;

  const localPoints = element.points.map(
    (point) =>
      [
        element.position[0] + point[0] - bounds.x,
        element.position[1] + point[1] - bounds.y,
      ] as const,
  );
  const path = outlineToSvgPath(
    strokeOutline(
      localPoints,
      element.style.width,
      element.style.smoothing ?? 0.65,
      decimationTolerance,
      element.style.highlighter,
    ),
  );
  renderedInkPathCache.set(element, { key, path });
  return path;
}

/** Creates a smooth closed SVG path suitable for anti-aliased vector fill rendering. */
export function outlineToSvgPath(outline: readonly Point[]): string {
  if (outline.length === 0) return "";
  const first = outline[0] as Point;
  if (outline.length === 1) return `M ${format(first.x)} ${format(first.y)} Z`;
  const second = outline[1] as Point;
  const start = midpoint(first, second);
  let path = `M ${format(start.x)} ${format(start.y)}`;
  for (let index = 1; index <= outline.length; index += 1) {
    const point = outline[index % outline.length] as Point;
    const next = outline[(index + 1) % outline.length] as Point;
    const end = midpoint(point, next);
    path += ` Q ${format(point.x)} ${format(point.y)} ${format(end.x)} ${format(end.y)}`;
  }
  return `${path} Z`;
}

function smoothPoints(points: readonly InkPoint[], smoothing: number): readonly InkPoint[] {
  const amount = Math.min(1, Math.max(0, smoothing));
  return points.map((point, index) => {
    if (index === 0 || index === points.length - 1) return point;
    const previous = points[index - 1] as InkPoint;
    const next = points[index + 1] as InkPoint;
    const averageX = (previous[0] + point[0] + next[0]) / 3;
    const averageY = (previous[1] + point[1] + next[1]) / 3;
    return [
      point[0] * (1 - amount) + averageX * amount,
      point[1] * (1 - amount) + averageY * amount,
    ];
  });
}

function smoothHighlighterPoints(
  points: readonly InkPoint[],
  smoothing: number,
): readonly InkPoint[] {
  const amount = Math.min(0.9, Math.max(0.35, smoothing));
  const passes = amount >= 0.7 ? 3 : 2;
  let smoothed = points;
  for (let pass = 0; pass < passes; pass += 1) {
    smoothed = smoothPoints(smoothed, amount);
  }
  return smoothed;
}

function pointTangent(points: readonly InkPoint[], index: number): Point {
  const current = points[index] as InkPoint;
  let previous = current;
  let next = current;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const candidate = points[cursor] as InkPoint;
    if (candidate[0] !== current[0] || candidate[1] !== current[1]) {
      previous = candidate;
      break;
    }
  }
  for (let cursor = index + 1; cursor < points.length; cursor += 1) {
    const candidate = points[cursor] as InkPoint;
    if (candidate[0] !== current[0] || candidate[1] !== current[1]) {
      next = candidate;
      break;
    }
  }
  return { x: next[0] - previous[0], y: next[1] - previous[1] };
}

function circularOutline(point: InkPoint, radius: number): readonly Point[] {
  return Array.from({ length: 12 }, (_, index) => {
    const angle = (index / 12) * Math.PI * 2;
    return { x: point[0] + Math.cos(angle) * radius, y: point[1] + Math.sin(angle) * radius };
  });
}

function highlighterPointOutline(point: InkPoint, height: number): readonly Point[] {
  const halfHeight = Math.max(0.5, height / 2);
  const halfWidth = 0.5;
  return [
    { x: point[0] - halfWidth, y: point[1] - halfHeight },
    { x: point[0] + halfWidth, y: point[1] - halfHeight },
    { x: point[0] + halfWidth, y: point[1] + halfHeight },
    { x: point[0] - halfWidth, y: point[1] + halfHeight },
  ];
}

function roundCappedOutline(
  centerline: readonly InkPoint[],
  left: readonly Point[],
  right: readonly Point[],
  radius: number,
): readonly Point[] {
  const start = centerline[0] as InkPoint;
  const end = centerline[centerline.length - 1] as InkPoint;
  const startDirection = unitTangent(centerline, 0);
  const endDirection = unitTangent(centerline, centerline.length - 1);
  const startNormal = { x: -startDirection.y, y: startDirection.x };
  const endNormal = { x: -endDirection.y, y: endDirection.x };
  const outline = [...left];

  for (let index = 1; index <= ROUND_CAP_SEGMENTS; index += 1) {
    const angle = (index / ROUND_CAP_SEGMENTS) * Math.PI;
    outline.push({
      x: end[0] + (endNormal.x * Math.cos(angle) + endDirection.x * Math.sin(angle)) * radius,
      y: end[1] + (endNormal.y * Math.cos(angle) + endDirection.y * Math.sin(angle)) * radius,
    });
  }

  outline.push(...[...right].reverse().slice(1));
  for (let index = 1; index < ROUND_CAP_SEGMENTS; index += 1) {
    const angle = (index / ROUND_CAP_SEGMENTS) * Math.PI;
    outline.push({
      x:
        start[0] +
        (-startNormal.x * Math.cos(angle) - startDirection.x * Math.sin(angle)) * radius,
      y:
        start[1] +
        (-startNormal.y * Math.cos(angle) - startDirection.y * Math.sin(angle)) * radius,
    });
  }
  return outline;
}

function unitTangent(points: readonly InkPoint[], index: number): Point {
  const tangent = pointTangent(points, index);
  const length = Math.hypot(tangent.x, tangent.y) || 1;
  return { x: tangent.x / length, y: tangent.y / length };
}

function projectionRatio(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const denominator = dx * dx + dy * dy;
  if (denominator === 0) return 0;
  return Math.min(
    1,
    Math.max(0, ((point.x - start.x) * dx + (point.y - start.y) * dy) / denominator),
  );
}

function pointSegmentDistance(point: Point, start: Point, end: Point): number {
  const ratio = projectionRatio(point, start, end);
  return Math.hypot(
    point.x - (start.x + (end.x - start.x) * ratio),
    point.y - (start.y + (end.y - start.y) * ratio),
  );
}

function midpoint(left: Point, right: Point): Point {
  return { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
}

function format(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

function asPoint(point: InkPoint): Point {
  return { x: point[0], y: point[1] };
}
