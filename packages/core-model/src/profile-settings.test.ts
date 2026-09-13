import { describe, expect, it } from "vitest";

import {
  createProfileSettingsExport,
  DEFAULT_APPLICATION_TEXT_SCALE_PERCENT,
  DEFAULT_KEYBOARD_PAN_SPEED_MULTIPLIER,
  DEFAULT_PROFILE_SETTINGS,
  isProfileSettings,
  isProfileSettingsExport,
  readKeyboardPanSpeedMultiplier,
  readApplicationTextScalePercent,
  validateProfileSettingsExport,
} from "./profile-settings.js";

describe("profile settings format", () => {
  it("accepts the complete default settings and wraps them as a portable export", () => {
    expect(isProfileSettings(DEFAULT_PROFILE_SETTINGS)).toBe(true);
    const exported = createProfileSettingsExport(DEFAULT_PROFILE_SETTINGS);
    expect(isProfileSettingsExport(exported)).toBe(true);
    expect(exported).not.toHaveProperty("username");
  });

  it("rejects credential-like fields in an export document", () => {
    const exported = createProfileSettingsExport(DEFAULT_PROFILE_SETTINGS);
    const invalid = { ...exported, password: "secret" };
    const validation = validateProfileSettingsExport(invalid);
    expect(validation.success).toBe(false);
    if (!validation.success) {
      expect(validation.issues).toContainEqual({
        path: "$.password",
        message: "is not a recognized field",
      });
    }
  });

  it("rejects unknown fields nested inside a palette", () => {
    const invalid = structuredClone(DEFAULT_PROFILE_SETTINGS) as unknown as Record<string, unknown>;
    const drawingPalettes = invalid.drawingPalettes as Record<string, unknown>;
    const pen = drawingPalettes.pen as Record<string, unknown>;
    pen.password = "secret";

    expect(isProfileSettings(invalid)).toBe(false);
  });

  it("defaults the arrow-key pan speed for profiles written before the setting existed", () => {
    const { keyboardPanSpeedMultiplier: _ignored, ...legacySettings } = DEFAULT_PROFILE_SETTINGS;

    expect(isProfileSettings(legacySettings)).toBe(true);
    expect(readKeyboardPanSpeedMultiplier(undefined)).toBe(DEFAULT_KEYBOARD_PAN_SPEED_MULTIPLIER);
    expect(readKeyboardPanSpeedMultiplier(4.5)).toBe(DEFAULT_KEYBOARD_PAN_SPEED_MULTIPLIER);
  });

  it("rejects arrow-key pan speed multipliers outside the profile bounds", () => {
    const invalid = {
      ...DEFAULT_PROFILE_SETTINGS,
      keyboardPanSpeedMultiplier: 0.1,
    };

    expect(isProfileSettings(invalid)).toBe(false);
  });

  it("defaults the app text scale for profiles written before the setting existed", () => {
    const legacySettings = structuredClone(DEFAULT_PROFILE_SETTINGS);
    delete legacySettings.application.textScalePercent;

    expect(isProfileSettings(legacySettings)).toBe(true);
    expect(readApplicationTextScalePercent(undefined)).toBe(DEFAULT_APPLICATION_TEXT_SCALE_PERCENT);
    expect(readApplicationTextScalePercent(120)).toBe(120);
    expect(readApplicationTextScalePercent(125)).toBe(DEFAULT_APPLICATION_TEXT_SCALE_PERCENT);
  });

  it("rejects app text scales outside the percentage step range", () => {
    const invalid = structuredClone(DEFAULT_PROFILE_SETTINGS);
    invalid.application.textScalePercent = 82;

    expect(isProfileSettings(invalid)).toBe(false);
  });
});
