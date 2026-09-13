import { describe, expect, it } from "vitest";
import {
  moveElements,
  resizeElement,
  bringToFront,
  MARKDOWN_COLOR_KEYS,
  type CanvasElement,
  type MarkdownColors,
} from "@squillpad/core-model";
import {
  CanvasHistory,
  type CanvasHistorySnapshot,
  type PageSnapshot,
} from "./canvas-history";
import { createInkRecord, DEFAULT_INK_STYLE } from "./ink-engine";
import { createShapeRecord } from "./drawing-tools";
import { DEFAULT_PROFILE_DRAWING_PALETTES } from "./drawing-preferences";

const text: CanvasElement = {
  id: "text",
  kind: "markdown",
  position: [10, 20],
  width: 200,
  height: 72,
  z: 0,
  source: "markdown/text.md",
};
const ink = createInkRecord(
  "ink",
  1,
  [
    [20, 30],
    [100, 50],
  ],
  DEFAULT_INK_STYLE,
);
const shape = createShapeRecord(
  "shape",
  2,
  "rectangle",
  { x: 30, y: 40 },
  { x: 80, y: 90 },
  { strokeColor: "#111111", strokeWidth: 2, opacity: 1, fillColor: null },
  false,
);
const initial: PageSnapshot = { elements: [text, ink, shape], sources: { text: "# Hello" } };
const markdownColors: MarkdownColors = Object.fromEntries(
  MARKDOWN_COLOR_KEYS.map((key) => [key, { light: "#111111", dark: "#eeeeee" }]),
) as MarkdownColors;
const markdownStyle = { id: "style", name: "Lecture", colors: markdownColors };
const canvasInitial: CanvasHistorySnapshot = {
  ...initial,
  markdownColorStyles: { styles: [] },
  profileDrawingPalettes: DEFAULT_PROFILE_DRAWING_PALETTES,
};
const canvasSnapshot = (snapshot: PageSnapshot): CanvasHistorySnapshot => ({
  ...snapshot,
  markdownColorStyles: canvasInitial.markdownColorStyles,
  profileDrawingPalettes: canvasInitial.profileDrawingPalettes,
});

describe("canvas history", () => {
  it("undoes and redoes a complete mixed drag as one transaction", () => {
    const history = new CanvasHistory();
    const ids = new Set(["text", "ink", "shape"]);
    const moved = moveElements(moveElements(initial.elements, ids, { x: 5, y: 7 }), ids, {
      x: 12,
      y: -2,
    });
    const next = { ...initial, elements: moved };
    history.record("page-a", canvasSnapshot(initial), canvasSnapshot(next));
    expect(history.undo("page-a", canvasSnapshot(next))).toEqual(canvasSnapshot(initial));
    expect(history.canUndo("page-a")).toBe(false);
    expect(history.redo("page-a", canvasSnapshot(initial))).toEqual(canvasSnapshot(next));
  });

  it("covers creation, deletion, resizing, style and cross-kind layering", () => {
    const history = new CanvasHistory();
    const states: PageSnapshot[] = [
      { elements: [], sources: {} },
      initial,
      {
        ...initial,
        elements: resizeElement(initial.elements, "text", { x: 10, y: 20, width: 400, height: 72 }),
      },
    ];
    states.push({ ...initial, elements: bringToFront(states.at(-1)!.elements, new Set(["text"])) });
    states.push({
      ...initial,
      elements: states
        .at(-1)!
        .elements.map((element) =>
          element.kind === "ink"
            ? { ...element, style: { ...element.style, color: "#ff0000" } }
            : element,
        ),
    });
    states.push({ elements: [], sources: {} });
    for (let i = 1; i < states.length; i++) {
      history.record("page-a", canvasSnapshot(states[i - 1]!), canvasSnapshot(states[i]!));
    }
    let current = canvasSnapshot(states.at(-1)!);
    for (let i = states.length - 2; i >= 0; i--) {
      current = history.undo("page-a", current);
      expect(current.elements).toEqual(expect.arrayContaining([...states[i]!.elements]));
      expect(current.sources).toEqual(states[i]!.sources);
    }
    for (let i = 1; i < states.length; i++) current = history.redo("page-a", current);
    expect(current).toEqual(canvasSnapshot(states.at(-1)!));
  });

  it("groups nearby typing and splits pauses", () => {
    const history = new CanvasHistory();
    const a = { ...initial, sources: { text: "a" } };
    const ab = { ...initial, sources: { text: "ab" } };
    const abc = { ...initial, sources: { text: "abc" } };
    history.record("page-a", canvasSnapshot(initial), canvasSnapshot(a), "typing:text", 0);
    history.record("page-a", canvasSnapshot(a), canvasSnapshot(ab), "typing:text", 100);
    history.record("page-a", canvasSnapshot(ab), canvasSnapshot(abc), "typing:text", 1000);
    expect(history.undo("page-a", canvasSnapshot(abc))).toEqual(canvasSnapshot(ab));
    expect(history.undo("page-a", canvasSnapshot(ab))).toEqual(canvasSnapshot(initial));
  });

  it("preserves remote objects and unrelated fields and skips conflicting fields", () => {
    const history = new CanvasHistory();
    const moved = {
      ...initial,
      elements: moveElements(initial.elements, new Set(["text"]), { x: 10, y: 10 }),
    };
    history.record("page-a", canvasSnapshot(initial), canvasSnapshot(moved));
    const remote = {
      ...moved,
      elements: moved.elements.map((element) =>
        element.id === "text"
          ? { ...element, position: [999, element.position[1]] as const }
          : element,
      ),
      sources: { text: "Remote typing" },
    };
    const undone = history.undo("page-a", canvasSnapshot(remote));
    expect(undone.elements[0]?.position).toEqual([999, 20]);
    expect(undone.sources.text).toBe("Remote typing");
    expect(history.redo("page-a", undone).elements[0]?.position).toEqual([999, 30]);
  });
});

it("records only local deltas when external changes arrive during a long gesture", () => {
  const history = new CanvasHistory();
  const first = {
    ...initial,
    elements: moveElements(initial.elements, new Set(["text"]), { x: 5, y: 0 }),
  };
  history.record("page-a", canvasSnapshot(initial), canvasSnapshot(first), "gesture", 0);
  const external = { ...first, sources: { text: "Remote edit during drag" } };
  const last = {
    ...external,
    elements: moveElements(external.elements, new Set(["text"]), { x: 5, y: 0 }),
  };
  history.record("page-a", canvasSnapshot(external), canvasSnapshot(last), "gesture", 0);
  const undone = history.undo("page-a", canvasSnapshot(last));
  expect(undone.elements).toEqual(initial.elements);
  expect(undone.sources.text).toBe("Remote edit during drag");
  expect(history.canUndo("page-a")).toBe(false);
});

it("rebases a grouped field when another writer changed it between local movements", () => {
  const history = new CanvasHistory();
  const first = {
    ...initial,
    elements: moveElements(initial.elements, new Set(["text"]), { x: 5, y: 0 }),
  };
  history.record("page-a", canvasSnapshot(initial), canvasSnapshot(first), "gesture", 0);
  const external = {
    ...first,
    elements: moveElements(first.elements, new Set(["text"]), { x: 100, y: 0 }),
  };
  const last = {
    ...external,
    elements: moveElements(external.elements, new Set(["text"]), { x: 5, y: 0 }),
  };
  history.record("page-a", canvasSnapshot(external), canvasSnapshot(last), "gesture", 0);
  expect(history.undo("page-a", canvasSnapshot(last)).elements).toEqual(external.elements);
});

describe("session canvas history", () => {
  it("combines page changes with shared style and palette changes", () => {
    const history = new CanvasHistory();
    const customPen = {
      ...canvasInitial.profileDrawingPalettes.pen,
      custom: true,
      slots: canvasInitial.profileDrawingPalettes.pen.slots.map((slot, index) =>
        index === 0 ? { ...slot, color: "#ff0000" } : slot,
      ),
    };
    const next: CanvasHistorySnapshot = {
      ...canvasInitial,
      markdownColorStyles: { styles: [markdownStyle] },
      profileDrawingPalettes: {
        ...canvasInitial.profileDrawingPalettes,
        pen: customPen,
      },
    };

    history.record("page-a", canvasInitial, next);
    expect(history.canUndo("page-b")).toBe(true);
    const undone = history.undo("page-b", next);
    expect(undone.markdownColorStyles).toEqual(canvasInitial.markdownColorStyles);
    expect(undone.profileDrawingPalettes).toEqual(canvasInitial.profileDrawingPalettes);
    expect(undone.elements).toEqual(next.elements);
    expect(history.canRedo("page-b")).toBe(true);
    expect(history.redo("page-b", undone)).toEqual(next);
  });

  it("keeps page edits scoped while shared settings remain available everywhere", () => {
    const history = new CanvasHistory();
    const moved: CanvasHistorySnapshot = {
      ...canvasInitial,
      elements: moveElements(canvasInitial.elements, new Set(["text"]), { x: 10, y: 0 }),
    };

    history.record("page-a", canvasInitial, moved);
    expect(history.canUndo("page-b")).toBe(false);
    expect(history.canUndo("page-a")).toBe(true);
    expect(history.undo("page-b", moved)).toEqual(moved);
    expect(history.undo("page-a", moved)).toEqual(canvasInitial);
  });

  it("restores deleted Markdown styles and their page references atomically", () => {
    const history = new CanvasHistory();
    const styled: CanvasHistorySnapshot = {
      ...canvasInitial,
      elements: canvasInitial.elements.map((element) =>
        element.kind === "markdown" ? { ...element, markdownStyleId: markdownStyle.id } : element,
      ),
      markdownColorStyles: { styles: [markdownStyle] },
    };
    const deleted: CanvasHistorySnapshot = {
      ...canvasInitial,
      elements: styled.elements.map((element) => {
        if (element.kind !== "markdown") return element;
        const { markdownStyleId: _removed, ...original } = element;
        return original;
      }),
    };

    history.record("page-a", styled, deleted);
    expect(history.undo("page-b", deleted)).toEqual(deleted);
    expect(history.undo("page-a", deleted)).toEqual(styled);
  });

  it("coalesces one palette gesture into one undo step", () => {
    const history = new CanvasHistory();
    const first: CanvasHistorySnapshot = {
      ...canvasInitial,
      profileDrawingPalettes: {
        ...canvasInitial.profileDrawingPalettes,
        pen: {
          ...canvasInitial.profileDrawingPalettes.pen,
          slots: canvasInitial.profileDrawingPalettes.pen.slots.map((slot, index) =>
            index === 0 ? { ...slot, color: "#ff0000" } : slot,
          ),
        },
      },
    };
    const second: CanvasHistorySnapshot = {
      ...first,
      profileDrawingPalettes: {
        ...first.profileDrawingPalettes,
        pen: {
          ...first.profileDrawingPalettes.pen,
          slots: first.profileDrawingPalettes.pen.slots.map((slot, index) =>
            index === 0 ? { ...slot, width: slot.width + 1 } : slot,
          ),
        },
      },
    };

    history.record("page-a", canvasInitial, first, "pen-palette-edit", 0);
    history.record("page-a", first, second, "pen-palette-edit", 100);
    expect(history.undo("page-a", second)).toEqual(canvasInitial);
  });
});
