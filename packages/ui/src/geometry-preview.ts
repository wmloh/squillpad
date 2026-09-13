import {
  moveElements,
  moveTextBoxGroupBlock,
  resizeElement,
  type CanvasBounds,
  type CanvasElement,
} from "@squillpad/core-model";

import type { Point } from "./canvas-camera";
import { insertVerticalSpace } from "./drawing-tools";

export type GeometryPreview =
  | {
      readonly kind: "move";
      readonly elementIds: readonly string[];
      readonly delta: Point;
    }
  | {
      readonly kind: "resize";
      readonly elementId: string;
      readonly bounds: CanvasBounds;
    }
  | {
      readonly kind: "text-group-move";
      readonly elementId: string;
      readonly deltaY: number;
    }
  | {
      readonly kind: "vertical-space";
      readonly cutY: number;
      readonly distance: number;
    };

/** Applies transient geometry previews without changing canonical page state. */
export function applyGeometryPreviews(
  elements: readonly CanvasElement[],
  previews: readonly GeometryPreview[],
): readonly CanvasElement[] {
  return previews.reduce<readonly CanvasElement[]>((current, preview) => {
    if (preview.kind === "move") {
      return moveElements(current, new Set(preview.elementIds), preview.delta);
    }
    if (preview.kind === "resize") {
      return resizeElement(current, preview.elementId, preview.bounds);
    }
    if (preview.kind === "text-group-move") {
      return moveTextBoxGroupBlock(current, preview.elementId, preview.deltaY);
    }
    return insertVerticalSpace(current, preview.cutY, preview.distance);
  }, elements);
}

/** Parses an untrusted awareness value into a bounded geometry preview. */
export function parseGeometryPreview(value: unknown): GeometryPreview | undefined {
  if (!isRecord(value) || typeof value.kind !== "string") return undefined;
  if (value.kind === "move") {
    if (
      !Array.isArray(value.elementIds) ||
      value.elementIds.length > 1_000 ||
      !value.elementIds.every((id) => typeof id === "string") ||
      !isPoint(value.delta)
    ) {
      return undefined;
    }
    return { kind: "move", elementIds: value.elementIds, delta: value.delta };
  }
  if (value.kind === "resize") {
    if (typeof value.elementId !== "string" || !isBounds(value.bounds)) return undefined;
    return { kind: "resize", elementId: value.elementId, bounds: value.bounds };
  }
  if (value.kind === "text-group-move") {
    if (typeof value.elementId !== "string" || !isFiniteNumber(value.deltaY)) return undefined;
    return { kind: "text-group-move", elementId: value.elementId, deltaY: value.deltaY };
  }
  if (value.kind === "vertical-space") {
    if (!isFiniteNumber(value.cutY) || !isFiniteNumber(value.distance)) return undefined;
    return { kind: "vertical-space", cutY: value.cutY, distance: value.distance };
  }
  return undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPoint(value: unknown): value is Point {
  return isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y);
}

function isBounds(value: unknown): value is CanvasBounds {
  return (
    isRecord(value) &&
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y) &&
    isFiniteNumber(value.width) &&
    isFiniteNumber(value.height) &&
    value.width >= 0 &&
    value.height >= 0
  );
}
