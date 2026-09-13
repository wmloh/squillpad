import { describe, expect, it } from "vitest";

import { CanvasPerformanceInstrumentation } from "./performance-instrumentation";

describe("canvas performance instrumentation", () => {
  it("records repeatable page, frame, latency, count, and heap metrics", () => {
    let time = 100;
    let memory = 1_000;
    const instrumentation = new CanvasPerformanceInstrumentation({
      clock: () => time,
      readMemoryBytes: () => memory,
    });

    instrumentation.beginPage();
    time = 112;
    instrumentation.markPageOpened(3000, 42);
    const frameStart = time;
    time = 116;
    instrumentation.recordPanZoomFrame(frameStart);
    const inkStart = time;
    time = 117.5;
    instrumentation.recordActiveInkLatency(inkStart);
    memory = 1_250;
    instrumentation.recordCounts(3000, 44);

    expect(instrumentation.snapshot()).toEqual({
      pageOpenMs: 12,
      panZoomFrame: { sampleCount: 1, lastMs: 4, averageMs: 4, maxMs: 4 },
      activeInkLatency: { sampleCount: 1, lastMs: 1.5, averageMs: 1.5, maxMs: 1.5 },
      memoryGrowthBytes: 250,
      elementCount: 3000,
      renderedElementCount: 44,
    });
  });
});
