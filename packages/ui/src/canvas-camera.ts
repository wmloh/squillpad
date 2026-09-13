export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Bounds extends Point {
  readonly width: number;
  readonly height: number;
}

/** Camera translation is measured in viewport CSS pixels; zoom is CSS pixels per world unit. */
export interface Camera {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;
export const DEFAULT_CAMERA: Camera = { x: 0, y: 0, zoom: 1 };

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function worldToViewport(point: Point, camera: Camera): Point {
  return {
    x: point.x * camera.zoom + camera.x,
    y: point.y * camera.zoom + camera.y,
  };
}

/** Converts client coordinates using a CSS-pixel viewport rectangle and optional visual scale. */
export function clientToWorld(
  point: Point,
  viewport: Point,
  camera: Camera,
  viewportScale: Point = { x: 1, y: 1 },
): Point {
  return viewportToWorld(
    {
      x: (point.x - viewport.x) * viewportScale.x,
      y: (point.y - viewport.y) * viewportScale.y,
    },
    camera,
  );
}

export function viewportToWorld(point: Point, camera: Camera): Point {
  return {
    x: (point.x - camera.x) / camera.zoom,
    y: (point.y - camera.y) / camera.zoom,
  };
}

/** Returns the world-space rectangle currently visible in a CSS-pixel viewport. */
export function viewportWorldBounds(
  camera: Camera,
  viewport: Readonly<{ width: number; height: number }>,
  margin = 0,
): Bounds {
  const worldWidth = Math.max(0, viewport.width) / camera.zoom;
  const worldHeight = Math.max(0, viewport.height) / camera.zoom;
  return {
    x: -camera.x / camera.zoom - margin,
    y: -camera.y / camera.zoom - margin,
    width: worldWidth + margin * 2,
    height: worldHeight + margin * 2,
  };
}

export function zoomCameraAt(camera: Camera, viewportPoint: Point, zoom: number): Camera {
  const nextZoom = clampZoom(zoom);
  const anchor = viewportToWorld(viewportPoint, camera);
  return {
    x: viewportPoint.x - anchor.x * nextZoom,
    y: viewportPoint.y - anchor.y * nextZoom,
    zoom: nextZoom,
  };
}

export function panCamera(camera: Camera, delta: Point): Camera {
  return { ...camera, x: camera.x + delta.x, y: camera.y + delta.y };
}

export function fitCamera(
  bounds: Bounds | undefined,
  viewport: Readonly<{ width: number; height: number }>,
  padding = 64,
): Camera {
  const usableWidth = Math.max(1, viewport.width - padding * 2);
  const usableHeight = Math.max(1, viewport.height - padding * 2);
  if (bounds === undefined || bounds.width <= 0 || bounds.height <= 0) {
    return { x: viewport.width / 2, y: viewport.height / 2, zoom: 1 };
  }

  const zoom = clampZoom(Math.min(usableWidth / bounds.width, usableHeight / bounds.height));
  return {
    x: viewport.width / 2 - (bounds.x + bounds.width / 2) * zoom,
    y: viewport.height / 2 - (bounds.y + bounds.height / 2) * zoom,
    zoom,
  };
}
