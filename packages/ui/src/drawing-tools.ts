import {
  canonicalCoordinate,
  elementBounds,
  type CanvasElement,
  type InkCanvasRecord,
  type InkPoint,
  type InkStyle,
  type ProfileDrawingTool,
  type ProfileEraserMode,
  type ShapeCanvasRecord,
  type ShapeGeometry,
  type ShapeStyle,
} from "@squillpad/core-model";

import type { Point } from "./canvas-camera";
import { clampInkWidth, clampShapeWidth } from "./drawing-limits";
import { createInkRecord } from "./ink-engine";

export type ShapeTool = Extract<ProfileDrawingTool, "line" | "arrow" | "rectangle" | "ellipse">;
export type EraserMode = ProfileEraserMode;

/** Decides whether one primary pointer may begin a drawing-tool gesture. */
export function acceptsDrawingPointer(
  pointerType: string,
  button: number,
  isPrimary: boolean,
  penDrawsTouchNavigates: boolean,
): boolean {
  if (!isPrimary || (button !== 0 && !(pointerType === "pen" && button === 5))) return false;
  return pointerType !== "touch" || !penDrawsTouchNavigates;
}

/** Creates semantic shape geometry from a drag in world space. */
export function createShapeRecord(
  id: string,
  z: number,
  kind: ShapeTool,
  start: Point,
  end: Point,
  style: ShapeStyle,
  constrained = false,
): ShapeCanvasRecord {
  const adjusted = constrained ? constrainEnd(kind, start, end) : end;
  const left = Math.min(start.x, adjusted.x);
  const top = Math.min(start.y, adjusted.y);
  const width = Math.max(1, Math.abs(adjusted.x - start.x));
  const height = Math.max(1, Math.abs(adjusted.y - start.y));
  const position = [canonicalCoordinate(left), canonicalCoordinate(top)] as const;
  let geometry: ShapeGeometry;
  if (kind === "rectangle" || kind === "ellipse") {
    geometry = {
      kind,
      width: canonicalCoordinate(width),
      height: canonicalCoordinate(height),
    };
  } else {
    geometry = {
      kind,
      start: [canonicalCoordinate(start.x - left), canonicalCoordinate(start.y - top)],
      end: [canonicalCoordinate(adjusted.x - left), canonicalCoordinate(adjusted.y - top)],
    };
  }
  return {
    id,
    kind: "shape",
    position,
    z,
    geometry,
    style: { ...style, strokeWidth: clampShapeWidth(style.strokeWidth) },
  };
}

/** Updates only selected ink records while preserving all canonical point data. */
export function updateSelectedInkStyle(
  elements: readonly CanvasElement[],
  ids: ReadonlySet<string>,
  patch: Partial<Pick<InkStyle, "color" | "width" | "opacity">>,
): readonly CanvasElement[] {
  return elements.map((element) =>
    element.kind === "ink" && ids.has(element.id)
      ? {
          ...element,
          style: {
            ...element.style,
            ...patch,
            ...(!("width" in patch) || patch.width === undefined
              ? {}
              : { width: clampInkWidth(patch.width, element.style.highlighter) }),
          },
        }
      : element,
  );
}

/** Updates only selected shape records while preserving their semantic geometry. */
export function updateSelectedShapeStyle(
  elements: readonly CanvasElement[],
  ids: ReadonlySet<string>,
  patch: Partial<Pick<ShapeStyle, "strokeColor" | "strokeWidth" | "fillColor" | "opacity">>,
): readonly CanvasElement[] {
  return elements.map((element) =>
    element.kind === "shape" && ids.has(element.id)
      ? {
          ...element,
          style: {
            ...element.style,
            ...patch,
            ...(patch.strokeWidth === undefined
              ? {}
              : { strokeWidth: clampShapeWidth(patch.strokeWidth) }),
          },
        }
      : element,
  );
}

/** Erases intersected drawing elements or emits surviving ink fragments. */
export function eraseElements(
  elements: readonly CanvasElement[],
  path: readonly Point[],
  radius: number,
  mode: EraserMode,
): readonly CanvasElement[] {
  if (path.length === 0) return elements;
  const pathBounds = paddedPointBounds(path, radius);
  const result: CanvasElement[] = [];
  for (const element of elements) {
    if (element.kind === "shape") {
      if (
        !boundsOverlap(elementBounds(element), pathBounds) ||
        !shapeIntersectsPath(element, path, radius)
      ) {
        result.push(element);
      }
      continue;
    }
    if (element.kind !== "ink" || !boundsOverlap(elementBounds(element), pathBounds)) {
      result.push(element);
      continue;
    }
    const absolute = absoluteInkPoints(element);
    if (!strokeIntersectsPath(absolute, path, radius + element.style.width / 2)) {
      result.push(element);
      continue;
    }
    if (mode === "stroke") continue;
    const fragments = survivingFragments(absolute, path, radius + element.style.width / 2);
    fragments.forEach((points, index) => {
      result.push(
        createInkRecord(
          index === 0 ? element.id : deterministicFragmentId(element.id, points),
          result.length,
          points,
          element.style,
        ),
      );
    });
  }
  return result.map((element, z) => (element.z === z ? element : { ...element, z }));
}

/** Keeps the historical API name while applying the general drawing eraser. */
export function eraseInk(
  elements: readonly CanvasElement[],
  path: readonly Point[],
  radius: number,
  mode: EraserMode,
): readonly CanvasElement[] {
  return eraseElements(elements, path, radius, mode);
}

/** Selects ink and semantic shapes whose geometry touches a closed lasso polygon. */
export function lassoSelectElements(
  elements: readonly CanvasElement[],
  polygon: readonly Point[],
): ReadonlySet<string> {
  if (polygon.length < 3) return new Set();
  const bounds = paddedPointBounds(polygon, 0);
  const selected = elements
    .filter((element) => boundsOverlap(elementBounds(element), bounds))
    .filter((element) => elementTouchesPolygon(element, polygon));
  const hasOtherElement = selected.length > 1;
  return new Set(
    selected
      .filter((element) => !hasOtherElement || !isTextBoxGroupBlock(element))
      .map((element) => element.id),
  );
}

/** Inserts or removes vertical space by moving every object crossing or below the cut. */
export function insertVerticalSpace(
  elements: readonly CanvasElement[],
  cutY: number,
  distance: number,
): readonly CanvasElement[] {
  if (!Number.isFinite(distance) || distance === 0) return elements;
  const offset = canonicalCoordinate(distance);
  if (offset === 0) return elements;
  return elements.map((element) => {
    const bounds = elementBounds(element);
    if (bounds.y + bounds.height < cutY) return element;
    return {
      ...element,
      position: [element.position[0], canonicalCoordinate(element.position[1] + offset)],
    };
  });
}

/** Keeps the historical API name while selecting all drawing elements. */
export function lassoSelectInk(
  elements: readonly CanvasElement[],
  polygon: readonly Point[],
): ReadonlySet<string> {
  return lassoSelectElements(elements, polygon);
}

function constrainEnd(kind: ShapeTool, start: Point, end: Point): Point {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (kind === "rectangle" || kind === "ellipse") {
    const size = Math.max(Math.abs(dx), Math.abs(dy));
    return { x: start.x + Math.sign(dx || 1) * size, y: start.y + Math.sign(dy || 1) * size };
  }
  const length = Math.hypot(dx, dy);
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return { x: start.x + Math.cos(angle) * length, y: start.y + Math.sin(angle) * length };
}

function absoluteInkPoints(element: InkCanvasRecord): readonly Point[] {
  return element.points.map((point) => ({
    x: element.position[0] + point[0],
    y: element.position[1] + point[1],
  }));
}

function isTextBoxGroupBlock(element: CanvasElement): boolean {
  return element.kind === "markdown" && element.textGroupId !== undefined;
}

function elementTouchesPolygon(element: CanvasElement, polygon: readonly Point[]): boolean {
  if (element.kind === "ink") return strokeTouchesPolygon(absoluteInkPoints(element), polygon);
  if (element.kind === "markdown" || element.kind === "image") {
    const bounds = elementBounds(element);
    const corners = [
      { x: bounds.x, y: bounds.y },
      { x: bounds.x + bounds.width, y: bounds.y },
      { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
      { x: bounds.x, y: bounds.y + bounds.height },
    ];
    return (
      strokeTouchesPolygon([...corners, corners[0] as Point], polygon) ||
      polygon.some(
        (point) =>
          point.x >= bounds.x &&
          point.x <= bounds.x + bounds.width &&
          point.y >= bounds.y &&
          point.y <= bounds.y + bounds.height,
      )
    );
  }
  const points = shapePath(element);
  const closed = [...points, points[0] as Point];
  return (
    strokeTouchesPolygon(closed, polygon) ||
    (element.style.fillColor !== null &&
      polygon.some((point) => shapeContainsPoint(element, point)))
  );
}

function shapeIntersectsPath(
  element: ShapeCanvasRecord,
  path: readonly Point[],
  radius: number,
): boolean {
  const points = shapePath(element);
  const strokeRadius = radius + element.style.strokeWidth / 2;
  if (element.geometry.kind === "line" || element.geometry.kind === "arrow") {
    return strokeIntersectsPath(points, path, strokeRadius);
  }
  const closed = [...points, points[0] as Point];
  return (
    strokeIntersectsPath(closed, path, strokeRadius) ||
    (element.style.fillColor !== null && path.some((point) => shapeContainsPoint(element, point)))
  );
}

function shapePath(element: ShapeCanvasRecord): readonly Point[] {
  const { geometry, position } = element;
  if (geometry.kind === "line" || geometry.kind === "arrow") {
    return [
      { x: position[0] + geometry.start[0], y: position[1] + geometry.start[1] },
      { x: position[0] + geometry.end[0], y: position[1] + geometry.end[1] },
    ];
  }
  if (geometry.kind === "rectangle") {
    return [
      { x: position[0], y: position[1] },
      { x: position[0] + geometry.width, y: position[1] },
      { x: position[0] + geometry.width, y: position[1] + geometry.height },
      { x: position[0], y: position[1] + geometry.height },
    ];
  }
  const center = {
    x: position[0] + geometry.width / 2,
    y: position[1] + geometry.height / 2,
  };
  return Array.from({ length: 64 }, (_, index) => {
    const angle = (index / 64) * Math.PI * 2;
    return {
      x: center.x + (geometry.width / 2) * Math.cos(angle),
      y: center.y + (geometry.height / 2) * Math.sin(angle),
    };
  });
}

function shapeContainsPoint(element: ShapeCanvasRecord, point: Point): boolean {
  const { geometry, position } = element;
  const x = point.x - position[0];
  const y = point.y - position[1];
  if (geometry.kind === "rectangle") {
    return x >= 0 && x <= geometry.width && y >= 0 && y <= geometry.height;
  }
  if (geometry.kind === "ellipse") {
    const normalizedX = (x - geometry.width / 2) / Math.max(geometry.width / 2, 0.001);
    const normalizedY = (y - geometry.height / 2) / Math.max(geometry.height / 2, 0.001);
    return normalizedX * normalizedX + normalizedY * normalizedY <= 1;
  }
  return false;
}

function survivingFragments(
  points: readonly Point[],
  eraserPath: readonly Point[],
  radius: number,
): readonly (readonly InkPoint[])[] {
  const dense = densify(points, Math.max(1, radius / 2));
  const fragments: InkPoint[][] = [];
  let current: InkPoint[] = [];
  for (const point of dense) {
    if (pointNearPath(point, eraserPath, radius)) {
      if (current.length > 0) fragments.push(current);
      current = [];
    } else {
      current.push([point.x, point.y]);
    }
  }
  if (current.length > 0) fragments.push(current);
  return fragments;
}

function densify(points: readonly Point[], spacing: number): readonly Point[] {
  if (points.length < 2) return points;
  const result: Point[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1] as Point;
    const end = points[index] as Point;
    const steps = Math.max(1, Math.ceil(Math.hypot(end.x - start.x, end.y - start.y) / spacing));
    for (let step = index === 1 ? 0 : 1; step <= steps; step += 1) {
      const ratio = step / steps;
      result.push({
        x: canonicalCoordinate(start.x + (end.x - start.x) * ratio),
        y: canonicalCoordinate(start.y + (end.y - start.y) * ratio),
      });
    }
  }
  return result;
}

function strokeIntersectsPath(
  stroke: readonly Point[],
  path: readonly Point[],
  radius: number,
): boolean {
  if (stroke.length === 1) return pointNearPath(stroke[0] as Point, path, radius);
  for (let left = 1; left < stroke.length; left += 1) {
    for (let right = 1; right < path.length; right += 1) {
      if (
        segmentDistance(
          stroke[left - 1] as Point,
          stroke[left] as Point,
          path[right - 1] as Point,
          path[right] as Point,
        ) <= radius
      ) {
        return true;
      }
    }
  }
  return path.length === 1 && stroke.some((point) => distance(point, path[0] as Point) <= radius);
}

function pointNearPath(point: Point, path: readonly Point[], radius: number): boolean {
  if (path.length === 1) return distance(point, path[0] as Point) <= radius;
  return path
    .slice(1)
    .some((end, index) => pointSegmentDistance(point, path[index] as Point, end) <= radius);
}

function strokeTouchesPolygon(stroke: readonly Point[], polygon: readonly Point[]): boolean {
  if (stroke.some((point) => pointInPolygon(point, polygon))) return true;
  const edges = polygon.map(
    (point, index) => [point, polygon[(index + 1) % polygon.length] as Point] as const,
  );
  return stroke
    .slice(1)
    .some((point, index) =>
      edges.some(([start, end]) => segmentsIntersect(stroke[index] as Point, point, start, end)),
    );
}

function pointInPolygon(point: Point, polygon: readonly Point[]): boolean {
  let inside = false;
  for (
    let index = 0, previous = polygon.length - 1;
    index < polygon.length;
    previous = index, index += 1
  ) {
    const a = polygon[index] as Point;
    const b = polygon[previous] as Point;
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function segmentDistance(a: Point, b: Point, c: Point, d: Point): number {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(
    pointSegmentDistance(a, c, d),
    pointSegmentDistance(b, c, d),
    pointSegmentDistance(c, a, b),
    pointSegmentDistance(d, a, b),
  );
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const cross = (p: Point, q: Point, r: Point) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);
  if (abC === 0 && pointOnSegment(c, a, b)) return true;
  if (abD === 0 && pointOnSegment(d, a, b)) return true;
  if (cdA === 0 && pointOnSegment(a, c, d)) return true;
  if (cdB === 0 && pointOnSegment(b, c, d)) return true;
  return abC > 0 !== abD > 0 && cdA > 0 !== cdB > 0;
}

function pointOnSegment(point: Point, start: Point, end: Point): boolean {
  return (
    point.x >= Math.min(start.x, end.x) &&
    point.x <= Math.max(start.x, end.x) &&
    point.y >= Math.min(start.y, end.y) &&
    point.y <= Math.max(start.y, end.y)
  );
}

function pointSegmentDistance(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const denominator = dx * dx + dy * dy;
  if (denominator === 0) return distance(point, start);
  const ratio = Math.min(
    1,
    Math.max(0, ((point.x - start.x) * dx + (point.y - start.y) * dy) / denominator),
  );
  return distance(point, { x: start.x + dx * ratio, y: start.y + dy * ratio });
}

function distance(left: Point, right: Point): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function paddedPointBounds(points: readonly Point[], padding: number) {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs) - padding;
  const minY = Math.min(...ys) - padding;
  const maxX = Math.max(...xs) + padding;
  const maxY = Math.max(...ys) + padding;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function boundsOverlap(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    left.x <= right.x + right.width &&
    left.x + left.width >= right.x &&
    left.y <= right.y + right.height &&
    left.y + left.height >= right.y
  );
}

function deterministicFragmentId(id: string, points: readonly InkPoint[]): string {
  const input = `${id}:${points.map((point) => `${point[0]},${point[1]}`).join(";")}`;
  const first = stableHash(input, 2166136261);
  const second = stableHash(input, 3339675911);
  const tail = `${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0").slice(0, 4)}`;
  return `${id.slice(0, 24)}${tail}`;
}

function stableHash(value: string, seed: number): number {
  let hash = seed;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
