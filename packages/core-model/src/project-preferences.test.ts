import { describe, expect, it } from "vitest";

import {
  AUTOSAVE_INTERVAL_SECONDS,
  DEFAULT_AUTOSAVE_INTERVAL_SECONDS,
  DEFAULT_MARKDOWN_CODE_BACKGROUND_COLORS,
  DEFAULT_LASER_POINTER_SETTINGS,
  DEFAULT_MARKDOWN_BOX_APPEARANCE,
  DEFAULT_MARKDOWN_FONT_SIZE,
  MARKDOWN_COLOR_KEYS,
  type MarkdownColors,
  LASER_POINTER_DECAY_MAX_SECONDS,
  LASER_POINTER_DECAY_MIN_SECONDS,
  isLaserPointerSettings,
  isMarkdownBoxAppearance,
  isMarkdownColorStyleLibrary,
  isSynchronizedInkColors,
  MARKDOWN_BOX_APPEARANCE_METADATA_KEY,
  SECTION_COLOR_METADATA_KEY,
  isAutosaveIntervalSeconds,
  isSectionColor,
  readAutosaveIntervalSeconds,
  readLanSharingDefault,
  readLaserPointerSettings,
  readMarkdownBoxAppearance,
  readMarkdownColorStyles,
  readSectionColor,
  readSynchronizedInkColors,
  withLaserPointerSettings,
  withAutosaveIntervalSeconds,
  withLanSharingDefault,
  withMarkdownBoxAppearance,
  withMarkdownColorStyles,
  withSectionColor,
  withSynchronizedInkColors,
} from "./project-preferences";

describe("project preferences", () => {
  it("round-trips project sharing and autosave defaults", () => {
    const withSharing = withLanSharingDefault({ retained: true }, false);
    const metadata = withAutosaveIntervalSeconds(withSharing, 300);

    expect(readLanSharingDefault(metadata)).toBe(false);
    expect(readAutosaveIntervalSeconds(metadata)).toBe(300);
    expect(metadata.retained).toBe(true);
    expect(DEFAULT_AUTOSAVE_INTERVAL_SECONDS).toBe(30);
    expect(isAutosaveIntervalSeconds(0)).toBe(true);
    expect(isAutosaveIntervalSeconds(11)).toBe(false);
    expect(AUTOSAVE_INTERVAL_SECONDS).toEqual([0, 10, 30, 60, 120, 300]);
  });

  it("round-trips synchronized ink colors without dropping metadata", () => {
    const metadata = withSynchronizedInkColors(
      { existing: { retained: true } },
      { pen: "#60a5fa", highlighter: "#c4b5fd" },
    );

    expect(readSynchronizedInkColors(metadata)).toEqual({
      pen: "#60a5fa",
      highlighter: "#c4b5fd",
    });
    expect(metadata.existing).toEqual({ retained: true });
  });

  it("round-trips and clears an optional section color without dropping metadata", () => {
    const metadata = withSectionColor({ existing: "yes" }, "#ef4444");

    expect(readSectionColor(metadata)).toBe("#ef4444");
    expect(metadata[SECTION_COLOR_METADATA_KEY]).toBe("#ef4444");
    expect(metadata.existing).toBe("yes");
    expect(withSectionColor(metadata, undefined)).toEqual({ existing: "yes" });
    expect(isSectionColor("#60a5fa")).toBe(true);
    expect(isSectionColor("blue")).toBe(false);
    expect(readSectionColor({ [SECTION_COLOR_METADATA_KEY]: "blue" })).toBeUndefined();
  });

  it("rejects malformed synchronized ink colors", () => {
    expect(isSynchronizedInkColors({ pen: "blue", highlighter: "#60a5fa" })).toBe(false);
    expect(readSynchronizedInkColors({})).toBeUndefined();
  });

  it("round-trips project-wide Markdown appearance", () => {
    expect(DEFAULT_MARKDOWN_BOX_APPEARANCE).toEqual({ opacity: 0.4, fontSize: 16 });

    const metadata = withMarkdownBoxAppearance({ existing: "yes" }, { opacity: 0, fontSize: 22 });

    expect(readMarkdownBoxAppearance(metadata)).toEqual({ opacity: 0, fontSize: 22 });
    expect(metadata.existing).toBe("yes");
    expect(isMarkdownBoxAppearance({ opacity: 0.5 })).toBe(true);
    expect(
      readMarkdownBoxAppearance({ [MARKDOWN_BOX_APPEARANCE_METADATA_KEY]: { opacity: 0.5 } }),
    ).toEqual({
      opacity: 0.5,
      fontSize: DEFAULT_MARKDOWN_FONT_SIZE,
    });
    expect(isMarkdownBoxAppearance({ opacity: 2 })).toBe(false);
    expect(readMarkdownBoxAppearance({})).toBeUndefined();
  });

  it("round-trips validated Markdown color styles", () => {
    const id = "323e4567-e89b-42d3-a456-426614174002";
    const colors = Object.fromEntries(
      MARKDOWN_COLOR_KEYS.map((key) => [key, { light: "#123456", dark: "#654321" }]),
    ) as MarkdownColors;
    const library = { defaultStyleId: id, styles: [{ id, name: "Lecture", colors }] };
    const metadata = withMarkdownColorStyles({ retained: true }, library);

    expect(readMarkdownColorStyles(metadata)).toEqual(library);
    expect(metadata.retained).toBe(true);
    expect(isMarkdownColorStyleLibrary(library)).toBe(true);
    expect(
      isMarkdownColorStyleLibrary({
        ...library,
        defaultStyleId: "423e4567-e89b-42d3-a456-426614174003",
      }),
    ).toBe(false);
  });

  it("migrates legacy single-color Markdown styles and removes inherited elements", () => {
    const id = "323e4567-e89b-42d3-a456-426614174002";
    const legacyKeys = [
      ...MARKDOWN_COLOR_KEYS,
      "strikethrough",
      "orderedList",
      "unorderedList",
      "table",
      "highlightText",
    ];
    const legacyColors = Object.fromEntries(legacyKeys.map((key) => [key, "#123456"]));
    const migrated = readMarkdownColorStyles({
      ["squillpad:markdown-color-styles"]: {
        styles: [{ id, name: "Legacy", colors: legacyColors }],
      },
    });

    expect(migrated).toEqual({
      styles: [
        {
          id,
          name: "Legacy",
          colors: Object.fromEntries(
            MARKDOWN_COLOR_KEYS.map((key) => [
              key,
              { light: "#123456", dark: "#123456" },
            ]),
          ),
        },
      ],
    });
    expect(
      isMarkdownColorStyleLibrary({ styles: [{ id, name: "Legacy", colors: legacyColors }] }),
    ).toBe(false);
  });

  it("adds the code background when migrating previous named Markdown styles", () => {
    const id = "323e4567-e89b-42d3-a456-426614174002";
    const previousColors = Object.fromEntries(
      MARKDOWN_COLOR_KEYS.filter((key) => key !== "codeBackground").map((key) => [
        key,
        { light: "#123456", dark: "#654321" },
      ]),
    );

    expect(
      readMarkdownColorStyles({
        ["squillpad:markdown-color-styles"]: {
          styles: [{ id, name: "Previous", colors: previousColors }],
        },
      }),
    ).toEqual({
      styles: [
        {
          id,
          name: "Previous",
          colors: {
            ...previousColors,
            codeBackground: DEFAULT_MARKDOWN_CODE_BACKGROUND_COLORS,
          },
        },
      ],
    });
  });

  it("round-trips project-wide laser pointer decay settings", () => {
    const metadata = withLaserPointerSettings({ existing: "yes" }, { decaySeconds: 2.7 });

    expect(readLaserPointerSettings(metadata)).toEqual({ decaySeconds: 2.7 });
    expect(metadata.existing).toBe("yes");
    expect(readLaserPointerSettings({})).toBeUndefined();
  });

  it("rejects laser pointer decay settings outside the slider range", () => {
    expect(isLaserPointerSettings(DEFAULT_LASER_POINTER_SETTINGS)).toBe(true);
    expect(isLaserPointerSettings({ decaySeconds: LASER_POINTER_DECAY_MIN_SECONDS })).toBe(true);
    expect(isLaserPointerSettings({ decaySeconds: LASER_POINTER_DECAY_MAX_SECONDS })).toBe(true);
    expect(isLaserPointerSettings({ decaySeconds: 0 })).toBe(false);
    expect(isLaserPointerSettings({ decaySeconds: 5.1 })).toBe(false);
  });
});
