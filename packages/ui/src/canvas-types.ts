import type { Point } from "./canvas-camera";

export interface LaserPointer {
  readonly active: boolean;
  readonly color: string;
  readonly id: string;
  readonly points: readonly Point[];
}
