import { describe, expect, it } from "vitest";

import type { CanvasElement } from "@squillpad/core-model";

import { exportPageToSvg, readMarkdownFile } from "./visual-export";

const MARKDOWN_ID = "323e4567-e89b-42d3-a456-426614174002";
const INK_ID = "423e4567-e89b-42d3-a456-426614174003";
const SHAPE_ID = "523e4567-e89b-42d3-a456-426614174004";
const IMAGE_ID = "623e4567-e89b-42d3-a456-426614174005";
const TEXT_GROUP_ID = "723e4567-e89b-42d3-a456-426614174006";

const page: readonly CanvasElement[] = [
  {
    kind: "markdown",
    id: MARKDOWN_ID,
    position: [-20, 10],
    z: 0,
    width: 180,
    height: 100,
    source: `markdown/${MARKDOWN_ID}.md`,
  },
  {
    kind: "ink",
    id: INK_ID,
    position: [200, 40],
    z: 1,
    points: [
      [0, 0],
      [40, 20],
    ],
    style: { color: "#38245f", width: 4, opacity: 1, highlighter: false },
  },
  {
    kind: "shape",
    id: SHAPE_ID,
    position: [80, 150],
    z: 2,
    geometry: { kind: "rectangle", width: 120, height: 60 },
    style: { strokeColor: "#176b45", strokeWidth: 3, fillColor: "#d9cff0", opacity: 1 },
  },
];

describe("visual export", () => {
  it("exports mixed Markdown, vector ink, and shapes with content dimensions", () => {
    const source = "# Exported\n\n$\\alpha^2$";
    const exported = exportPageToSvg({
      elements: page,
      markdownSources: { [MARKDOWN_ID]: source },
    });

    expect(exported.bounds).toEqual({ x: -36, y: -6, width: 294, height: 232 });
    expect(exported.width).toBe(294);
    expect(exported.height).toBe(232);
    expect(exported.svg).toContain("<foreignObject");
    expect(exported.svg).toContain("# Exported");
    expect(exported.svg).toContain("M ");
    expect(exported.svg).toContain('fill="#38245f"');
    expect(exported.svg).toContain("#d9cff0");
  });

  it("uses rendered Markdown HTML when available and respects an explicit region", () => {
    const before = structuredClone(page);
    const exported = exportPageToSvg({
      elements: page,
      markdownSources: { [MARKDOWN_ID]: "source $x$" },
      markdownHtml: {
        [MARKDOWN_ID]: '<h1>Rendered</h1><span class="katex">x</span><br><img src="asset.png">',
      },
      selectedIds: new Set([MARKDOWN_ID]),
      region: { x: -20, y: 10, width: 180, height: 100 },
      background: null,
    });

    expect(exported.width).toBe(180);
    expect(exported.height).toBe(100);
    expect(exported.svg).toContain('<foreignObject x="0" y="0"');
    expect(exported.svg).toContain('<g transform="scale(1)">');
    expect(exported.svg).toContain("Rendered");
    expect(exported.svg).toContain('class="katex"');
    expect(exported.svg).toContain("<br />");
    expect(exported.svg).toContain('<img src="asset.png" />');
    expect(exported.svg).not.toContain('<rect width="100%"');
    expect(page).toEqual(before);
  });

  it("applies the configured Markdown font size to rendered exports", () => {
    const exported = exportPageToSvg({
      elements: page.slice(0, 1),
      markdownSources: { [MARKDOWN_ID]: "Configured size" },
      markdownFontSize: 22,
    });

    expect(exported.svg).toContain("font:22px/1.45");
  });

  it("exports the subtle text-box group frame behind grouped Markdown", () => {
    const grouped = page.map((element) =>
      element.kind === "markdown" ? { ...element, textGroupId: TEXT_GROUP_ID } : element,
    );
    const exported = exportPageToSvg({ elements: grouped, theme: "dark" });

    expect(exported.svg).toContain(`id="text-group-${TEXT_GROUP_ID}"`);
    expect(exported.svg).toContain('fill="none"');
    expect(exported.svg).toContain("#b6e0c5");
    expect(exported.svg.indexOf(`id="text-group-${TEXT_GROUP_ID}"`)).toBeLessThan(
      exported.svg.indexOf("<foreignObject"),
    );
  });

  it("exports resolved image assets at their world-space bounds", () => {
    const source = "data:image/png;base64,AAAA";
    const exported = exportPageToSvg({
      elements: [
        {
          kind: "image",
          id: IMAGE_ID,
          position: [20, 30],
          z: 0,
          width: 120,
          height: 80,
          asset: `assets/${"a".repeat(64)}.png`,
        },
      ],
      imageSources: { [`assets/${"a".repeat(64)}.png`]: source },
      background: null,
    });

    expect(exported.bounds).toEqual({ x: 4, y: 14, width: 152, height: 112 });
    expect(exported.svg).toContain(`<image x="16" y="16" width="120" height="80" href="${source}"`);
  });

  it("falls back to readable source for off-screen Markdown blocks", () => {
    const exported = exportPageToSvg({
      elements: page.slice(0, 1),
      markdownSources: { [MARKDOWN_ID]: "![asset](assets/image.png)\n\n$$x^2$$" },
    });

    expect(exported.svg).toContain("assets/image.png");
    expect(exported.svg).toContain("$$x^2$$");
  });

  it("uses the dark theme for standalone SVG and PNG source scenes", () => {
    const exported = exportPageToSvg({
      elements: page.slice(0, 1),
      markdownSources: { [MARKDOWN_ID]: "Dark export" },
      theme: "dark",
    });

    expect(exported.svg).toContain('fill="#080909"');
    expect(exported.svg).toContain("background:#222322");
    expect(exported.svg).toContain("color:#eceeea");
    expect(exported.svg).not.toContain("background:#fff;color:#27252b");
  });

  it("reads an imported Markdown file without rewriting its source", async () => {
    const source = "# Exact source\r\n\r\n![asset](assets/diagram.svg)\r\n";
    const imported = await readMarkdownFile({
      name: "note.md",
      text: () => Promise.resolve(source),
    });
    expect(imported).toBe(source);
  });
});
