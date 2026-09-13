import { describe, expect, it } from "vitest";

import {
  boundsContainPoint,
  boundsHitTestPolicy,
  boundsOverlap,
  CanvasSpatialIndex,
  bringForward,
  bringToFront,
  attachTextBoxGroupBlock,
  deleteElements,
  detachTextBoxGroupBlock,
  duplicateElements,
  elementBounds,
  hitTestElements,
  expandGroupedSelection,
  groupElements,
  insertElement,
  insertTextBoxGroupBlock,
  moveElements,
  moveTextBoxGroupBlock,
  resizeElement,
  sendBackward,
  sendToBack,
  setMarkdownColorStyle,
  textBoxGroupBounds,
  textBoxGroupInsertionY,
  textBoxGroupMemberIds,
  ungroupElements,
  type CanvasElement,
} from "./index";

const MARKDOWN_ID = "323e4567-e89b-42d3-a456-426614174002";
const INK_ID = "423e4567-e89b-42d3-a456-426614174003";
const SHAPE_ID = "523e4567-e89b-42d3-a456-426614174004";
const COPY_ID = "623e4567-e89b-42d3-a456-426614174005";
const GROUP_ID = "723e4567-e89b-42d3-a456-426614174005";
const COPY_GROUP_ID = "823e4567-e89b-42d3-a456-426614174006";
const IMAGE_ID = "923e4567-e89b-42d3-a456-426614174007";
const SECOND_MARKDOWN_ID = "a23e4567-e89b-42d3-a456-426614174008";

const markdown: CanvasElement = {
  kind: "markdown",
  id: MARKDOWN_ID,
  position: [-20, 10],
  z: 0,
  width: 100,
  height: 80,
  source: `markdown/${MARKDOWN_ID}.md`,
};
const ink: CanvasElement = {
  kind: "ink",
  id: INK_ID,
  position: [10, 20],
  z: 1,
  points: [
    [0, 0],
    [20, 10],
  ],
  style: { color: "#111111", width: 4, opacity: 1, highlighter: false },
};
const shape: CanvasElement = {
  kind: "shape",
  id: SHAPE_ID,
  position: [40, 50],
  z: 2,
  geometry: { kind: "rectangle", width: 60, height: 30 },
  style: { strokeColor: "#222222", strokeWidth: 2, fillColor: null, opacity: 1 },
};
const image: CanvasElement = {
  kind: "image",
  id: IMAGE_ID,
  position: [80, 90],
  z: 3,
  width: 320,
  height: 180,
  asset: `assets/${"a".repeat(64)}.png`,
};

describe("canvas element model", () => {
  it("calculates bounds for strokes larger than the function argument limit", () => {
    const largeInk = {
      ...ink,
      points: Array.from({ length: 150_000 }, (_, x) => [x, 0] as const),
    };
    expect(elementBounds(largeInk)).toEqual({ x: 8, y: 18, width: 150_003, height: 4 });
  });
  it("handles coordinates whose spatial cells cannot advance by one", () => {
    const remote = { ...markdown, position: [1e25, -1e25] as const };
    const index = new CanvasSpatialIndex([remote]);
    expect(index.queryPoint({ x: remote.position[0], y: remote.position[1] })).toEqual([remote]);
    expect(index.queryPoint({ x: 0, y: 0 })).toEqual([]);
    expect(
      new CanvasSpatialIndex([markdown], { cellSize: Number.MIN_VALUE }).queryPoint({
        x: markdown.position[0],
        y: markdown.position[1],
      }),
    ).toEqual([markdown]);
  });

  it("derives deterministic world bounds for every element kind", () => {
    expect(elementBounds(markdown)).toEqual({ x: -20, y: 10, width: 100, height: 80 });
    expect(elementBounds(image)).toEqual({ x: 80, y: 90, width: 320, height: 180 });
    expect(elementBounds(ink)).toEqual({ x: 8, y: 18, width: 24, height: 14 });
    expect(elementBounds(shape)).toEqual({ x: 40, y: 50, width: 60, height: 30 });
    expect(elementBounds(ink)).toBe(elementBounds(ink));
  });

  it("treats images as movable, resizable, groupable, and duplicable elements", () => {
    const grouped = groupElements([image, shape], new Set([IMAGE_ID, SHAPE_ID]), GROUP_ID);
    expect(expandGroupedSelection(grouped, new Set([IMAGE_ID]))).toEqual(
      new Set([IMAGE_ID, SHAPE_ID]),
    );
    expect(moveElements(grouped, new Set([IMAGE_ID]), { x: 5, y: -3 })[0]?.position).toEqual([
      85, 87,
    ]);
    expect(resizeElement([image], IMAGE_ID, { x: 10, y: 20, width: 120, height: 70 })[0]).toEqual(
      expect.objectContaining({ position: [10, 20], width: 120, height: 70 }),
    );
    const result = duplicateElements([image], new Set([IMAGE_ID]), () => COPY_ID);
    expect(result.elements[1]).toMatchObject({
      kind: "image",
      id: COPY_ID,
      position: [104, 114],
      asset: image.asset,
    });
  });

  it("calculates line, arrow, and ellipse geometry bounds with stroke padding", () => {
    const line: CanvasElement = {
      ...shape,
      id: "723e4567-e89b-42d3-a456-426614174005",
      position: [10, 20],
      geometry: { kind: "line", start: [30, 40], end: [-10, 5] },
    };
    const arrow: CanvasElement = {
      ...line,
      id: "823e4567-e89b-42d3-a456-426614174006",
      geometry: { kind: "arrow", start: [0, 0], end: [40, 20] },
    };
    const ellipse: CanvasElement = {
      ...shape,
      id: "923e4567-e89b-42d3-a456-426614174007",
      geometry: { kind: "ellipse", width: 30, height: 18 },
    };

    expect(elementBounds(line)).toEqual({ x: -1, y: 24, width: 42, height: 37 });
    expect(elementBounds(arrow)).toEqual({ x: 9, y: 19, width: 42, height: 22 });
    expect(elementBounds(ellipse)).toEqual({ x: 40, y: 50, width: 30, height: 18 });
    expect(boundsContainPoint(elementBounds(line), { x: -1, y: 24 })).toBe(true);
    expect(boundsOverlap(elementBounds(ellipse), { x: 69, y: 67, width: 2, height: 2 })).toBe(true);
  });

  it("inserts and deletes through immutable common operations", () => {
    const inserted = insertElement([markdown], { ...shape, z: -100 });
    expect(inserted.map(({ id, z }) => ({ id, z }))).toEqual([
      { id: MARKDOWN_ID, z: 0 },
      { id: SHAPE_ID, z: 1 },
    ]);
    expect(deleteElements(inserted, new Set([MARKDOWN_ID]))).toEqual([{ ...shape, z: 0 }]);
    expect(() => insertElement(inserted, shape)).toThrow(/already exists/);
  });

  it("moves a multi-selection and resizes only supported elements", () => {
    const moved = moveElements([markdown, ink, shape], new Set([MARKDOWN_ID, SHAPE_ID]), {
      x: 5.125,
      y: -2.5,
    });
    expect(moved[0]?.position).toEqual([-14.875, 7.5]);
    expect(moved[1]).toBe(ink);
    expect(moved[2]?.position).toEqual([45.125, 47.5]);

    const resized = resizeElement(moved, SHAPE_ID, { x: 0, y: 1, width: 12, height: 48 });
    expect(resized[2]).toMatchObject({
      position: [0, 1],
      geometry: { kind: "rectangle", width: 24, height: 48 },
    });
    expect(
      resizeElement([markdown], MARKDOWN_ID, { x: 0, y: 0, width: 180, height: 24 })[0],
    ).toMatchObject({
      width: 180,
      height: 72,
    });
    expect(resizeElement(resized, INK_ID, { x: 0, y: 0, width: 100, height: 100 })[1]).toBe(ink);

    const arrow: CanvasElement = {
      ...shape,
      geometry: { kind: "arrow", start: [0, 0], end: [40, 20] },
    };
    expect(
      resizeElement([arrow], SHAPE_ID, { x: 10, y: 20, width: 80, height: 40 })[0],
    ).toMatchObject({
      position: [10, 20],
      geometry: { kind: "arrow" },
    });
  });

  it("groups mixed Markdown and ink selections for selection and movement", () => {
    const grouped = groupElements([markdown, ink, shape], new Set([MARKDOWN_ID, INK_ID]), GROUP_ID);
    expect(expandGroupedSelection(grouped, new Set([MARKDOWN_ID]))).toEqual(
      new Set([MARKDOWN_ID, INK_ID]),
    );
    expect(
      moveElements(grouped, new Set([MARKDOWN_ID]), { x: 5, y: -3 }).map(
        (element) => element.position,
      ),
    ).toEqual([
      [-15, 7],
      [15, 17],
      [40, 50],
    ]);
    expect(ungroupElements(grouped, new Set([INK_ID]))).toEqual([markdown, ink, shape]);
  });

  it("lays out text-box groups and captures non-text content by center point", () => {
    const first: CanvasElement = {
      ...markdown,
      position: [0, 0],
      textGroupId: GROUP_ID,
    };
    const second: CanvasElement = {
      ...markdown,
      id: SECOND_MARKDOWN_ID,
      position: [0, 128],
      source: `markdown/${SECOND_MARKDOWN_ID}.md`,
      textGroupId: GROUP_ID,
    };
    const between = { ...shape, position: [20, 94] as const, geometry: { ...shape.geometry } };
    const outside = { ...image, position: [180, 94] as const };
    const elements = [first, second, between, outside];

    expect(textBoxGroupBounds(elements, GROUP_ID)).toEqual({
      x: -12,
      y: -12,
      width: 124,
      height: 232,
    });
    expect(textBoxGroupMemberIds(elements, GROUP_ID)).toEqual(
      new Set([MARKDOWN_ID, SECOND_MARKDOWN_ID, SHAPE_ID]),
    );

    const resized = resizeElement(elements, MARKDOWN_ID, {
      x: 10,
      y: 0,
      width: 150,
      height: 100,
    });
    expect(resized[0]).toMatchObject({ position: [10, 0], width: 150, height: 100 });
    expect(resized[1]).toMatchObject({ position: [10, 148], width: 150 });
    expect(resized[2]?.position).toEqual([20, 114]);
    expect(resized[3]).toBe(outside);

    const moved = moveTextBoxGroupBlock(elements, MARKDOWN_ID, 16);
    expect(moved.map((element) => element.position[1])).toEqual([16, 144, 110, 94]);

    const clamped = moveTextBoxGroupBlock(elements, SECOND_MARKDOWN_ID, -200);
    expect(clamped.map((element) => element.position[1])).toEqual([0, 80, 94, 94]);

    const compactGroup = [first, { ...second, position: [second.position[0], 100] as const }];
    const compactMoved = moveTextBoxGroupBlock(compactGroup, SECOND_MARKDOWN_ID, -200);
    expect(compactMoved[1]?.position[1]).toBe(80);

    const inserted = insertTextBoxGroupBlock(elements, MARKDOWN_ID, {
      ...second,
      id: COPY_ID,
      source: `markdown/${COPY_ID}.md`,
    });
    expect(inserted.find((element) => element.id === COPY_ID)).toMatchObject({
      position: [0, 128],
      textGroupId: GROUP_ID,
      width: 100,
    });
    expect(inserted.find((element) => element.id === SECOND_MARKDOWN_ID)?.position[1]).toBe(256);
    expect(textBoxGroupInsertionY(elements, GROUP_ID, -10)).toBe(0);
    expect(textBoxGroupInsertionY(elements, GROUP_ID, 100)).toBe(128);
    expect(textBoxGroupInsertionY(elements, GROUP_ID, 200)).toBe(256);

    const attachSource: CanvasElement = {
      ...markdown,
      id: COPY_ID,
      position: [200, 40],
      width: 160,
      height: 60,
      source: `markdown/${COPY_ID}.md`,
    };
    const attached = attachTextBoxGroupBlock([...elements, attachSource], COPY_ID, GROUP_ID, 100);
    expect(attached.find((element) => element.id === COPY_ID)).toMatchObject({
      position: [0, 128],
      textGroupId: GROUP_ID,
      width: 100,
    });
    expect(attached.find((element) => element.id === SECOND_MARKDOWN_ID)?.position[1]).toBe(236);
    expect(attached.find((element) => element.id === SHAPE_ID)?.position[1]).toBe(94);

    const groupedSource = { ...attachSource, groupId: GROUP_ID };
    expect(attachTextBoxGroupBlock([...elements, groupedSource], COPY_ID, GROUP_ID, 100)).toEqual([
      ...elements,
      groupedSource,
    ]);

    const detached = detachTextBoxGroupBlock(elements, MARKDOWN_ID);
    expect(detached[0]).toMatchObject({ position: [160, 0] });
    expect(detached[0]).not.toHaveProperty("textGroupId");
    expect(detached[1]?.position[1]).toBe(0);
    expect(detached[2]?.position[1]).toBe(-34);
  });

  it("changes a Markdown color style across a whole text-box group", () => {
    const first = { ...markdown, textGroupId: GROUP_ID };
    const second = {
      ...markdown,
      id: SECOND_MARKDOWN_ID,
      source: `markdown/${SECOND_MARKDOWN_ID}.md`,
      textGroupId: GROUP_ID,
    };
    const styled = setMarkdownColorStyle([first, second, shape], MARKDOWN_ID, COPY_ID);

    expect(styled[0]).toHaveProperty("markdownStyleId", COPY_ID);
    expect(styled[1]).toHaveProperty("markdownStyleId", COPY_ID);
    expect(styled[2]).toEqual(shape);
    expect(setMarkdownColorStyle(styled, SECOND_MARKDOWN_ID, undefined)).toEqual([
      first,
      second,
      shape,
    ]);
  });

  it("supports all four shared z-order operations", () => {
    const elements = [markdown, ink, shape];
    const ids = (values: readonly CanvasElement[]) => values.map((element) => element.id);
    expect(ids(bringForward(elements, new Set([MARKDOWN_ID])))).toEqual([
      INK_ID,
      MARKDOWN_ID,
      SHAPE_ID,
    ]);
    expect(ids(sendBackward(elements, new Set([SHAPE_ID])))).toEqual([
      MARKDOWN_ID,
      SHAPE_ID,
      INK_ID,
    ]);
    expect(ids(bringToFront(elements, new Set([MARKDOWN_ID])))).toEqual([
      INK_ID,
      SHAPE_ID,
      MARKDOWN_ID,
    ]);
    expect(ids(sendToBack(elements, new Set([SHAPE_ID])))).toEqual([SHAPE_ID, MARKDOWN_ID, INK_ID]);
  });

  it("duplicates with new stable IDs, matching Markdown sources, and front z-order", () => {
    const result = duplicateElements([markdown, ink], new Set([MARKDOWN_ID]), () => COPY_ID);
    expect([...result.duplicatedIds]).toEqual([COPY_ID]);
    expect(result.elements[2]).toMatchObject({
      id: COPY_ID,
      position: [4, 34],
      source: `markdown/${COPY_ID}.md`,
      z: 2,
    });
  });

  it("gives duplicated grouped objects their own group identifier", () => {
    const grouped = groupElements([markdown, ink], new Set([MARKDOWN_ID, INK_ID]), GROUP_ID);
    const ids = [COPY_ID, "923e4567-e89b-42d3-a456-426614174007"];
    const result = duplicateElements(
      grouped,
      new Set([MARKDOWN_ID, INK_ID]),
      () => ids.shift() as string,
      undefined,
      () => COPY_GROUP_ID,
    );
    const copies = result.elements.filter((element) => result.duplicatedIds.has(element.id));
    expect(copies).toHaveLength(2);
    expect(new Set(copies.map((element) => element.groupId))).toEqual(new Set([COPY_GROUP_ID]));
    expect(copies.every((element) => element.groupId !== GROUP_ID)).toBe(true);
  });

  it("hit-tests front-to-back with interchangeable policies", () => {
    expect(hitTestElements([markdown, shape], { x: 50, y: 60 }, boundsHitTestPolicy)).toEqual([
      shape,
      markdown,
    ]);
    expect(
      hitTestElements(
        [markdown, shape],
        { x: 50, y: 60 },
        {
          hit: (element) => element.kind === "markdown",
        },
      ),
    ).toEqual([markdown]);
  });

  it("rejects out-of-bounds objects before running an expensive policy", () => {
    let policyCalls = 0;
    const hits = hitTestElements(
      [markdown, shape],
      { x: 500, y: 500 },
      {
        hit: () => {
          policyCalls += 1;
          return true;
        },
      },
    );
    expect(hits).toEqual([]);
    expect(policyCalls).toBe(0);
  });

  it("queries viewport candidates through a deterministic spatial prefilter", () => {
    const index = new CanvasSpatialIndex([markdown, ink, shape], { cellSize: 32 });
    expect(index.query({ x: -30, y: 0, width: 20, height: 20 })).toEqual([markdown]);
    expect(index.queryPoint({ x: 50, y: 60 })).toEqual([markdown, shape]);
    expect(index.hitCandidates({ x: 50, y: 60 }).map((element) => element.id)).toEqual([
      SHAPE_ID,
      MARKDOWN_ID,
    ]);
  });
});
