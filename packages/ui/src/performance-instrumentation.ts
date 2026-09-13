export interface PerformanceMetricSummary {
  readonly sampleCount: number;
  readonly lastMs: number | undefined;
  readonly averageMs: number | undefined;
  readonly maxMs: number | undefined;
}

export interface CanvasPerformanceSnapshot {
  readonly pageOpenMs: number | undefined;
  readonly panZoomFrame: PerformanceMetricSummary;
  readonly activeInkLatency: PerformanceMetricSummary;
  readonly memoryGrowthBytes: number | undefined;
  readonly elementCount: number;
  readonly renderedElementCount: number;
}

export interface PerformanceInstrumentationOptions {
  readonly clock?: () => number;
  readonly readMemoryBytes?: () => number | undefined;
}

/** Collects repeatable canvas timings without causing React updates per sample. */
export class CanvasPerformanceInstrumentation {
  readonly #clock: () => number;
  readonly #readMemoryBytes: () => number | undefined;
  #startedAt: number;
  readonly #panZoomFrame = new MetricAccumulator();
  readonly #activeInkLatency = new MetricAccumulator();
  #pageOpenMs: number | undefined;
  #initialMemoryBytes: number | undefined;
  #latestMemoryBytes: number | undefined;
  #elementCount = 0;
  #renderedElementCount = 0;

  constructor(options: PerformanceInstrumentationOptions = {}) {
    this.#clock = options.clock ?? defaultClock;
    this.#readMemoryBytes = options.readMemoryBytes ?? readBrowserMemoryBytes;
    this.#startedAt = this.#clock();
    this.#initialMemoryBytes = this.#readMemoryBytes();
    this.#latestMemoryBytes = this.#initialMemoryBytes;
  }

  /** Starts a fresh page-open measurement while retaining the recorder instance. */
  beginPage(): void {
    this.#startedAt = this.#clock();
    this.#pageOpenMs = undefined;
    this.#initialMemoryBytes = this.#readMemoryBytes();
    this.#latestMemoryBytes = this.#initialMemoryBytes;
    this.#elementCount = 0;
    this.#renderedElementCount = 0;
    this.#panZoomFrame.reset();
    this.#activeInkLatency.reset();
  }

  /** Returns the recorder clock for pairing an interaction start and completion. */
  now(): number {
    return this.#clock();
  }

  /** Records the first committed render of a page and its visible element count. */
  markPageOpened(elementCount: number, renderedElementCount: number): void {
    this.#pageOpenMs ??= Math.max(0, this.#clock() - this.#startedAt);
    this.#recordCounts(elementCount, renderedElementCount);
    this.sampleMemory();
  }

  /** Records one completed pan or zoom frame from its start timestamp. */
  recordPanZoomFrame(startedAt: number): void {
    this.#panZoomFrame.add(Math.max(0, this.#clock() - startedAt));
  }

  /** Records the time between receiving and imperatively painting an ink sample. */
  recordActiveInkLatency(startedAt: number): void {
    this.#activeInkLatency.add(Math.max(0, this.#clock() - startedAt));
  }

  /** Updates counts and samples the browser heap when the platform exposes it. */
  recordCounts(elementCount: number, renderedElementCount: number): void {
    this.#recordCounts(elementCount, renderedElementCount);
    this.sampleMemory();
  }

  /** Samples available heap telemetry without requiring a non-standard API. */
  sampleMemory(): void {
    const memoryBytes = this.#readMemoryBytes();
    if (memoryBytes === undefined) return;
    this.#latestMemoryBytes = memoryBytes;
  }

  /** Returns an immutable snapshot suitable for a diagnostic panel or test. */
  snapshot(): CanvasPerformanceSnapshot {
    const memoryGrowthBytes =
      this.#initialMemoryBytes === undefined || this.#latestMemoryBytes === undefined
        ? undefined
        : this.#latestMemoryBytes - this.#initialMemoryBytes;
    return {
      pageOpenMs: this.#pageOpenMs,
      panZoomFrame: this.#panZoomFrame.snapshot(),
      activeInkLatency: this.#activeInkLatency.snapshot(),
      memoryGrowthBytes,
      elementCount: this.#elementCount,
      renderedElementCount: this.#renderedElementCount,
    };
  }

  #recordCounts(elementCount: number, renderedElementCount: number): void {
    this.#elementCount = elementCount;
    this.#renderedElementCount = renderedElementCount;
  }
}

class MetricAccumulator {
  #sampleCount = 0;
  #totalMs = 0;
  #lastMs: number | undefined;
  #maxMs: number | undefined;

  add(value: number): void {
    this.#sampleCount += 1;
    this.#totalMs += value;
    this.#lastMs = value;
    this.#maxMs = this.#maxMs === undefined ? value : Math.max(this.#maxMs, value);
  }

  reset(): void {
    this.#sampleCount = 0;
    this.#totalMs = 0;
    this.#lastMs = undefined;
    this.#maxMs = undefined;
  }

  snapshot(): PerformanceMetricSummary {
    return {
      sampleCount: this.#sampleCount,
      lastMs: this.#lastMs,
      averageMs: this.#sampleCount === 0 ? undefined : this.#totalMs / this.#sampleCount,
      maxMs: this.#maxMs,
    };
  }
}

function defaultClock(): number {
  return globalThis.performance?.now() ?? Date.now();
}

function readBrowserMemoryBytes(): number | undefined {
  const performanceValue = globalThis.performance as Performance & {
    memory?: { readonly usedJSHeapSize?: number };
  };
  const usedJSHeapSize = performanceValue.memory?.usedJSHeapSize;
  return typeof usedJSHeapSize === "number" && Number.isFinite(usedJSHeapSize)
    ? usedJSHeapSize
    : undefined;
}
