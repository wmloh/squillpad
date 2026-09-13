export * from "./canonical-format.js";
export * from "./canvas-elements.js";
export * from "./canvas-spatial-index.js";
export * from "./hierarchy.js";
export * from "./markdown-interoperability.js";
export * from "./profile-preferences.js";
export * from "./profile-settings.js";
export * from "./project-preferences.js";

/** A position in the shared page world coordinate system. */
export interface WorldPoint {
  readonly x: number;
  readonly y: number;
}

/** The minimal identity and stacking contract shared by every page object. */
export interface CanvasObjectIdentity {
  readonly id: string;
  readonly position: WorldPoint;
  readonly z: number;
}

export const CORE_MODEL_VERSION = 2;
