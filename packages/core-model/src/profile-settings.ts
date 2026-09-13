import {
  serializeCanonicalJson,
  type InkStyle,
  type ShapeStyle,
  type ValidationIssue,
  type ValidationResult,
} from "./canonical-format.js";
import { DRAWING_PALETTE_SLOT_COUNT, type ProfileDrawingPalettes } from "./profile-preferences.js";

/** Version of the canonical per-profile settings record. */
export const PROFILE_SETTINGS_SCHEMA_VERSION = 1 as const;

/** Bounds and default for the profile-level arrow-key pan speed multiplier. */
export const KEYBOARD_PAN_SPEED_MULTIPLIER_MIN = 0.25;
export const KEYBOARD_PAN_SPEED_MULTIPLIER_MAX = 4;
export const KEYBOARD_PAN_SPEED_MULTIPLIER_STEP = 0.25;
export const DEFAULT_KEYBOARD_PAN_SPEED_MULTIPLIER = 1;

/** Bounds and default for the app-wide text scale percentage. */
export const APPLICATION_TEXT_SCALE_PERCENT_MIN = 80;
export const APPLICATION_TEXT_SCALE_PERCENT_MAX = 120;
export const APPLICATION_TEXT_SCALE_PERCENT_STEP = 5;
export const DEFAULT_APPLICATION_TEXT_SCALE_PERCENT = 100;

/** Identifies a portable SquillPad profile-settings export. */
export const PROFILE_SETTINGS_EXPORT_FORMAT = "squillpad-profile-settings" as const;

/** The application theme persisted with a profile. */
export type ProfileApplicationTheme = "light" | "dark";

/** The render-only paper treatment persisted with a profile. */
export type ProfilePageBackground = "blank" | "ruled" | "grid";

/** A drawing tool that can be remembered as the profile's last active tool. */
export type ProfileDrawingTool =
  | "select"
  | "pan"
  | "insert-space"
  | "laser"
  | "text"
  | "pen"
  | "highlighter"
  | "eraser"
  | "line"
  | "arrow"
  | "rectangle"
  | "ellipse";

/** The eraser behavior remembered by a profile. */
export type ProfileEraserMode = "stroke" | "segment";

export interface ProfileApplicationPreferences {
  readonly theme: ProfileApplicationTheme;
  readonly pageBackground: ProfilePageBackground;
  /** Optional while reading settings written before the app-wide text scale existed. */
  readonly textScalePercent?: number;
}

export interface ProfileDrawingPreferences {
  readonly lastTool: ProfileDrawingTool;
  readonly pen: InkStyle;
  readonly highlighter: InkStyle;
  readonly penDrawsTouchNavigates: boolean;
  readonly radialToolbarEnabled: boolean;
  readonly eraserMode: ProfileEraserMode;
  readonly eraserWidth: number;
  readonly shape: ShapeStyle;
}

/** Complete profile preferences that may be synchronized and exported. */
export interface ProfileSettings {
  readonly application: ProfileApplicationPreferences;
  readonly drawing: ProfileDrawingPreferences;
  /** Optional while reading schema-v1 records written before this setting existed. */
  readonly keyboardPanSpeedMultiplier?: number;
  readonly toolbarHeight: number;
  readonly palmRejection: boolean;
  readonly drawingPalettes: ProfileDrawingPalettes;
}

/** Canonical file contents for one profile under `profiles/<username>.json`. */
export interface ProfileSettingsRecord {
  readonly schemaVersion: typeof PROFILE_SETTINGS_SCHEMA_VERSION;
  readonly username: string;
  readonly settings: ProfileSettings;
}

/** Portable settings-only export; it deliberately contains no account credentials. */
export interface ProfileSettingsExport {
  readonly format: typeof PROFILE_SETTINGS_EXPORT_FORMAT;
  readonly schemaVersion: typeof PROFILE_SETTINGS_SCHEMA_VERSION;
  readonly settings: ProfileSettings;
}

/** Defaults used when migrating an existing account or initializing a new profile record. */
export const DEFAULT_PROFILE_SETTINGS: ProfileSettings = {
  application: {
    theme: "light",
    pageBackground: "grid",
    textScalePercent: DEFAULT_APPLICATION_TEXT_SCALE_PERCENT,
  },
  drawing: {
    lastTool: "select",
    pen: { color: "#9ca3af", width: 4, opacity: 1, highlighter: false, smoothing: 0.65 },
    highlighter: {
      color: "#9ca3af",
      width: 10,
      opacity: 0.35,
      highlighter: true,
      smoothing: 0.65,
    },
    penDrawsTouchNavigates: true,
    radialToolbarEnabled: true,
    eraserMode: "stroke",
    eraserWidth: 14,
    shape: { strokeColor: "#38245f", strokeWidth: 3, fillColor: null, opacity: 1 },
  },
  keyboardPanSpeedMultiplier: DEFAULT_KEYBOARD_PAN_SPEED_MULTIPLIER,
  toolbarHeight: 44,
  palmRejection: false,
  drawingPalettes: {
    pen: defaultPalette(4, 1),
    highlighter: defaultPalette(10, 0.35),
    shape: defaultPalette(3, 1),
  },
};

/** Creates a settings-only export document from complete profile settings. */
export function createProfileSettingsExport(settings: ProfileSettings): ProfileSettingsExport {
  if (!isProfileSettings(settings)) throw new Error("Profile settings are invalid");
  return {
    format: PROFILE_SETTINGS_EXPORT_FORMAT,
    schemaVersion: PROFILE_SETTINGS_SCHEMA_VERSION,
    settings,
  };
}

/** Serializes a portable profile export deterministically for download. */
export function serializeProfileSettingsExport(settings: ProfileSettings): string {
  return serializeCanonicalJson(createProfileSettingsExport(settings));
}

/** Checks a complete profile settings object without coercing user input. */
export function isProfileSettings(value: unknown): value is ProfileSettings {
  return validateProfileSettings(value).success;
}

/** Validates one canonical profile settings object. */
export function validateProfileSettings(value: unknown): ValidationResult<ProfileSettings> {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) return invalidRoot("profile settings must be an object");

  exactKeys(
    value,
    ["application", "drawing", "drawingPalettes", "palmRejection", "toolbarHeight"],
    "$",
    issues,
    ["keyboardPanSpeedMultiplier"],
  );
  validateApplication(value.application, "$.application", issues);
  validateDrawing(value.drawing, "$.drawing", issues);
  validateDrawingPalettes(value.drawingPalettes, "$.drawingPalettes", issues);
  if (typeof value.palmRejection !== "boolean") {
    issues.push({ path: "$.palmRejection", message: "must be a boolean" });
  }
  if (
    typeof value.toolbarHeight !== "number" ||
    !Number.isSafeInteger(value.toolbarHeight) ||
    value.toolbarHeight < 24 ||
    value.toolbarHeight > 120
  ) {
    issues.push({ path: "$.toolbarHeight", message: "must be an integer between 24 and 120" });
  }
  if (value.keyboardPanSpeedMultiplier !== undefined) {
    if (
      typeof value.keyboardPanSpeedMultiplier !== "number" ||
      !Number.isFinite(value.keyboardPanSpeedMultiplier) ||
      value.keyboardPanSpeedMultiplier < KEYBOARD_PAN_SPEED_MULTIPLIER_MIN ||
      value.keyboardPanSpeedMultiplier > KEYBOARD_PAN_SPEED_MULTIPLIER_MAX
    ) {
      issues.push({
        path: "$.keyboardPanSpeedMultiplier",
        message: `must be between ${KEYBOARD_PAN_SPEED_MULTIPLIER_MIN} and ${KEYBOARD_PAN_SPEED_MULTIPLIER_MAX}`,
      });
    }
  }
  return result<ProfileSettings>(value, issues);
}

/** Resolves the arrow-key pan multiplier, including the default for older profiles. */
export function readKeyboardPanSpeedMultiplier(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < KEYBOARD_PAN_SPEED_MULTIPLIER_MIN ||
    value > KEYBOARD_PAN_SPEED_MULTIPLIER_MAX
  ) {
    return DEFAULT_KEYBOARD_PAN_SPEED_MULTIPLIER;
  }
  return value;
}

/** Checks a canonical per-profile file record without coercing user input. */
export function isProfileSettingsRecord(value: unknown): value is ProfileSettingsRecord {
  return validateProfileSettingsRecord(value).success;
}

/** Validates a canonical per-profile file record. */
export function validateProfileSettingsRecord(
  value: unknown,
): ValidationResult<ProfileSettingsRecord> {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) return invalidRoot("profile settings record must be an object");
  exactKeys(value, ["schemaVersion", "settings", "username"], "$", issues);
  if (value.schemaVersion !== PROFILE_SETTINGS_SCHEMA_VERSION) {
    issues.push({
      path: "$.schemaVersion",
      message: `must equal ${PROFILE_SETTINGS_SCHEMA_VERSION}`,
    });
  }
  username(value.username, "$.username", issues);
  const settings = validateProfileSettings(value.settings);
  if (!settings.success)
    issues.push(
      ...settings.issues.map((issue) => ({
        path: `$.settings${issue.path.slice(1)}`,
        message: issue.message,
      })),
    );
  return result<ProfileSettingsRecord>(value, issues);
}

/** Checks a settings-only export document without coercing user input. */
export function isProfileSettingsExport(value: unknown): value is ProfileSettingsExport {
  return validateProfileSettingsExport(value).success;
}

/** Validates a settings-only export document. */
export function validateProfileSettingsExport(
  value: unknown,
): ValidationResult<ProfileSettingsExport> {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) return invalidRoot("profile settings export must be an object");
  exactKeys(value, ["format", "schemaVersion", "settings"], "$", issues);
  if (value.format !== PROFILE_SETTINGS_EXPORT_FORMAT) {
    issues.push({ path: "$.format", message: `must equal ${PROFILE_SETTINGS_EXPORT_FORMAT}` });
  }
  if (value.schemaVersion !== PROFILE_SETTINGS_SCHEMA_VERSION) {
    issues.push({
      path: "$.schemaVersion",
      message: `must equal ${PROFILE_SETTINGS_SCHEMA_VERSION}`,
    });
  }
  const settings = validateProfileSettings(value.settings);
  if (!settings.success)
    issues.push(
      ...settings.issues.map((issue) => ({
        path: `$.settings${issue.path.slice(1)}`,
        message: issue.message,
      })),
    );
  return result<ProfileSettingsExport>(value, issues);
}

/** Checks the stable profile identity used by canonical profile filenames. */
export function isProfileUsername(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{2,31}$/.test(value);
}

function defaultPalette(width: number, opacity: number): ProfileDrawingPalettes["pen"] {
  const colors = ["#9ca3af", "#60a5fa", "#fb923c", "#4ade80", "#f87171", "#c4b5fd"];
  return {
    custom: false,
    selectedIndex: 0,
    slots: colors.map((color) => ({ color, width, opacity })),
  };
}

function validateApplication(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "must be an object" });
    return;
  }
  exactKeys(value, ["pageBackground", "theme"], path, issues, ["textScalePercent"]);
  if (value.theme !== "light" && value.theme !== "dark") {
    issues.push({ path: `${path}.theme`, message: "must be light or dark" });
  }
  if (
    value.pageBackground !== "blank" &&
    value.pageBackground !== "ruled" &&
    value.pageBackground !== "grid"
  ) {
    issues.push({ path: `${path}.pageBackground`, message: "must be blank, ruled, or grid" });
  }
  if (
    value.textScalePercent !== undefined &&
    !isApplicationTextScalePercent(value.textScalePercent)
  ) {
    issues.push({
      path: `${path}.textScalePercent`,
      message: `must be an integer between ${APPLICATION_TEXT_SCALE_PERCENT_MIN} and ${APPLICATION_TEXT_SCALE_PERCENT_MAX} in ${APPLICATION_TEXT_SCALE_PERCENT_STEP}% steps`,
    });
  }
}

/** Resolves the app-wide text scale, including the default for older profiles. */
export function readApplicationTextScalePercent(value: unknown): number {
  return isApplicationTextScalePercent(value) ? value : DEFAULT_APPLICATION_TEXT_SCALE_PERCENT;
}

function isApplicationTextScalePercent(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= APPLICATION_TEXT_SCALE_PERCENT_MIN &&
    value <= APPLICATION_TEXT_SCALE_PERCENT_MAX &&
    (value - APPLICATION_TEXT_SCALE_PERCENT_MIN) % APPLICATION_TEXT_SCALE_PERCENT_STEP === 0
  );
}

function validateDrawing(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "must be an object" });
    return;
  }
  exactKeys(
    value,
    [
      "eraserMode",
      "eraserWidth",
      "highlighter",
      "lastTool",
      "pen",
      "penDrawsTouchNavigates",
      "radialToolbarEnabled",
      "shape",
    ],
    path,
    issues,
  );
  if (!isDrawingTool(value.lastTool)) {
    issues.push({ path: `${path}.lastTool`, message: "must be a supported drawing tool" });
  }
  validateInkStyle(value.pen, `${path}.pen`, issues);
  validateInkStyle(value.highlighter, `${path}.highlighter`, issues);
  if (typeof value.penDrawsTouchNavigates !== "boolean") {
    issues.push({ path: `${path}.penDrawsTouchNavigates`, message: "must be a boolean" });
  }
  if (typeof value.radialToolbarEnabled !== "boolean") {
    issues.push({ path: `${path}.radialToolbarEnabled`, message: "must be a boolean" });
  }
  if (value.eraserMode !== "stroke" && value.eraserMode !== "segment") {
    issues.push({ path: `${path}.eraserMode`, message: "must be stroke or segment" });
  }
  if (
    typeof value.eraserWidth !== "number" ||
    !Number.isFinite(value.eraserWidth) ||
    value.eraserWidth <= 0
  ) {
    issues.push({ path: `${path}.eraserWidth`, message: "must be a positive finite number" });
  }
  validateShapeStyle(value.shape, `${path}.shape`, issues);
}

function validateInkStyle(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "must be an object" });
    return;
  }
  exactKeys(value, ["color", "highlighter", "opacity", "width"], path, issues, ["smoothing"]);
  hexColor(value.color, `${path}.color`, issues);
  positiveFinite(value.width, `${path}.width`, issues);
  unitInterval(value.opacity, `${path}.opacity`, issues);
  if (typeof value.highlighter !== "boolean") {
    issues.push({ path: `${path}.highlighter`, message: "must be a boolean" });
  }
  if (value.smoothing !== undefined) unitInterval(value.smoothing, `${path}.smoothing`, issues);
}

function validateShapeStyle(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "must be an object" });
    return;
  }
  exactKeys(value, ["fillColor", "opacity", "strokeColor", "strokeWidth"], path, issues);
  hexColor(value.strokeColor, `${path}.strokeColor`, issues);
  if (value.fillColor !== null) hexColor(value.fillColor, `${path}.fillColor`, issues);
  positiveFinite(value.strokeWidth, `${path}.strokeWidth`, issues);
  unitInterval(value.opacity, `${path}.opacity`, issues);
}

function validateDrawingPalettes(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "must contain three valid six-slot palettes" });
    return;
  }
  exactKeys(value, ["highlighter", "pen", "shape"], path, issues);
  validatePalette(value.pen, `${path}.pen`, issues);
  validatePalette(value.highlighter, `${path}.highlighter`, issues);
  validatePalette(value.shape, `${path}.shape`, issues);
}

function validatePalette(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "must be a six-slot palette" });
    return;
  }
  exactKeys(value, ["custom", "selectedIndex", "slots"], path, issues);
  if (typeof value.custom !== "boolean") {
    issues.push({ path: `${path}.custom`, message: "must be a boolean" });
  }
  if (
    typeof value.selectedIndex !== "number" ||
    !Number.isSafeInteger(value.selectedIndex) ||
    value.selectedIndex < 0 ||
    value.selectedIndex >= DRAWING_PALETTE_SLOT_COUNT
  ) {
    issues.push({
      path: `${path}.selectedIndex`,
      message: `must be an integer between 0 and ${DRAWING_PALETTE_SLOT_COUNT - 1}`,
    });
  }
  if (!Array.isArray(value.slots) || value.slots.length !== DRAWING_PALETTE_SLOT_COUNT) {
    issues.push({
      path: `${path}.slots`,
      message: `must contain ${DRAWING_PALETTE_SLOT_COUNT} slots`,
    });
    return;
  }
  value.slots.forEach((slot, index) =>
    validatePaletteSlot(slot, `${path}.slots[${index}]`, issues),
  );
}

function validatePaletteSlot(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "must be a palette slot" });
    return;
  }
  exactKeys(value, ["color", "opacity", "width"], path, issues);
  hexColor(value.color, `${path}.color`, issues);
  positiveFinite(value.width, `${path}.width`, issues);
  unitInterval(value.opacity, `${path}.opacity`, issues);
}

function username(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isProfileUsername(value))
    issues.push({ path, message: "must be a valid lowercase profile name" });
}

function hexColor(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (typeof value !== "string" || !/^#[0-9a-fA-F]{6}$/.test(value)) {
    issues.push({ path, message: "must be a six-digit hexadecimal color" });
  }
}

function positiveFinite(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    issues.push({ path, message: "must be a positive finite number" });
  }
}

function unitInterval(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    issues.push({ path, message: "must be between zero and one" });
  }
}

function isDrawingTool(value: unknown): value is ProfileDrawingTool {
  return (
    value === "select" ||
    value === "pan" ||
    value === "insert-space" ||
    value === "laser" ||
    value === "text" ||
    value === "pen" ||
    value === "highlighter" ||
    value === "eraser" ||
    value === "line" ||
    value === "arrow" ||
    value === "rectangle" ||
    value === "ellipse"
  );
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
  issues: ValidationIssue[],
  optional: readonly string[] = [],
): void {
  for (const key of Object.keys(value)) {
    if (!expected.includes(key) && !optional.includes(key)) {
      issues.push({ path: `${path}.${key}`, message: "is not a recognized field" });
    }
  }
  for (const key of expected) {
    if (!(key in value)) issues.push({ path: `${path}.${key}`, message: "is required" });
  }
}

function result<T>(value: unknown, issues: readonly ValidationIssue[]): ValidationResult<T> {
  return issues.length === 0 ? { success: true, data: value as T } : { success: false, issues };
}

function invalidRoot<T>(message: string): ValidationResult<T> {
  return { success: false, issues: [{ path: "$", message }] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
