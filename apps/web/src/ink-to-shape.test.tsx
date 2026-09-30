import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_DRAWING_PREFERENCES,
  SpatialCanvas,
  type SpatialCanvasProps,
} from "@squillpad/ui";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
let canvas: HTMLDivElement;
const penPreferences = {
  ...DEFAULT_DRAWING_PREFERENCES,
  lastTool: "pen" as const,
};
const camera = { x: 0, y: 0, zoom: 1 };

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function render(props: Partial<SpatialCanvasProps> = {}) {
  act(() =>
    root.render(
      <SpatialCanvas
        pageId="page-a"
        camera={camera}
        drawingPreferences={penPreferences}
        {...props}
      />,
    ),
  );
  canvas = container.querySelector<HTMLDivElement>(".spatial-canvas")!;
  canvas.setPointerCapture = vi.fn();
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 800,
    bottom: 600,
    width: 800,
    height: 600,
    toJSON: () => ({}),
  });
  Object.defineProperty(canvas, "clientWidth", {
    configurable: true,
    value: 800,
  });
  Object.defineProperty(canvas, "clientHeight", {
    configurable: true,
    value: 600,
  });
}

function pointer(type: string, x: number, y: number) {
  const event = new MouseEvent(type, {
    bubbles: true,
    clientX: x,
    clientY: y,
    button: 0,
    buttons: type === "pointerup" ? 0 : 1,
  });
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    pointerType: { value: "pen" },
    isPrimary: { value: true },
  });
  act(() => canvas.dispatchEvent(event));
}

function drawRectangle() {
  pointer("pointerdown", 100, 100);
  for (const [x, y] of [
    [200, 100],
    [200, 180],
    [100, 180],
    [100, 100],
  ])
    pointer("pointermove", x!, y!);
}

describe("canvas ink-to-shape boundaries", () => {
  it("does not start drawing or recognition in a read-only canvas", () => {
    const changes = vi.fn();
    render({ readOnly: true, onElementsChange: changes });
    drawRectangle();
    act(() => vi.advanceTimersByTime(900));
    pointer("pointerup", 100, 100);
    expect(container.querySelector(".canvas-shape-preview")).toBeNull();
    expect(changes).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "read-only transition cancels the stroke (recognized: %s)",
    (recognized) => {
      const changes = vi.fn();
      render({ onElementsChange: changes });
      drawRectangle();
      if (recognized) {
        act(() => vi.advanceTimersByTime(650));
        expect(
          container.querySelector(".canvas-shape-preview rect"),
        ).not.toBeNull();
      }
      render({ readOnly: true, onElementsChange: changes });
      act(() => vi.advanceTimersByTime(900));
      pointer("pointerup", 100, 100);
      expect(container.querySelector(".canvas-shape-preview")).toBeNull();
      expect(changes).not.toHaveBeenCalled();
    },
  );

  it("page changes discard recognized geometry instead of committing it into the new page", () => {
    const changes = vi.fn();
    render({ onElementsChange: changes });
    drawRectangle();
    act(() => vi.advanceTimersByTime(650));
    expect(
      container.querySelector(".canvas-shape-preview rect"),
    ).not.toBeNull();
    render({ pageId: "page-b", onElementsChange: changes });
    pointer("pointerup", 100, 100);
    expect(container.querySelector(".canvas-shape-preview")).toBeNull();
    expect(changes).not.toHaveBeenCalled();
  });

  it("camera changes cancel a pending hold before coordinates can become stale", () => {
    const changes = vi.fn();
    render({ onElementsChange: changes });
    drawRectangle();
    render({ camera: { ...camera, zoom: 2 }, onElementsChange: changes });
    act(() => vi.advanceTimersByTime(900));
    pointer("pointerup", 100, 100);
    expect(container.querySelector(".canvas-shape-preview")).toBeNull();
    expect(changes).not.toHaveBeenCalled();
  });

  it("unmount clears the recognition timer", () => {
    const changes = vi.fn();
    render({ onElementsChange: changes });
    drawRectangle();
    act(() => root.render(null));
    act(() => vi.advanceTimersByTime(900));
    expect(changes).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("Escape cancels an active shape before requesting fullscreen exit", () => {
    const changes = vi.fn();
    const fullscreenChange = vi.fn();
    render({
      fullscreen: true,
      onElementsChange: changes,
      onFullscreenChange: fullscreenChange,
    });
    drawRectangle();
    act(() => vi.advanceTimersByTime(650));
    expect(
      container.querySelector(".canvas-shape-preview rect"),
    ).not.toBeNull();
    act(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", cancelable: true }),
      ),
    );
    pointer("pointerup", 100, 100);
    expect(container.querySelector(".canvas-shape-preview")).toBeNull();
    expect(changes).not.toHaveBeenCalled();
    expect(fullscreenChange).not.toHaveBeenCalled();
  });
});
