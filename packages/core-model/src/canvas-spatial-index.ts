import {
  boundsOverlap,
  elementBounds,
  type CanvasBounds,
  type CanvasElement,
  type CanvasDelta,
} from "./canvas-elements.js";

const DEFAULT_CELL_SIZE = 512;
const MAX_QUERY_CELLS = 4096;
const MAX_INDEX_CELLS_PER_ELEMENT = 256;

/** Options for the page-level uniform-grid spatial prefilter. */
export interface CanvasSpatialIndexOptions {
  readonly cellSize?: number;
}

/**
 * A disposable broad-phase index for viewport and pointer queries.
 *
 * The index never changes canonical records and callers can rebuild it when the
 * immutable element collection changes.
 */
export class CanvasSpatialIndex {
  readonly #elements: readonly CanvasElement[];
  readonly #cellSize: number;
  readonly #cells = new Map<string, Set<CanvasElement>>();
  readonly #largeElements = new Set<CanvasElement>();
  readonly #bounds = new Map<CanvasElement, CanvasBounds>();

  constructor(elements: readonly CanvasElement[], options: CanvasSpatialIndexOptions = {}) {
    this.#elements = [...elements];
    this.#cellSize = validCellSize(options.cellSize ?? DEFAULT_CELL_SIZE);
    for (const element of this.#elements) this.#index(element);
  }

  /** Returns all objects whose cached bounds overlap the query rectangle. */
  query(bounds: CanvasBounds): readonly CanvasElement[] {
    const candidates = this.#candidateSet(bounds);
    return this.#elements.filter((element) => {
      if (candidates !== undefined && !candidates.has(element)) return false;
      return boundsOverlap(this.#bounds.get(element) as CanvasBounds, bounds);
    });
  }

  /** Returns all objects whose cached bounds contain a world-space point. */
  queryPoint(point: CanvasDelta, padding = 0): readonly CanvasElement[] {
    return this.query({
      x: point.x - padding,
      y: point.y - padding,
      width: padding * 2,
      height: padding * 2,
    });
  }

  /** Returns the broad-phase candidates in front-to-back z order. */
  hitCandidates(point: CanvasDelta, padding = 0): readonly CanvasElement[] {
    return [...this.queryPoint(point, padding)].sort(
      (left, right) => right.z - left.z || compareIds(right.id, left.id),
    );
  }

  #index(element: CanvasElement): void {
    const bounds = elementBounds(element);
    this.#bounds.set(element, bounds);
    const range = cellRange(bounds, this.#cellSize);
    const cellCount = (range.maxX - range.minX + 1) * (range.maxY - range.minY + 1);
    if (
      !Object.values(range).every(Number.isSafeInteger) ||
      cellCount > MAX_INDEX_CELLS_PER_ELEMENT
    ) {
      this.#largeElements.add(element);
      return;
    }
    for (let x = range.minX; x <= range.maxX; x += 1) {
      for (let y = range.minY; y <= range.maxY; y += 1) {
        const key = cellKey(x, y);
        const cell = this.#cells.get(key) ?? new Set<CanvasElement>();
        cell.add(element);
        this.#cells.set(key, cell);
      }
    }
  }

  #candidateSet(bounds: CanvasBounds): Set<CanvasElement> | undefined {
    const range = cellRange(bounds, this.#cellSize);
    const cellCount = (range.maxX - range.minX + 1) * (range.maxY - range.minY + 1);
    if (!Object.values(range).every(Number.isSafeInteger) || cellCount > MAX_QUERY_CELLS)
      return undefined;

    const candidates = new Set(this.#largeElements);
    for (let x = range.minX; x <= range.maxX; x += 1) {
      for (let y = range.minY; y <= range.maxY; y += 1) {
        const cell = this.#cells.get(cellKey(x, y));
        if (cell === undefined) continue;
        for (const element of cell) candidates.add(element);
      }
    }
    return candidates;
  }
}

function validCellSize(value: number): number {
  if (!Number.isFinite(value) || value <= 0)
    throw new Error("Canvas spatial index cell size is invalid");
  return value;
}

function cellRange(bounds: CanvasBounds, cellSize: number) {
  return {
    minX: Math.floor(bounds.x / cellSize),
    maxX: Math.floor((bounds.x + Math.max(0, bounds.width)) / cellSize),
    minY: Math.floor(bounds.y / cellSize),
    maxY: Math.floor((bounds.y + Math.max(0, bounds.height)) / cellSize),
  };
}

function cellKey(x: number, y: number): string {
  return `${x}:${y}`;
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
