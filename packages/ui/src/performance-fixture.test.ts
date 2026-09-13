import { describe, expect, it } from "vitest";

import { validateCanvasRecords } from "@squillpad/core-model";

import { createSyntheticStressPage } from "./performance-fixture";

describe("synthetic performance page", () => {
  it("contains thousands of vector strokes, Markdown blocks, and shapes", () => {
    const fixture = createSyntheticStressPage({
      strokeCount: 1_200,
      markdownCount: 180,
      shapeCount: 48,
      pointsPerStroke: 12,
    });
    expect(fixture.elements.filter((element) => element.kind === "ink")).toHaveLength(1_200);
    expect(fixture.elements.filter((element) => element.kind === "markdown")).toHaveLength(180);
    expect(fixture.elements.filter((element) => element.kind === "shape")).toHaveLength(48);
    expect(Object.keys(fixture.markdownSources)).toHaveLength(180);
    expect(validateCanvasRecords(fixture.elements).success).toBe(true);
  });
});
