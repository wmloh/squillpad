import { describe, expect, it } from "vitest";

import {
  MAX_ZOOM,
  MIN_ZOOM,
  clientToWorld,
  fitCamera,
  viewportToWorld,
  worldToViewport,
  zoomCameraAt,
} from "./canvas-camera";

describe("canvas camera", () => {
  it("round-trips translated and zoomed coordinates", () => {
    const camera = { x: 120, y: -45, zoom: 2.5 };
    const world = { x: -80, y: 32 };
    expect(viewportToWorld(worldToViewport(world, camera), camera)).toEqual(world);
  });

  it("converts client coordinates relative to the canvas rectangle", () => {
    expect(clientToWorld({ x: 350, y: 260 }, { x: 50, y: 60 }, { x: 100, y: 50, zoom: 2 })).toEqual(
      { x: 100, y: 75 },
    );
  });

  it("accounts for a visual viewport scale when converting client coordinates", () => {
    expect(
      clientToWorld({ x: 250, y: 160 }, { x: 50, y: 40 }, { x: 0, y: 0, zoom: 1 }, { x: 2, y: 2 }),
    ).toEqual({ x: 400, y: 240 });
  });

  it("keeps the cursor's world position fixed while zooming", () => {
    const cursor = { x: 340, y: 210 };
    const camera = { x: -80, y: 30, zoom: 0.75 };
    const before = viewportToWorld(cursor, camera);
    const after = viewportToWorld(cursor, zoomCameraAt(camera, cursor, 3));
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it("clamps zoom and fits content including negative world coordinates", () => {
    expect(zoomCameraAt({ x: 0, y: 0, zoom: 1 }, { x: 0, y: 0 }, 100).zoom).toBe(MAX_ZOOM);
    expect(zoomCameraAt({ x: 0, y: 0, zoom: 1 }, { x: 0, y: 0 }, 0.001).zoom).toBe(MIN_ZOOM);
    const camera = fitCamera(
      { x: -300, y: -100, width: 400, height: 200 },
      {
        width: 1000,
        height: 600,
      },
    );
    expect(worldToViewport({ x: -100, y: 0 }, camera)).toEqual({ x: 500, y: 300 });
  });

  it("uses CSS pixels and is therefore invariant across device pixel ratios", () => {
    const camera = { x: 25, y: 40, zoom: 1.5 };
    const cssClientPoint = { x: 425, y: 340 };
    const viewportOrigin = { x: 100, y: 80 };
    const atDprOne = clientToWorld(cssClientPoint, viewportOrigin, camera);
    const devicePixelRatio = 3;
    const atHighDpr = clientToWorld(
      { x: (cssClientPoint.x * devicePixelRatio) / devicePixelRatio, y: cssClientPoint.y },
      viewportOrigin,
      camera,
    );
    expect(atHighDpr).toEqual(atDprOne);
  });
});
