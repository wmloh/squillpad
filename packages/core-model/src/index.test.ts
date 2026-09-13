import { describe, expect, it } from "vitest";

import {
  CANONICAL_SCHEMA_VERSION,
  CORE_MODEL_VERSION,
  canonicalCoordinate,
  measureCanonicalCanvasBytes,
  measureCanonicalCanvasRecordBytes,
  serializeCanonicalJson,
  serializeCanvasJsonLines,
  validateCanvasRecord,
  validateCanvasRecords,
  validateNotebookManifest,
  validatePageManifest,
  validateSectionManifest,
  type CanvasRecord,
} from "./index";

const PROJECT_ID = "018f1f2e-7c8a-7b1c-8d2e-3f4a5b6c7d8e";
const SECTION_ID = "123e4567-e89b-42d3-a456-426614174000";
const PAGE_ID = "223e4567-e89b-42d3-a456-426614174001";
const MARKDOWN_ID = "323e4567-e89b-42d3-a456-426614174002";
const INK_ID = "423e4567-e89b-42d3-a456-426614174003";
const SHAPE_ID = "523e4567-e89b-42d3-a456-426614174004";
const IMAGE_ID = "623e4567-e89b-42d3-a456-426614174005";

describe("core model", () => {
  it("exposes a positive model version", () => {
    expect(CORE_MODEL_VERSION).toBeGreaterThan(0);
  });
});

describe("canonical manifests", () => {
  it("validates the notebook, section, and page formats", () => {
    expect(
      validateNotebookManifest({
        schemaVersion: CANONICAL_SCHEMA_VERSION,
        projectId: PROJECT_ID,
        title: "Research notebook",
        sectionIds: [SECTION_ID],
        settings: { defaultZoom: 1, metadata: { theme: "system" } },
      }).success,
    ).toBe(true);
    expect(
      validateSectionManifest({
        schemaVersion: CANONICAL_SCHEMA_VERSION,
        id: SECTION_ID,
        title: "Ideas",
        pageIds: [PAGE_ID],
        metadata: {},
      }).success,
    ).toBe(true);
    expect(
      validatePageManifest({
        schemaVersion: CANONICAL_SCHEMA_VERSION,
        id: PAGE_ID,
        title: "Sketch",
        metadata: { pinned: false },
      }).success,
    ).toBe(true);
  });

  it("rejects path-like IDs, duplicate ordering entries, and unknown fields", () => {
    const result = validateNotebookManifest({
      schemaVersion: CANONICAL_SCHEMA_VERSION,
      projectId: "../outside",
      title: "Unsafe",
      sectionIds: [SECTION_ID, SECTION_ID],
      settings: { defaultZoom: 1, metadata: {} },
      surprise: true,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues.map((issue) => issue.path)).toEqual(
        expect.arrayContaining(["$.projectId", "$.sectionIds[1]", "$.surprise"]),
      );
    }
  });
});

describe("canvas records", () => {
  const markdown: CanvasRecord = {
    kind: "markdown",
    id: MARKDOWN_ID,
    position: [-20.125, 10.5],
    z: 2,
    width: 480,
    height: 240,
    source: `markdown/${MARKDOWN_ID}.md`,
  };
  const ink: CanvasRecord = {
    kind: "ink",
    id: INK_ID,
    position: [0, 0],
    z: 1,
    points: [
      [0, 0],
      [12.25, 8.75],
    ],
    style: { color: "#1f2937", width: 2.5, opacity: 1, highlighter: false },
  };
  const shape: CanvasRecord = {
    kind: "shape",
    id: SHAPE_ID,
    position: [40, 50],
    z: 3,
    geometry: { kind: "rectangle", width: 120, height: 80 },
    style: { strokeColor: "#000000", strokeWidth: 2, fillColor: null, opacity: 1 },
  };
  const image: CanvasRecord = {
    kind: "image",
    id: IMAGE_ID,
    position: [80, 90],
    z: 4,
    width: 320,
    height: 180,
    asset: `assets/${"a".repeat(64)}.png`,
  };

  it("validates Markdown, asset-backed images, numeric vector ink, and semantic shapes", () => {
    expect(validateCanvasRecord(markdown).success).toBe(true);
    expect(validateCanvasRecord(image).success).toBe(true);
    expect(validateCanvasRecord(ink).success).toBe(true);
    expect(validateCanvasRecord(shape).success).toBe(true);
    expect(markdown).not.toHaveProperty("markdown");
    expect(validateCanvasRecord({ ...markdown, textGroupId: SECTION_ID }).success).toBe(true);
    expect(validateCanvasRecord({ ...markdown, markdownStyleId: SECTION_ID }).success).toBe(true);
    expect(validateCanvasRecord({ ...markdown, textGroupId: "not-a-stable-id" }).success).toBe(
      false,
    );
    expect(validateCanvasRecord({ ...ink, textGroupId: SECTION_ID }).success).toBe(false);
  });

  it("rejects duplicate permanent object IDs across the page", () => {
    const result = validateCanvasRecords([markdown, { ...markdown, z: 4 }]);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toContainEqual({
        path: "$[1].id",
        message: "must not duplicate another object ID",
      });
    }
  });

  it("accepts semantic arrows and extended deterministic ink style settings", () => {
    expect(
      validateCanvasRecord({
        id: "423e4567-e89b-42d3-a456-426614174003",
        kind: "shape",
        position: [0, 0],
        z: 0,
        geometry: { kind: "arrow", start: [0, 0], end: [20, 10] },
        style: { strokeColor: "#111111", strokeWidth: 2, fillColor: null, opacity: 1 },
      }).success,
    ).toBe(true);
    expect(
      validateCanvasRecord({
        id: "523e4567-e89b-42d3-a456-426614174004",
        kind: "ink",
        position: [0, 0],
        z: 0,
        points: [[0, 0]],
        style: {
          color: "#111111",
          width: 4,
          opacity: 1,
          highlighter: false,
          smoothing: 0.65,
        },
      }).success,
    ).toBe(true);
  });

  it("requires the Markdown filename to match the permanent object ID", () => {
    expect(validateCanvasRecord({ ...markdown, source: "markdown/renamed.md" }).success).toBe(
      false,
    );
  });

  it("requires page-local content-addressed raster assets", () => {
    expect(validateCanvasRecord({ ...image, asset: "https://example.com/image.png" }).success).toBe(
      false,
    );
    expect(validateCanvasRecord({ ...image, asset: `assets/${"a".repeat(64)}.svg` }).success).toBe(
      false,
    );
  });

  it("rejects raster ink, prerendered shapes, and excess numeric precision", () => {
    expect(validateCanvasRecord({ ...ink, points: [[1.0001, 0]] }).success).toBe(false);
    expect(validateCanvasRecord({ ...ink, raster: "stroke.png" }).success).toBe(false);
    expect(validateCanvasRecord({ ...shape, svg: "<rect />" }).success).toBe(false);
  });

  it("serializes records in deterministic stacking order with one record per LF line", () => {
    const serialized = serializeCanvasJsonLines([shape, markdown, ink]);
    const lines = serialized.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => (JSON.parse(line) as { id: string }).id)).toEqual([
      INK_ID,
      MARKDOWN_ID,
      SHAPE_ID,
    ]);
    expect(serialized.endsWith("\n")).toBe(true);
    expect(serialized).not.toContain("\r");
  });

  it("measures canonical handwriting bytes without counting derived render geometry", () => {
    const bytes = measureCanonicalCanvasBytes([ink]);
    const perRecord = measureCanonicalCanvasRecordBytes([ink]);
    expect(bytes).toBe(perRecord[INK_ID]);
    expect(bytes).toBe(new TextEncoder().encode(serializeCanvasJsonLines([ink])).byteLength);
    expect(serializeCanvasJsonLines([ink])).not.toContain("svg");
  });
});

describe("canonical serialization", () => {
  it("sorts keys recursively, preserves Unicode, and ends with one LF", () => {
    expect(serializeCanonicalJson({ z: "✓", nested: { b: 2, a: 1 }, a: true })).toBe(
      '{\n  "a": true,\n  "nested": {\n    "a": 1,\n    "b": 2\n  },\n  "z": "✓"\n}\n',
    );
  });

  it("quantizes coordinates without negative zero", () => {
    expect(canonicalCoordinate(12.34567)).toBe(12.346);
    expect(canonicalCoordinate(-0.0001)).toBe(0);
  });

  it("rejects non-finite and over-precise canonical values before persistence", () => {
    const result = validateCanvasRecord({
      kind: "ink",
      id: INK_ID,
      position: [Number.NaN, 0],
      z: 0,
      points: [[0.0001, 0]],
      style: { color: "#000", width: 2, opacity: 1, highlighter: false },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues.map((issue) => issue.path)).toEqual(
        expect.arrayContaining(["$.position[0]", "$.points[0][0]"]),
      );
    }
  });
});
