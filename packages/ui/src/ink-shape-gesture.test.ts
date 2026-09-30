import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  InkShapeGesture,
  INK_SHAPE_HOLD_MS,
  type InkShapeStroke,
} from "./ink-shape-gesture";

const stroke: InkShapeStroke = {
  id: "stroke-id",
  pointerId: 7,
  samples: [
    [0, 0],
    [100, 0],
    [100, 80],
    [0, 80],
    [0, 0],
  ],
  style: { color: "#60a5fa", width: 6, opacity: 0.7, highlighter: false },
};

describe("hold-to-shape gesture", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("converts while still held without needing another pointer event", () => {
    const preview = vi.fn();
    const gesture = new InkShapeGesture(preview);
    gesture.begin(stroke, { x: 50, y: 50 }, { x: 0, y: 0 }, 1);
    vi.advanceTimersByTime(INK_SHAPE_HOLD_MS - 1);
    expect(preview).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(preview).toHaveBeenCalledWith(
      expect.objectContaining({
        id: stroke.id,
        kind: "rectangle",
        start: { x: 100, y: 80 },
        end: { x: 0, y: 0 },
        style: {
          strokeColor: stroke.style.color,
          strokeWidth: 6,
          opacity: 0.7,
          fillColor: null,
        },
      }),
    );
    expect(gesture.recognized).toBe(true);
  });

  it("tolerates jitter but restarts the hold after cumulative movement exceeds the deadband", () => {
    const preview = vi.fn();
    const gesture = new InkShapeGesture(preview);
    gesture.begin(stroke, { x: 0, y: 0 }, { x: 0, y: 0 }, 1);
    vi.advanceTimersByTime(400);
    gesture.move(stroke, { x: 2, y: 0 }, { x: 2, y: 0 }, 1);
    gesture.move(stroke, { x: 5, y: 0 }, { x: 5, y: 0 }, 1);
    vi.advanceTimersByTime(INK_SHAPE_HOLD_MS - 1);
    expect(preview).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(preview).toHaveBeenCalledOnce();
  });

  it("does not postpone conversion indefinitely for stationary jitter", () => {
    const preview = vi.fn();
    const gesture = new InkShapeGesture(preview);
    gesture.begin(stroke, { x: 0, y: 0 }, { x: 0, y: 0 }, 1);
    for (let index = 0; index < 6; index++) {
      vi.advanceTimersByTime(100);
      gesture.move(stroke, { x: index % 2, y: 0 }, { x: index % 2, y: 0 }, 1);
    }
    vi.advanceTimersByTime(50);
    expect(gesture.recognized).toBe(true);
  });

  it("resizes from the nearest corner by delta without jumping and includes the release position", () => {
    const preview = vi.fn();
    const gesture = new InkShapeGesture(preview);
    gesture.begin(stroke, { x: 0, y: 0 }, { x: 30, y: 0 }, 1);
    vi.advanceTimersByTime(INK_SHAPE_HOLD_MS);
    expect(preview.mock.lastCall?.[0].end).toEqual({ x: 0, y: 0 });
    gesture.move(stroke, { x: 10, y: 20 }, { x: 40, y: 20 }, 1);
    expect(preview.mock.lastCall?.[0]).toMatchObject({
      start: { x: 100, y: 80 },
      end: { x: 10, y: 20 },
      kind: "rectangle",
    });
    expect(gesture.finish(7, { x: 45, y: 25 })).toMatchObject({
      start: { x: 100, y: 80 },
      end: { x: 15, y: 25 },
      kind: "rectangle",
    });
    expect(preview).toHaveBeenLastCalledWith(undefined);
  });

  it("adjusts a line endpoint while fixing its start", () => {
    const gesture = new InkShapeGesture(vi.fn());
    gesture.begin(
      {
        ...stroke,
        samples: [
          [0, 0],
          [100, 50],
        ],
      },
      { x: 100, y: 50 },
      { x: 100, y: 50 },
      1,
    );
    vi.advanceTimersByTime(INK_SHAPE_HOLD_MS);
    const shape = gesture.finish(7, { x: 120, y: 70 });
    expect(shape?.kind).toBe("line");
    expect(shape?.start.x).toBeCloseTo(0);
    expect(shape?.start.y).toBeCloseTo(0);
    expect(shape?.end.x).toBeCloseTo(120);
    expect(shape?.end.y).toBeCloseTo(70);
  });

  it.each(["finish", "cancel", "dispose"] as const)(
    "clears a pending hold on %s",
    (operation) => {
      const preview = vi.fn();
      const gesture = new InkShapeGesture(preview);
      gesture.begin(stroke, { x: 0, y: 0 }, { x: 0, y: 0 }, 1);
      if (operation === "finish")
        expect(gesture.finish(7, { x: 0, y: 0 })).toBeUndefined();
      else gesture[operation]();
      vi.advanceTimersByTime(INK_SHAPE_HOLD_MS * 2);
      expect(preview).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("ignores moves, releases and cancellations from a different pointer", () => {
    const gesture = new InkShapeGesture(vi.fn());
    gesture.begin(stroke, { x: 0, y: 0 }, { x: 0, y: 0 }, 1);
    gesture.move(
      { ...stroke, pointerId: 8 },
      { x: 200, y: 200 },
      { x: 200, y: 200 },
      1,
    );
    expect(gesture.finish(8, { x: 200, y: 200 })).toBeUndefined();
    gesture.cancel(8);
    vi.advanceTimersByTime(INK_SHAPE_HOLD_MS);
    expect(gesture.recognized).toBe(true);
  });

  it("can retry an unrecognized stroke after drawing continues", () => {
    const gesture = new InkShapeGesture(vi.fn());
    gesture.begin(
      { ...stroke, samples: [[0, 0]] },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      1,
    );
    vi.advanceTimersByTime(INK_SHAPE_HOLD_MS);
    expect(gesture.recognized).toBe(false);
    gesture.move(stroke, { x: 5, y: 0 }, { x: 5, y: 0 }, 1);
    vi.advanceTimersByTime(INK_SHAPE_HOLD_MS);
    expect(gesture.recognized).toBe(true);
  });

  it("preserves thick pen widths when converting strokes to shapes", () => {
    const preview = vi.fn();
    const gesture = new InkShapeGesture(preview);
    gesture.begin(
      { ...stroke, style: { ...stroke.style, width: 30 } },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      1,
    );
    vi.advanceTimersByTime(INK_SHAPE_HOLD_MS);
    expect(preview.mock.lastCall?.[0].style.strokeWidth).toBe(30);
  });
});
