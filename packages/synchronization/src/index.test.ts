import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  createPageDocument,
  materializePageDocument,
  reconcilePageContentById,
  pageRoomId,
  parsePageRoomId,
  replacePageContent,
  updateMarkdownSource,
  type SynchronizedPageContent,
} from "./index";

const PROJECT_ID = "018f1f2e-7c8a-7b1c-8d2e-3f4a5b6c7d8e";
const PAGE_ID = "223e4567-e89b-42d3-a456-426614174001";
const MARKDOWN_ID = "323e4567-e89b-42d3-a456-426614174002";
const SHAPE_ID = "523e4567-e89b-42d3-a456-426614174004";
const IMAGE_ID = "623e4567-e89b-42d3-a456-426614174005";

const initial: SynchronizedPageContent = {
  canvas: [
    {
      id: MARKDOWN_ID,
      kind: "markdown",
      position: [2, 3],
      z: 0,
      width: 320,
      height: 160,
      source: `markdown/${MARKDOWN_ID}.md`,
    },
    {
      id: SHAPE_ID,
      kind: "shape",
      position: [20, 30],
      z: 1,
      geometry: { kind: "rectangle", width: 80, height: 40 },
      style: { strokeColor: "#000000", strokeWidth: 2, fillColor: null, opacity: 1 },
    },
  ],
  markdown: { [MARKDOWN_ID]: "Hello" },
};

describe("page synchronization document", () => {
  it("round-trips canonical page content without leaking Yjs metadata", () => {
    const document = createPageDocument(initial);

    expect(materializePageDocument(document)).toEqual(initial);
    expect(JSON.stringify(materializePageDocument(document))).not.toContain("clientID");
    expect(pageRoomId(PROJECT_ID, PROJECT_ID, PAGE_ID)).toBe(
      `${PROJECT_ID}:${PROJECT_ID}:${PAGE_ID}`,
    );
    expect(parsePageRoomId(`${PROJECT_ID}:${PROJECT_ID}:${PAGE_ID}`)).toEqual({
      generation: PROJECT_ID,
      projectId: PROJECT_ID,
      pageId: PAGE_ID,
    });
    expect(parsePageRoomId(`${PROJECT_ID}:${PAGE_ID}`)).toBeUndefined();
    document.destroy();
  });

  it("round-trips image asset references through the shared page document", () => {
    const image: SynchronizedPageContent = {
      canvas: [
        {
          id: IMAGE_ID,
          kind: "image",
          position: [12, 18],
          z: 0,
          width: 64,
          height: 48,
          asset: `assets/${"a".repeat(64)}.png`,
        },
      ],
      markdown: {},
    };
    const document = createPageDocument(image);

    expect(materializePageDocument(document)).toEqual(image);
    document.destroy();
  });

  it("merges independent edits to different canvas objects without data loss", () => {
    const [left, right] = forkPage(initial);
    const leftPage = materializePageDocument(left);
    replacePageContent(left, {
      ...leftPage,
      canvas: leftPage.canvas.map((record) =>
        record.id === MARKDOWN_ID ? { ...record, position: [12, 13] } : record,
      ),
    });
    const rightPage = materializePageDocument(right);
    replacePageContent(right, {
      ...rightPage,
      canvas: rightPage.canvas.map((record) =>
        record.id === SHAPE_ID ? { ...record, position: [40, 50] } : record,
      ),
    });

    exchange(left, right);

    expect(materializePageDocument(left)).toEqual(materializePageDocument(right));
    expect(materializePageDocument(left).canvas.map((record) => record.position)).toEqual([
      [12, 13],
      [40, 50],
    ]);
    left.destroy();
    right.destroy();
  });

  it("converges concurrent Markdown insertions made by independent clients", () => {
    const [left, right] = forkPage(initial);
    updateMarkdownSource(left, MARKDOWN_ID, "Hello left");
    updateMarkdownSource(right, MARKDOWN_ID, "right Hello");

    exchange(left, right);

    const leftText = materializePageDocument(left).markdown[MARKDOWN_ID];
    expect(leftText).toBe(materializePageDocument(right).markdown[MARKDOWN_ID]);
    expect(leftText).toContain("left");
    expect(leftText).toContain("right");
    left.destroy();
    right.destroy();
  });

  it("reconciles external canonical IDs without replacing unrelated local edits", () => {
    const document = createPageDocument(initial);
    const local = materializePageDocument(document);
    replacePageContent(document, {
      ...local,
      canvas: local.canvas.map((record) =>
        record.id === SHAPE_ID ? { ...record, position: [90, 91] } : record,
      ),
    });
    reconcilePageContentById(document, initial, {
      ...initial,
      markdown: { [MARKDOWN_ID]: "Edited outside" },
    });

    const reconciled = materializePageDocument(document);
    expect(reconciled.markdown[MARKDOWN_ID]).toBe("Edited outside");
    expect(reconciled.canvas.find((record) => record.id === SHAPE_ID)?.position).toEqual([90, 91]);
    document.destroy();
  });
});

function forkPage(content: SynchronizedPageContent): [Y.Doc, Y.Doc] {
  const left = createPageDocument(content);
  const right = new Y.Doc();
  Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
  return [left, right];
}

function exchange(left: Y.Doc, right: Y.Doc): void {
  const leftVector = Y.encodeStateVector(left);
  const rightVector = Y.encodeStateVector(right);
  const leftUpdate = Y.encodeStateAsUpdate(left, rightVector);
  const rightUpdate = Y.encodeStateAsUpdate(right, leftVector);
  Y.applyUpdate(left, rightUpdate);
  Y.applyUpdate(right, leftUpdate);
}
