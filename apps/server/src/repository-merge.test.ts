import { describe, expect, it } from "vitest";

import { serializeCanvasJsonLines, type CanvasRecord } from "@squillpad/core-model";

import { mergeCanonicalFiles, mergeCanonicalFilesWithGitHubBase } from "./repository-merge.js";

const LINE_ID = "323e4567-e89b-42d3-a456-426614174002";
const MARKDOWN_ID = "423e4567-e89b-42d3-a456-426614174003";
const CANVAS_PATH =
  "sections/123e4567-e89b-42d3-a456-426614174001/pages/223e4567-e89b-42d3-a456-426614174004/canvas.jsonl";
const MARKDOWN_PATH = `sections/123e4567-e89b-42d3-a456-426614174001/pages/223e4567-e89b-42d3-a456-426614174004/markdown/${MARKDOWN_ID}.md`;

describe("canonical repository merge", () => {
  it("combines independently added canvas records and Markdown files", () => {
    const line: CanvasRecord = {
      id: LINE_ID,
      kind: "shape",
      position: [20, 30],
      z: 0,
      geometry: { kind: "line", start: [0, 0], end: [100, 80] },
      style: { strokeColor: "#111111", strokeWidth: 2, fillColor: null, opacity: 1 },
    };
    const markdown: CanvasRecord = {
      id: MARKDOWN_ID,
      kind: "markdown",
      position: [180, 120],
      z: 1,
      width: 320,
      height: 160,
      source: `markdown/${MARKDOWN_ID}.md`,
    };
    const base = new Map<string, Buffer>([[CANVAS_PATH, Buffer.from("")]]);
    const local = new Map<string, Buffer>([
      [CANVAS_PATH, Buffer.from(serializeCanvasJsonLines([line]))],
    ]);
    const remote = new Map<string, Buffer>([
      [CANVAS_PATH, Buffer.from(serializeCanvasJsonLines([markdown]))],
      [MARKDOWN_PATH, Buffer.from("# Remote text\n")],
    ]);

    const result = mergeCanonicalFiles(base, local, remote);

    expect(result.conflicts).toEqual([]);
    expect(result.files.get(MARKDOWN_PATH)?.toString()).toBe("# Remote text\n");
    expect(result.files.get(CANVAS_PATH)?.toString()).toBe(
      serializeCanvasJsonLines([line, markdown]),
    );
  });

  it("reports a same-field change instead of silently selecting a winner", () => {
    const base = Buffer.from(JSON.stringify({ schemaVersion: 1, title: "Base", metadata: {} }));
    const local = Buffer.from(JSON.stringify({ schemaVersion: 1, title: "Local", metadata: {} }));
    const remote = Buffer.from(JSON.stringify({ schemaVersion: 1, title: "Remote", metadata: {} }));

    const result = mergeCanonicalFiles(
      new Map([["page.json", base]]),
      new Map([["page.json", local]]),
      new Map([["page.json", remote]]),
    );

    expect(result.conflicts).toMatchObject([
      { kind: "canonical-field", path: "page.json.title", editable: false },
    ]);
    expect(result.files.get("page.json")?.toString()).toContain('"title": "Local"');
  });

  it("does not label delete-versus-edit canvas files as visually editable", () => {
    const base = Buffer.from(serializeCanvasJsonLines([]));
    const remote = Buffer.from(
      serializeCanvasJsonLines([
        {
          id: LINE_ID,
          kind: "shape",
          position: [20, 30],
          z: 0,
          geometry: { kind: "line", start: [0, 0], end: [100, 80] },
          style: { strokeColor: "#111111", strokeWidth: 2, fillColor: null, opacity: 1 },
        },
      ]),
    );

    const result = mergeCanonicalFiles(
      new Map([[CANVAS_PATH, base]]),
      new Map(),
      new Map([[CANVAS_PATH, remote]]),
    );

    expect(result.conflicts).toMatchObject([
      { kind: "canonical-file", path: CANVAS_PATH, editable: false },
    ]);
  });

  it("preserves local-only section metadata when combining with a GitHub base", () => {
    const sectionPath = "sections/123e4567-e89b-42d3-a456-426614174001/section.json";
    const local = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        id: "123e4567-e89b-42d3-a456-426614174001",
        title: "Local section",
        pageIds: ["223e4567-e89b-42d3-a456-426614174004"],
        metadata: { "squillpad:section-color": "#ef4444" },
      }),
    );
    const remote = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        id: "123e4567-e89b-42d3-a456-426614174001",
        title: "Remote section",
        pageIds: ["323e4567-e89b-42d3-a456-426614174002"],
        metadata: { "remote-setting": true },
      }),
    );

    const result = mergeCanonicalFilesWithGitHubBase(
      new Map([[sectionPath, local]]),
      new Map([[sectionPath, remote]]),
    );

    expect(result.conflicts).toEqual([]);
    expect(JSON.parse(result.files.get(sectionPath)!.toString("utf8"))).toMatchObject({
      title: "Remote section",
      pageIds: [
        "323e4567-e89b-42d3-a456-426614174002",
        "223e4567-e89b-42d3-a456-426614174004",
      ],
      metadata: {
        "remote-setting": true,
        "squillpad:section-color": "#ef4444",
      },
    });
  });
});
