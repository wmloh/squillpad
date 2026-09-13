import { describe, expect, it } from "vitest";
import { decodeClipboard, encodeClipboard, readClipboardImage } from "./canvas-clipboard";
import type { PageSnapshot } from "./canvas-history";

const id = "323e4567-e89b-42d3-a456-426614174002";
const snapshot: PageSnapshot = {
  elements: [
    {
      id,
      kind: "markdown",
      position: [-25, 40],
      width: 300,
      height: 72,
      z: 0,
      source: `markdown/${id}.md`,
    },
  ],
  sources: { [id]: "# Portable $x^2$" },
};
const imageSnapshot: PageSnapshot = {
  elements: [
    {
      id: "423e4567-e89b-42d3-a456-426614174003",
      kind: "image",
      position: [12, 18],
      width: 64,
      height: 48,
      z: 0,
      asset: `assets/${"a".repeat(64)}.png`,
    },
  ],
  sources: {},
  imageData: { "423e4567-e89b-42d3-a456-426614174003": "data:image/png;base64,AAAA" },
};
describe("canvas clipboard", () => {
  it("round trips canonical objects and exact Markdown", () => {
    expect(decodeClipboard(encodeClipboard(snapshot))).toEqual(snapshot);
  });
  it("round trips image objects and transient image bytes without Markdown sources", () => {
    expect(decodeClipboard(encodeClipboard(imageSnapshot))).toEqual(imageSnapshot);
  });
  it("ignores plain text, malformed records and missing sources", () => {
    for (const text of [
      "hello",
      "null",
      "{}",
      encodeClipboard({ ...snapshot, sources: {} }),
      encodeClipboard({ ...snapshot, elements: [{ ...snapshot.elements[0]!, id: "invalid" }] }),
    ]) {
      expect(decodeClipboard(text)).toBeUndefined();
    }
  });
  it("rejects oversized GIFs without stripping their animation", async () => {
    const oversized = new Blob([new Uint8Array(25 * 1024 * 1024 + 1)], { type: "image/gif" });
    await expect(readClipboardImage(oversized)).rejects.toThrow(
      "Animated GIF exceeds the 25 MiB limit",
    );
  });
});
