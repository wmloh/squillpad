import { serializeCanonicalJson, type NotebookSettings } from "./canonical-format.js";
import {
  DEFAULT_AUTOSAVE_INTERVAL_SECONDS,
  DEFAULT_LAN_SHARING_ENABLED,
  DEFAULT_LASER_POINTER_SETTINGS,
  DEFAULT_MARKDOWN_BOX_APPEARANCE,
  EMPTY_MARKDOWN_COLOR_STYLE_LIBRARY,
  isAutosaveIntervalSeconds,
  isLaserPointerSettings,
  isMarkdownBoxAppearance,
  isMarkdownColorStyleLibrary,
  isSynchronizedInkColors,
  readAutosaveIntervalSeconds,
  readLanSharingDefault,
  readLaserPointerSettings,
  readMarkdownBoxAppearance,
  readMarkdownColorStyles,
  readSynchronizedInkColors,
  withAutosaveIntervalSeconds,
  withLanSharingDefault,
  withLaserPointerSettings,
  withMarkdownBoxAppearance,
  withMarkdownColorStyles,
  withSynchronizedInkColors,
  type AutosaveIntervalSeconds,
  type LaserPointerSettings,
  type MarkdownBoxAppearance,
  type MarkdownColorStyle,
  type MarkdownColorStyleLibrary,
  type SynchronizedInkColors,
} from "./project-preferences.js";

export const PROJECT_SETTINGS_EXPORT_FORMAT = "squillpad-project-settings" as const;
export const PROJECT_SETTINGS_EXPORT_SCHEMA_VERSION = 1 as const;

/** Explicitly transferable notebook settings. Hierarchy, content, and arbitrary metadata are excluded. */
export interface PortableProjectSettings {
  readonly defaultZoom?: number;
  readonly synchronizedInkColors?: SynchronizedInkColors;
  readonly markdownBoxAppearance?: MarkdownBoxAppearance;
  readonly markdownColorStyles?: MarkdownColorStyleLibrary;
  readonly laserPointerSettings?: LaserPointerSettings;
  readonly lanSharingDefault?: boolean;
  readonly autosaveIntervalSeconds?: AutosaveIntervalSeconds;
}

export interface ProjectSettingsExport {
  readonly format: typeof PROJECT_SETTINGS_EXPORT_FORMAT;
  readonly schemaVersion: typeof PROJECT_SETTINGS_EXPORT_SCHEMA_VERSION;
  readonly settings: PortableProjectSettings;
}

/** Builds a portable document from the known notebook-level settings only. */
export function createProjectSettingsExport(settings: NotebookSettings): ProjectSettingsExport {
  const synchronizedInkColors = readSynchronizedInkColors(settings.metadata);
  return {
    format: PROJECT_SETTINGS_EXPORT_FORMAT,
    schemaVersion: PROJECT_SETTINGS_EXPORT_SCHEMA_VERSION,
    settings: {
      defaultZoom: settings.defaultZoom,
      ...(synchronizedInkColors === undefined ? {} : { synchronizedInkColors }),
      markdownBoxAppearance:
        readMarkdownBoxAppearance(settings.metadata) ?? DEFAULT_MARKDOWN_BOX_APPEARANCE,
      markdownColorStyles:
        readMarkdownColorStyles(settings.metadata) ?? EMPTY_MARKDOWN_COLOR_STYLE_LIBRARY,
      laserPointerSettings:
        readLaserPointerSettings(settings.metadata) ?? DEFAULT_LASER_POINTER_SETTINGS,
      lanSharingDefault:
        readLanSharingDefault(settings.metadata) ?? DEFAULT_LAN_SHARING_ENABLED,
      autosaveIntervalSeconds:
        readAutosaveIntervalSeconds(settings.metadata) ?? DEFAULT_AUTOSAVE_INTERVAL_SECONDS,
    },
  };
}

export function serializeProjectSettingsExport(settings: NotebookSettings): string {
  return serializeCanonicalJson(createProjectSettingsExport(settings));
}

export function isProjectSettingsExport(value: unknown): value is ProjectSettingsExport {
  if (!isRecord(value) || !hasExactKeys(value, ["format", "schemaVersion", "settings"])) {
    return false;
  }
  return (
    value.format === PROJECT_SETTINGS_EXPORT_FORMAT &&
    value.schemaVersion === PROJECT_SETTINGS_EXPORT_SCHEMA_VERSION &&
    isPortableProjectSettings(value.settings)
  );
}

export function isPortableProjectSettings(value: unknown): value is PortableProjectSettings {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [], [
      "defaultZoom",
      "synchronizedInkColors",
      "markdownBoxAppearance",
      "markdownColorStyles",
      "laserPointerSettings",
      "lanSharingDefault",
      "autosaveIntervalSeconds",
    ])
  ) {
    return false;
  }
  return (
    (value.defaultZoom === undefined || isPositiveFinite(value.defaultZoom)) &&
    (value.synchronizedInkColors === undefined ||
      isSynchronizedInkColors(value.synchronizedInkColors)) &&
    (value.markdownBoxAppearance === undefined ||
      isMarkdownBoxAppearance(value.markdownBoxAppearance)) &&
    (value.markdownColorStyles === undefined ||
      isMarkdownColorStyleLibrary(value.markdownColorStyles)) &&
    (value.laserPointerSettings === undefined ||
      isLaserPointerSettings(value.laserPointerSettings)) &&
    (value.lanSharingDefault === undefined || typeof value.lanSharingDefault === "boolean") &&
    (value.autosaveIntervalSeconds === undefined ||
      isAutosaveIntervalSeconds(value.autosaveIntervalSeconds))
  );
}

/** Applies imported scalar settings and merges the imported named Markdown styles. */
export function mergePortableProjectSettings(
  current: NotebookSettings,
  imported: PortableProjectSettings,
): NotebookSettings {
  if (!isPortableProjectSettings(imported)) throw new Error("Project settings are invalid");
  let metadata = current.metadata;
  if (imported.synchronizedInkColors !== undefined) {
    metadata = withSynchronizedInkColors(metadata, imported.synchronizedInkColors);
  }
  if (imported.markdownBoxAppearance !== undefined) {
    metadata = withMarkdownBoxAppearance(metadata, imported.markdownBoxAppearance);
  }
  if (imported.markdownColorStyles !== undefined) {
    metadata = withMarkdownColorStyles(
      metadata,
      mergeMarkdownColorStyleLibraries(
        readMarkdownColorStyles(metadata) ?? EMPTY_MARKDOWN_COLOR_STYLE_LIBRARY,
        imported.markdownColorStyles,
      ),
    );
  }
  if (imported.laserPointerSettings !== undefined) {
    metadata = withLaserPointerSettings(metadata, imported.laserPointerSettings);
  }
  if (imported.lanSharingDefault !== undefined) {
    metadata = withLanSharingDefault(metadata, imported.lanSharingDefault);
  }
  if (imported.autosaveIntervalSeconds !== undefined) {
    metadata = withAutosaveIntervalSeconds(metadata, imported.autosaveIntervalSeconds);
  }
  return {
    defaultZoom: imported.defaultZoom ?? current.defaultZoom,
    metadata,
  };
}

/** Merges styles by normalized name first and stable ID second, preserving destination references. */
export function mergeMarkdownColorStyleLibraries(
  current: MarkdownColorStyleLibrary,
  imported: MarkdownColorStyleLibrary,
): MarkdownColorStyleLibrary {
  if (!isMarkdownColorStyleLibrary(current) || !isMarkdownColorStyleLibrary(imported)) {
    throw new Error("Markdown color styles are invalid");
  }
  const styles: MarkdownColorStyle[] = current.styles.map(cloneMarkdownStyle);
  const importedIds = new Map<string, string>();
  const claimedTargetIds = new Set<string>();
  for (const style of imported.styles) {
    const normalizedName = style.name.trim().toLowerCase();
    const nameIndex = styles.findIndex(
      (candidate) => candidate.name.trim().toLowerCase() === normalizedName,
    );
    const idIndex = styles.findIndex((candidate) => candidate.id === style.id);
    const targetIndex = nameIndex >= 0 ? nameIndex : idIndex;
    if (targetIndex >= 0) {
      const target = styles[targetIndex] as MarkdownColorStyle;
      if (claimedTargetIds.has(target.id)) {
        throw new Error("Imported Markdown styles have an ambiguous name and ID collision");
      }
      claimedTargetIds.add(target.id);
      styles[targetIndex] = {
        id: target.id,
        name: style.name,
        colors: cloneMarkdownStyle(style).colors,
      };
      importedIds.set(style.id, target.id);
    } else {
      styles.push(cloneMarkdownStyle(style));
      importedIds.set(style.id, style.id);
    }
  }
  const defaultStyleId =
    imported.defaultStyleId === undefined
      ? current.defaultStyleId
      : importedIds.get(imported.defaultStyleId);
  const merged = {
    ...(defaultStyleId === undefined ? {} : { defaultStyleId }),
    styles,
  };
  if (!isMarkdownColorStyleLibrary(merged)) {
    throw new Error("Merged Markdown color styles are invalid");
  }
  return merged;
}

function cloneMarkdownStyle(style: MarkdownColorStyle): MarkdownColorStyle {
  return {
    id: style.id,
    name: style.name,
    colors: Object.fromEntries(
      Object.entries(style.colors).map(([key, colors]) => [key, { ...colors }]),
    ) as MarkdownColorStyle["colors"],
  };
}

function isPositiveFinite(value: unknown): value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return false;
  const factor = 10_000;
  return Math.round((value + Number.EPSILON) * factor) / factor === value;
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
