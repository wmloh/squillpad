import type { InkPoint, InkStyle, ShapeStyle } from "@squillpad/core-model";

import type { Point } from "./canvas-camera";
import { clampShapeWidth } from "./drawing-limits";
import {
  recognizeInkShape,
  type RecognizedInkShape,
} from "./ink-shape-recognition";

export const INK_SHAPE_HOLD_MS = 650;
export const INK_SHAPE_HOLD_JITTER_PX = 4;

export interface InkShapeStroke {
  readonly id: string;
  readonly pointerId: number;
  readonly samples: readonly InkPoint[];
  readonly style: InkStyle;
}

export interface InkShapePreview extends RecognizedInkShape {
  readonly id: string;
  readonly style: ShapeStyle;
}

interface PendingStroke {
  stroke: InkShapeStroke;
  screenAnchor: Point;
  world: Point;
  screenScale: number;
}

interface ShapeAdjustment {
  readonly shape: InkShapePreview;
  readonly holdPoint: Point;
}

/** Owns only transient hold/resize state; a caller commits the result on pointer release. */
export class InkShapeGesture {
  private pending: PendingStroke | undefined;
  private adjustment: ShapeAdjustment | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly onPreview: (shape: InkShapePreview | undefined) => void,
  ) {}

  get recognized(): boolean {
    return this.adjustment !== undefined;
  }

  begin(
    stroke: InkShapeStroke,
    screen: Point,
    world: Point,
    screenScale: number,
  ): void {
    this.cancel();
    this.pending = { stroke, screenAnchor: screen, world, screenScale };
    this.schedule();
  }

  move(
    stroke: InkShapeStroke,
    screen: Point,
    world: Point,
    screenScale: number,
  ): void {
    const pending = this.pending;
    if (pending?.stroke.pointerId !== stroke.pointerId) return;
    if (this.adjustment !== undefined) {
      this.onPreview(this.adjustedShape(world));
      return;
    }
    pending.stroke = stroke;
    pending.world = world;
    pending.screenScale = screenScale;
    if (
      Math.hypot(
        screen.x - pending.screenAnchor.x,
        screen.y - pending.screenAnchor.y,
      ) > INK_SHAPE_HOLD_JITTER_PX
    ) {
      pending.screenAnchor = screen;
      this.schedule();
    }
  }

  finish(pointerId: number, world: Point): InkShapePreview | undefined {
    if (this.pending?.stroke.pointerId !== pointerId) return;
    const shape = this.adjustedShape(world);
    this.cancel(pointerId);
    return shape;
  }

  cancel(pointerId?: number): void {
    if (pointerId !== undefined && this.pending?.stroke.pointerId !== pointerId)
      return;
    this.clearTimer();
    this.pending = undefined;
    const hadPreview = this.adjustment !== undefined;
    this.adjustment = undefined;
    if (hadPreview) this.onPreview(undefined);
  }

  /** Cleanup avoids publishing React state while the owning canvas unmounts. */
  dispose(): void {
    this.clearTimer();
    this.pending = undefined;
    this.adjustment = undefined;
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const pending = this.pending;
      if (pending === undefined) return;
      const recognized = recognizeInkShape(
        pending.stroke.samples,
        pending.screenScale,
      );
      if (recognized === undefined) return;
      const { stroke, world } = pending;
      let start = recognized.start;
      let end = recognized.end;
      if (recognized.kind !== "line") {
        end = {
          x:
            Math.abs(world.x - start.x) <= Math.abs(world.x - end.x)
              ? start.x
              : end.x,
          y:
            Math.abs(world.y - start.y) <= Math.abs(world.y - end.y)
              ? start.y
              : end.y,
        };
        start = {
          x:
            end.x === recognized.start.x
              ? recognized.end.x
              : recognized.start.x,
          y:
            end.y === recognized.start.y
              ? recognized.end.y
              : recognized.start.y,
        };
      }
      const shape: InkShapePreview = {
        kind: recognized.kind,
        id: stroke.id,
        start,
        end,
        style: {
          strokeColor: stroke.style.color,
          strokeWidth: clampShapeWidth(stroke.style.width),
          opacity: stroke.style.opacity,
          fillColor: null,
        },
      };
      this.adjustment = { shape, holdPoint: world };
      this.onPreview(shape);
    }, INK_SHAPE_HOLD_MS);
  }

  private adjustedShape(world: Point): InkShapePreview | undefined {
    if (this.adjustment === undefined) return;
    const { shape, holdPoint } = this.adjustment;
    return {
      ...shape,
      end: {
        x: shape.end.x + world.x - holdPoint.x,
        y: shape.end.y + world.y - holdPoint.y,
      },
    };
  }
}
