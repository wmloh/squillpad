import { describe, expect, it } from "vitest";

import type { NotebookSettings } from "./canonical-format.js";
import {
  AUTOSAVE_INTERVAL_SECONDS_METADATA_KEY,
  LASER_POINTER_SETTINGS_METADATA_KEY,
  MARKDOWN_BOX_APPEARANCE_METADATA_KEY,
  MARKDOWN_COLOR_KEYS,
  MARKDOWN_COLOR_STYLES_METADATA_KEY,
  withMarkdownColorStyles,
  type MarkdownColorStyle,
} from "./project-preferences.js";
import {
  createProjectSettingsExport,
  isProjectSettingsExport,
  mergeMarkdownColorStyleLibraries,
  mergePortableProjectSettings,
  serializeProjectSettingsExport,
} from "./project-settings.js";

const FIRST_ID = "123e4567-e89b-42d3-a456-426614174000";
const SECOND_ID = "223e4567-e89b-42d3-a456-426614174001";
const IMPORTED_ID = "323e4567-e89b-42d3-a456-426614174002";

function style(id: string, name: string, color: string): MarkdownColorStyle {
  return {
    id,
    name,
    colors: Object.fromEntries(
      MARKDOWN_COLOR_KEYS.map((key) => [key, { light: color, dark: color }]),
    ) as MarkdownColorStyle["colors"],
  };
}

describe("project settings export", () => {
  it("exports known notebook preferences without arbitrary metadata or hierarchy data", () => {
    const settings: NotebookSettings = {
      defaultZoom: 1.25,
      metadata: {
        future: { privateToThisProject: true },
        [MARKDOWN_BOX_APPEARANCE_METADATA_KEY]: { opacity: 0.6, fontSize: 19 },
        [LASER_POINTER_SETTINGS_METADATA_KEY]: { decaySeconds: 2.5 },
        [AUTOSAVE_INTERVAL_SECONDS_METADATA_KEY]: 120,
      },
    };

    const exported = createProjectSettingsExport(settings);

    expect(isProjectSettingsExport(exported)).toBe(true);
    expect(exported.settings).toMatchObject({
      defaultZoom: 1.25,
      markdownBoxAppearance: { opacity: 0.6, fontSize: 19 },
      laserPointerSettings: { decaySeconds: 2.5 },
      autosaveIntervalSeconds: 120,
    });
    expect(exported).not.toHaveProperty("title");
    expect(JSON.stringify(exported)).not.toContain("privateToThisProject");
    expect(JSON.parse(serializeProjectSettingsExport(settings))).toEqual(exported);
  });

  it("rejects hierarchy fields and malformed setting values", () => {
    const base = createProjectSettingsExport({ defaultZoom: 1, metadata: {} });

    expect(isProjectSettingsExport({ ...base, title: "Project A" })).toBe(false);
    expect(
      isProjectSettingsExport({
        ...base,
        settings: { ...base.settings, autosaveIntervalSeconds: 17 },
      }),
    ).toBe(false);
  });

  it("applies included scalar settings while preserving omitted and unknown metadata", () => {
    const current: NotebookSettings = {
      defaultZoom: 1,
      metadata: {
        retained: "yes",
        [MARKDOWN_BOX_APPEARANCE_METADATA_KEY]: { opacity: 0.3, fontSize: 16 },
        [LASER_POINTER_SETTINGS_METADATA_KEY]: { decaySeconds: 1.4 },
      },
    };

    const merged = mergePortableProjectSettings(current, {
      defaultZoom: 1.5,
      laserPointerSettings: { decaySeconds: 3.2 },
    });

    expect(merged.defaultZoom).toBe(1.5);
    expect(merged.metadata.retained).toBe("yes");
    expect(merged.metadata[MARKDOWN_BOX_APPEARANCE_METADATA_KEY]).toEqual({
      opacity: 0.3,
      fontSize: 16,
    });
    expect(merged.metadata[LASER_POINTER_SETTINGS_METADATA_KEY]).toEqual({ decaySeconds: 3.2 });
  });

  it("merges styles by name then ID, with imported colors and default winning", () => {
    const current = {
      defaultStyleId: SECOND_ID,
      styles: [style(FIRST_ID, "Shared", "#111111"), style(SECOND_ID, "Local", "#222222")],
    };
    const imported = {
      defaultStyleId: IMPORTED_ID,
      styles: [
        style(IMPORTED_ID, "Shared", "#abcdef"),
        style(SECOND_ID, "Renamed local", "#fedcba"),
      ],
    };

    const merged = mergeMarkdownColorStyleLibraries(current, imported);

    expect(merged.defaultStyleId).toBe(FIRST_ID);
    expect(merged.styles).toEqual([
      style(FIRST_ID, "Shared", "#abcdef"),
      style(SECOND_ID, "Renamed local", "#fedcba"),
    ]);
  });

  it("rejects an ambiguous style collision instead of silently losing an imported style", () => {
    const current = { styles: [style(FIRST_ID, "Shared", "#111111")] };
    const imported = {
      styles: [
        style(IMPORTED_ID, "Shared", "#abcdef"),
        style(FIRST_ID, "Different", "#fedcba"),
      ],
    };

    expect(() => mergeMarkdownColorStyleLibraries(current, imported)).toThrow(
      "ambiguous name and ID collision",
    );
  });

  it("stores a merged style library without disturbing other project metadata", () => {
    const current: NotebookSettings = {
      defaultZoom: 1,
      metadata: withMarkdownColorStyles(
        { retained: true },
        {
          styles: [style(FIRST_ID, "Shared", "#111111")],
        },
      ),
    };

    const merged = mergePortableProjectSettings(current, {
      markdownColorStyles: {
        styles: [style(IMPORTED_ID, "Shared", "#abcdef")],
      },
    });

    expect(merged.metadata.retained).toBe(true);
    expect(merged.metadata[MARKDOWN_COLOR_STYLES_METADATA_KEY]).toEqual({
      styles: [style(FIRST_ID, "Shared", "#abcdef")],
    });
  });
});
