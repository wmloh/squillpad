import type { CanonicalMetadata } from "./canonical-format.js";

export const SYNCHRONIZED_INK_COLORS_METADATA_KEY = "squillpad:ink-colors";
export const MARKDOWN_BOX_APPEARANCE_METADATA_KEY = "squillpad:markdown-box-appearance";
export const MARKDOWN_COLOR_STYLES_METADATA_KEY = "squillpad:markdown-color-styles";
export const LASER_POINTER_SETTINGS_METADATA_KEY = "squillpad:laser-pointer-settings";
export const LAN_SHARING_DEFAULT_METADATA_KEY = "squillpad:lan-sharing-default";
export const AUTOSAVE_INTERVAL_SECONDS_METADATA_KEY = "squillpad:autosave-interval-seconds";
export const SECTION_COLOR_METADATA_KEY = "squillpad:section-color";

export const LASER_POINTER_DECAY_MIN_SECONDS = 0.5;
export const LASER_POINTER_DECAY_MAX_SECONDS = 5;
export const LASER_POINTER_DECAY_STEP_SECONDS = 0.1;
export const MARKDOWN_FONT_SIZE_MIN = 10;
export const MARKDOWN_FONT_SIZE_MAX = 32;
export const MARKDOWN_FONT_SIZE_STEP = 1;
export const DEFAULT_MARKDOWN_FONT_SIZE = 16;
export const AUTOSAVE_INTERVAL_SECONDS = [0, 10, 30, 60, 120, 300] as const;
export type AutosaveIntervalSeconds = (typeof AUTOSAVE_INTERVAL_SECONDS)[number];
export const DEFAULT_AUTOSAVE_INTERVAL_SECONDS: AutosaveIntervalSeconds = 30;
export const DEFAULT_LAN_SHARING_ENABLED = true;

export interface SynchronizedInkColors {
  readonly pen: string;
  readonly highlighter: string;
}

export interface MarkdownBoxAppearance {
  readonly opacity: number;
  readonly fontSize: number;
}

export interface MarkdownBoxAppearanceInput {
  readonly opacity: number;
  readonly fontSize?: number;
}

export const MARKDOWN_COLOR_KEYS = [
  "text",
  "heading1",
  "heading2",
  "heading3",
  "heading4",
  "heading5",
  "heading6",
  "bold",
  "italic",
  "link",
  "inlineCode",
  "codeBlock",
  "codeBackground",
  "blockquote",
  "math",
  "footnote",
  "highlightBackground",
] as const;
const PREVIOUS_MARKDOWN_COLOR_KEYS = [
  "text",
  "heading1",
  "heading2",
  "heading3",
  "heading4",
  "heading5",
  "heading6",
  "bold",
  "italic",
  "link",
  "inlineCode",
  "codeBlock",
  "blockquote",
  "math",
  "footnote",
  "highlightBackground",
] as const;
const LEGACY_MARKDOWN_COLOR_KEYS = [
  ...MARKDOWN_COLOR_KEYS,
  "strikethrough",
  "orderedList",
  "unorderedList",
  "table",
  "highlightText",
] as const;
const PREVIOUS_LEGACY_MARKDOWN_COLOR_KEYS = [
  ...PREVIOUS_MARKDOWN_COLOR_KEYS,
  "strikethrough",
  "orderedList",
  "unorderedList",
  "table",
  "highlightText",
] as const;
export type MarkdownColorKey = (typeof MARKDOWN_COLOR_KEYS)[number];

export type MarkdownColorPair = Readonly<Record<"light" | "dark", string>>;
export type MarkdownColors = Readonly<Record<MarkdownColorKey, MarkdownColorPair>>;

export const DEFAULT_MARKDOWN_CODE_BACKGROUND_COLORS: MarkdownColorPair = {
  light: "#f2eff6",
  dark: "#282b29",
};

export interface MarkdownColorStyle {
  readonly id: string;
  readonly name: string;
  readonly colors: MarkdownColors;
}

export interface MarkdownColorStyleLibrary {
  readonly defaultStyleId?: string;
  readonly styles: readonly MarkdownColorStyle[];
}

export const EMPTY_MARKDOWN_COLOR_STYLE_LIBRARY: MarkdownColorStyleLibrary = { styles: [] };

export interface LaserPointerSettings {
  readonly decaySeconds: number;
}

export const DEFAULT_MARKDOWN_BOX_APPEARANCE: MarkdownBoxAppearance = {
  opacity: 0.4,
  fontSize: DEFAULT_MARKDOWN_FONT_SIZE,
};
export const DEFAULT_LASER_POINTER_SETTINGS: LaserPointerSettings = { decaySeconds: 1.4 };

/** Reads the project default for LAN sharing from notebook metadata. */
export function readLanSharingDefault(metadata: CanonicalMetadata): boolean | undefined {
  const value = metadata[LAN_SHARING_DEFAULT_METADATA_KEY];
  return typeof value === "boolean" ? value : undefined;
}

/** Returns notebook metadata with the project LAN-sharing default updated. */
export function withLanSharingDefault(
  metadata: CanonicalMetadata,
  enabled: boolean,
): CanonicalMetadata {
  if (typeof enabled !== "boolean") throw new Error("LAN sharing default must be a boolean");
  return { ...metadata, [LAN_SHARING_DEFAULT_METADATA_KEY]: enabled };
}

/** Reads the validated disabled-mode autosave interval from notebook metadata. */
export function readAutosaveIntervalSeconds(
  metadata: CanonicalMetadata,
): AutosaveIntervalSeconds | undefined {
  const value = metadata[AUTOSAVE_INTERVAL_SECONDS_METADATA_KEY];
  return isAutosaveIntervalSeconds(value) ? value : undefined;
}

/** Returns notebook metadata with the disabled-mode autosave interval updated. */
export function withAutosaveIntervalSeconds(
  metadata: CanonicalMetadata,
  seconds: AutosaveIntervalSeconds,
): CanonicalMetadata {
  if (!isAutosaveIntervalSeconds(seconds)) {
    throw new Error("Autosave interval must be one of the supported project intervals");
  }
  return { ...metadata, [AUTOSAVE_INTERVAL_SECONDS_METADATA_KEY]: seconds };
}

/** Checks whether a value is one of the supported autosave intervals. */
export function isAutosaveIntervalSeconds(value: unknown): value is AutosaveIntervalSeconds {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    (AUTOSAVE_INTERVAL_SECONDS as readonly number[]).includes(value)
  );
}

/** Reads validated project-wide ink colors from notebook metadata. */
export function readSynchronizedInkColors(
  metadata: CanonicalMetadata,
): SynchronizedInkColors | undefined {
  const value = metadata[SYNCHRONIZED_INK_COLORS_METADATA_KEY];
  return isSynchronizedInkColors(value) ? value : undefined;
}

/** Returns notebook metadata with the project-wide ink colors updated. */
export function withSynchronizedInkColors(
  metadata: CanonicalMetadata,
  colors: SynchronizedInkColors,
): CanonicalMetadata {
  if (!isSynchronizedInkColors(colors)) {
    throw new Error("Synchronized ink colors must be six-digit hexadecimal colors");
  }
  return {
    ...metadata,
    [SYNCHRONIZED_INK_COLORS_METADATA_KEY]: {
      pen: colors.pen,
      highlighter: colors.highlighter,
    },
  };
}

/** Checks the persisted ink color shape without coercing user input. */
export function isSynchronizedInkColors(value: unknown): value is SynchronizedInkColors {
  return isRecord(value) && isHexColor(value.pen) && isHexColor(value.highlighter);
}

/** Reads a validated optional color assigned to one section. */
export function readSectionColor(metadata: CanonicalMetadata): string | undefined {
  const value = metadata[SECTION_COLOR_METADATA_KEY];
  return isHexColor(value) ? value : undefined;
}

/** Returns section metadata with its optional color assigned or cleared. */
export function withSectionColor(
  metadata: CanonicalMetadata,
  color: string | undefined,
): CanonicalMetadata {
  if (color !== undefined && !isHexColor(color)) {
    throw new Error("Section color must be a six-digit hexadecimal color");
  }
  if (color === undefined) {
    const { [SECTION_COLOR_METADATA_KEY]: _removed, ...remaining } = metadata;
    return remaining;
  }
  return { ...metadata, [SECTION_COLOR_METADATA_KEY]: color };
}

/** Checks whether a value is a valid six-digit hexadecimal section color. */
export function isSectionColor(value: unknown): value is string {
  return isHexColor(value);
}

/** Reads the project-wide Markdown box appearance from notebook metadata. */
export function readMarkdownBoxAppearance(
  metadata: CanonicalMetadata,
): MarkdownBoxAppearance | undefined {
  const value = metadata[MARKDOWN_BOX_APPEARANCE_METADATA_KEY];
  if (!isMarkdownBoxAppearance(value)) return undefined;
  return {
    opacity: value.opacity,
    fontSize: value.fontSize ?? DEFAULT_MARKDOWN_FONT_SIZE,
  };
}

/** Returns notebook metadata with the project-wide Markdown appearance updated. */
export function withMarkdownBoxAppearance(
  metadata: CanonicalMetadata,
  appearance: MarkdownBoxAppearanceInput,
): CanonicalMetadata {
  if (!isMarkdownBoxAppearance(appearance)) {
    throw new Error("Markdown box opacity and font size are invalid");
  }
  return {
    ...metadata,
    [MARKDOWN_BOX_APPEARANCE_METADATA_KEY]: {
      opacity: appearance.opacity,
      fontSize: appearance.fontSize ?? DEFAULT_MARKDOWN_FONT_SIZE,
    },
  };
}

/** Checks the persisted Markdown appearance, including older opacity-only records. */
export function isMarkdownBoxAppearance(value: unknown): value is MarkdownBoxAppearanceInput {
  return (
    isRecord(value) &&
    isUnitInterval(value.opacity) &&
    (value.fontSize === undefined || isMarkdownFontSize(value.fontSize))
  );
}

/** Reads the synchronized project-wide named Markdown color styles. */
export function readMarkdownColorStyles(
  metadata: CanonicalMetadata,
): MarkdownColorStyleLibrary | undefined {
  const value = metadata[MARKDOWN_COLOR_STYLES_METADATA_KEY];
  if (isMarkdownColorStyleLibrary(value)) return value;
  return migrateLegacyMarkdownColorStyleLibrary(value);
}

/** Returns notebook metadata with the named Markdown color styles updated. */
export function withMarkdownColorStyles(
  metadata: CanonicalMetadata,
  library: MarkdownColorStyleLibrary,
): CanonicalMetadata {
  if (!isMarkdownColorStyleLibrary(library)) {
    throw new Error("Markdown color styles are invalid");
  }
  return {
    ...metadata,
    [MARKDOWN_COLOR_STYLES_METADATA_KEY]: {
      ...(library.defaultStyleId === undefined
        ? {}
        : { defaultStyleId: library.defaultStyleId }),
      styles: library.styles.map((style) => ({
        id: style.id,
        name: style.name,
        colors: cloneMarkdownColors(style.colors),
      })),
    },
  };
}

/** Validates names, IDs, colors, uniqueness, and the default style reference. */
export function isMarkdownColorStyleLibrary(value: unknown): value is MarkdownColorStyleLibrary {
  if (!isRecord(value) || !Array.isArray(value.styles)) return false;
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const style of value.styles) {
    if (!isRecord(style) || !isMarkdownStyleId(style.id) || typeof style.name !== "string") {
      return false;
    }
    const normalizedName = style.name.trim().toLowerCase();
    if (style.name.trim().length === 0 || style.name.length > 80) return false;
    if (ids.has(style.id) || names.has(normalizedName) || !isMarkdownColors(style.colors)) {
      return false;
    }
    ids.add(style.id);
    names.add(normalizedName);
  }
  return value.defaultStyleId === undefined ||
    (isMarkdownStyleId(value.defaultStyleId) && ids.has(value.defaultStyleId));
}

function isMarkdownColors(value: unknown): value is MarkdownColors {
  if (!isRecord(value) || Object.keys(value).length !== MARKDOWN_COLOR_KEYS.length) return false;
  return MARKDOWN_COLOR_KEYS.every((key) => isMarkdownColorPair(value[key]));
}

function isMarkdownColorPair(value: unknown): value is MarkdownColorPair {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    isHexColor(value.light) &&
    isHexColor(value.dark)
  );
}

function cloneMarkdownColors(colors: MarkdownColors): MarkdownColors {
  return Object.fromEntries(
    MARKDOWN_COLOR_KEYS.map((key) => [key, { ...colors[key] }]),
  ) as MarkdownColors;
}

function migrateLegacyMarkdownColorStyleLibrary(
  value: unknown,
): MarkdownColorStyleLibrary | undefined {
  if (!isRecord(value) || !Array.isArray(value.styles)) return undefined;
  const ids = new Set<string>();
  const names = new Set<string>();
  const styles: MarkdownColorStyle[] = [];
  for (const style of value.styles) {
    if (!isRecord(style) || !isMarkdownStyleId(style.id) || typeof style.name !== "string") {
      return undefined;
    }
    const normalizedName = style.name.trim().toLowerCase();
    if (style.name.trim().length === 0 || style.name.length > 80) return undefined;
    if (ids.has(style.id) || names.has(normalizedName)) return undefined;
    const colors = migrateLegacyMarkdownColors(style.colors);
    if (colors === undefined) return undefined;
    ids.add(style.id);
    names.add(normalizedName);
    styles.push({ id: style.id, name: style.name, colors });
  }
  if (
    value.defaultStyleId !== undefined &&
    (!isMarkdownStyleId(value.defaultStyleId) || !ids.has(value.defaultStyleId))
  ) {
    return undefined;
  }
  return {
    ...(value.defaultStyleId === undefined ? {} : { defaultStyleId: value.defaultStyleId }),
    styles,
  };
}

function migrateLegacyMarkdownColors(value: unknown): MarkdownColors | undefined {
  if (
    isRecord(value) &&
    Object.keys(value).length === PREVIOUS_MARKDOWN_COLOR_KEYS.length &&
    PREVIOUS_MARKDOWN_COLOR_KEYS.every((key) => isMarkdownColorPair(value[key]))
  ) {
    return Object.fromEntries(
      MARKDOWN_COLOR_KEYS.map((key) => [
        key,
        key === "codeBackground"
          ? { ...DEFAULT_MARKDOWN_CODE_BACKGROUND_COLORS }
          : { ...(value[key] as MarkdownColorPair) },
      ]),
    ) as MarkdownColors;
  }
  if (
    !isRecord(value) ||
    !(
      (Object.keys(value).length === LEGACY_MARKDOWN_COLOR_KEYS.length &&
        LEGACY_MARKDOWN_COLOR_KEYS.every((key) => isHexColor(value[key]))) ||
      (Object.keys(value).length === PREVIOUS_LEGACY_MARKDOWN_COLOR_KEYS.length &&
        PREVIOUS_LEGACY_MARKDOWN_COLOR_KEYS.every((key) => isHexColor(value[key])))
    )
  ) {
    return undefined;
  }
  return Object.fromEntries(
    MARKDOWN_COLOR_KEYS.map((key) => {
      const color = value[key];
      return [
        key,
        typeof color === "string"
          ? { light: color, dark: color }
          : { ...DEFAULT_MARKDOWN_CODE_BACKGROUND_COLORS },
      ];
    }),
  ) as MarkdownColors;
}

function isMarkdownStyleId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  );
}

/** Reads the project-wide laser pointer settings from notebook metadata. */
export function readLaserPointerSettings(
  metadata: CanonicalMetadata,
): LaserPointerSettings | undefined {
  const value = metadata[LASER_POINTER_SETTINGS_METADATA_KEY];
  return isLaserPointerSettings(value) ? value : undefined;
}

/** Returns notebook metadata with the project-wide laser pointer settings updated. */
export function withLaserPointerSettings(
  metadata: CanonicalMetadata,
  settings: LaserPointerSettings,
): CanonicalMetadata {
  if (!isLaserPointerSettings(settings)) {
    throw new Error("Laser pointer decay must be between 0.5 and 5 seconds");
  }
  return {
    ...metadata,
    [LASER_POINTER_SETTINGS_METADATA_KEY]: { decaySeconds: settings.decaySeconds },
  };
}

/** Checks the persisted laser pointer settings without coercing user input. */
export function isLaserPointerSettings(value: unknown): value is LaserPointerSettings {
  return isRecord(value) && isLaserPointerDecaySeconds(value.decaySeconds);
}

function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

function isUnitInterval(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isLaserPointerDecaySeconds(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= LASER_POINTER_DECAY_MIN_SECONDS &&
    value <= LASER_POINTER_DECAY_MAX_SECONDS
  );
}

function isMarkdownFontSize(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MARKDOWN_FONT_SIZE_MIN &&
    value <= MARKDOWN_FONT_SIZE_MAX
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
