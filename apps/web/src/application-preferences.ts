import type {
  ProfileApplicationPreferences,
  ProfileApplicationTheme,
  ProfilePageBackground,
} from "@squillpad/core-model";
import {
  DEFAULT_APPLICATION_TEXT_SCALE_PERCENT,
  readApplicationTextScalePercent,
} from "@squillpad/core-model";

export const APPLICATION_PREFERENCES_KEY = "squillpad:application-preferences:v1";
const APPLICATION_PREFERENCES_OWNER_KEY = "squillpad:application-preferences-owner:v1";

export type ApplicationTheme = ProfileApplicationTheme;
export type PageBackground = ProfilePageBackground;

export type ApplicationPreferences = Omit<ProfileApplicationPreferences, "textScalePercent"> & {
  readonly textScalePercent: number;
};

export const DEFAULT_APPLICATION_PREFERENCES: ApplicationPreferences = {
  theme: "light",
  pageBackground: "grid",
  textScalePercent: DEFAULT_APPLICATION_TEXT_SCALE_PERCENT,
};

/** Reads validated browser-local application preferences. */
export function loadApplicationPreferences(
  storage?: Pick<Storage, "getItem">,
  profileUsername?: string,
): ApplicationPreferences {
  return loadStoredApplicationPreferences(storage, applicationPreferencesKey(profileUsername));
}

/** Loads one account's cache, migrating the legacy unscoped cache only once. */
export function loadProfileApplicationPreferences(
  storage: Pick<Storage, "getItem" | "setItem"> | undefined,
  profileUsername: string,
): ApplicationPreferences {
  if (storage === undefined) return DEFAULT_APPLICATION_PREFERENCES;
  const profileKey = applicationPreferencesKey(profileUsername);
  try {
    if (storage.getItem(profileKey) !== null) {
      if (storage.getItem(APPLICATION_PREFERENCES_OWNER_KEY) === null) {
        storage.setItem(APPLICATION_PREFERENCES_OWNER_KEY, profileUsername);
      }
      return loadStoredApplicationPreferences(storage, profileKey);
    }
    const owner = storage.getItem(APPLICATION_PREFERENCES_OWNER_KEY);
    if (owner !== null && owner !== profileUsername) return DEFAULT_APPLICATION_PREFERENCES;
    const legacy = loadStoredApplicationPreferences(storage, APPLICATION_PREFERENCES_KEY);
    storage.setItem(APPLICATION_PREFERENCES_OWNER_KEY, profileUsername);
    storage.setItem(profileKey, JSON.stringify(legacy));
    return legacy;
  } catch {
    return DEFAULT_APPLICATION_PREFERENCES;
  }
}

/** Stores application preferences in the optional account-specific browser cache. */
export function saveApplicationPreferences(
  preferences: ApplicationPreferences,
  storage?: Pick<Storage, "setItem">,
  profileUsername?: string,
): void {
  try {
    storage?.setItem(applicationPreferencesKey(profileUsername), JSON.stringify(preferences));
  } catch {
    // Private browsing and restricted storage must not prevent notebook editing.
  }
}

export function applicationPreferencesKey(profileUsername?: string): string {
  return profileUsername === undefined
    ? APPLICATION_PREFERENCES_KEY
    : `${APPLICATION_PREFERENCES_KEY}:profile:${encodeURIComponent(profileUsername)}`;
}

function loadStoredApplicationPreferences(
  storage: Pick<Storage, "getItem"> | undefined,
  key: string,
): ApplicationPreferences {
  if (storage === undefined) return DEFAULT_APPLICATION_PREFERENCES;
  try {
    const value: unknown = JSON.parse(storage.getItem(key) ?? "null");
    if (!isRecord(value)) return DEFAULT_APPLICATION_PREFERENCES;
    return {
      theme: value.theme === "dark" ? "dark" : "light",
      pageBackground: pageBackground(value.pageBackground),
      textScalePercent: readApplicationTextScalePercent(value.textScalePercent),
    };
  } catch {
    return DEFAULT_APPLICATION_PREFERENCES;
  }
}

function pageBackground(value: unknown): PageBackground {
  return value === "blank" || value === "ruled" || value === "grid" ? value : "grid";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
