import { canonicalCoordinate, type CanvasElement } from "@squillpad/core-model";

export interface SyntheticStressPageOptions {
  readonly strokeCount?: number;
  readonly markdownCount?: number;
  readonly shapeCount?: number;
  readonly pointsPerStroke?: number;
}

export interface SyntheticStressPage {
  readonly elements: readonly CanvasElement[];
  readonly markdownSources: Readonly<Record<string, string>>;
}

const DEFAULT_OPTIONS: Required<SyntheticStressPageOptions> = {
  strokeCount: 2000,
  markdownCount: 320,
  shapeCount: 96,
  pointsPerStroke: 32,
};

/** Builds a deterministic large page fixture for repeatable culling and storage checks. */
export function createSyntheticStressPage(
  options: SyntheticStressPageOptions = {},
): SyntheticStressPage {
  const values = { ...DEFAULT_OPTIONS, ...options };
  assertNonNegativeInteger(values.strokeCount, "strokeCount");
  assertNonNegativeInteger(values.markdownCount, "markdownCount");
  assertNonNegativeInteger(values.shapeCount, "shapeCount");
  assertNonNegativeInteger(values.pointsPerStroke, "pointsPerStroke");

  const elements: CanvasElement[] = [];
  const markdownSources: Record<string, string> = {};
  let z = 0;

  for (let index = 0; index < values.strokeCount; index += 1) {
    const id = stressId("1", index);
    const row = Math.floor(index / 50);
    const column = index % 50;
    elements.push({
      id,
      kind: "ink",
      position: [column * 180, row * 120],
      z: z++,
      points: Array.from(
        { length: Math.max(1, values.pointsPerStroke) },
        (_point, pointIndex) =>
          [
            pointIndex * 4,
            canonicalCoordinate(Math.sin(pointIndex / 2) * 12 + (index % 7)),
          ] as const,
      ),
      style: {
        color: index % 2 === 0 ? "#38245f" : "#176b45",
        width: 4,
        opacity: 1,
        highlighter: false,
        smoothing: 0.65,
      },
    });
  }

  for (let index = 0; index < values.markdownCount; index += 1) {
    const id = stressId("2", index);
    elements.push({
      id,
      kind: "markdown",
      position: [(index % 20) * 640, Math.floor(index / 20) * 360],
      z: z++,
      width: 480,
      height: 220,
      source: `markdown/${id}.md`,
    });
    markdownSources[id] = `## Stress block ${index}\n\nThis block measures viewport culling.\n`;
  }

  for (let index = 0; index < values.shapeCount; index += 1) {
    const id = stressId("3", index);
    const x = (index % 16) * 720;
    const y = Math.floor(index / 16) * 420;
    elements.push({
      id,
      kind: "shape",
      position: [x, y],
      z: z++,
      geometry:
        index % 3 === 0
          ? { kind: "ellipse", width: 180, height: 120 }
          : { kind: "rectangle", width: 180, height: 120 },
      style: {
        strokeColor: "#1d5fa7",
        strokeWidth: 3,
        fillColor: index % 4 === 0 ? "#d9e8fa" : null,
        opacity: 1,
      },
    });
  }

  return { elements, markdownSources };
}

function stressId(prefix: string, index: number): string {
  return `00000000-0000-4000-8000-${prefix}${index.toString(16).padStart(11, "0")}`;
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}
