import { describe, expect, it } from "vitest";

import {
  APPLICATION_PREFERENCES_KEY,
  DEFAULT_APPLICATION_PREFERENCES,
  loadApplicationPreferences,
  loadProfileApplicationPreferences,
  saveApplicationPreferences,
} from "./application-preferences";

describe("application preferences", () => {
  it("round-trips theme and page background without project persistence", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const preferences = {
      theme: "dark" as const,
      pageBackground: "ruled" as const,
      textScalePercent: 120,
    };

    saveApplicationPreferences(preferences, storage);

    expect(values.has(APPLICATION_PREFERENCES_KEY)).toBe(true);
    expect(loadApplicationPreferences(storage)).toEqual(preferences);
  });

  it("validates stored values and falls back for malformed data", () => {
    expect(
      loadApplicationPreferences({
        getItem: () => JSON.stringify({ theme: "neon", pageBackground: "dots" }),
      }),
    ).toEqual(DEFAULT_APPLICATION_PREFERENCES);
    expect(loadApplicationPreferences({ getItem: () => "not json" })).toBe(
      DEFAULT_APPLICATION_PREFERENCES,
    );
  });

  it("survives storage write failures", () => {
    expect(() =>
      saveApplicationPreferences(DEFAULT_APPLICATION_PREFERENCES, {
        setItem: () => {
          throw new Error("storage unavailable");
        },
      }),
    ).not.toThrow();
  });

  it("keeps account caches isolated while migrating the old cache once", () => {
    const values = new Map<string, string>([
      [APPLICATION_PREFERENCES_KEY, JSON.stringify({ theme: "dark", pageBackground: "ruled" })],
    ]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };

    expect(loadProfileApplicationPreferences(storage, "alice")).toEqual({
      theme: "dark",
      pageBackground: "ruled",
      textScalePercent: 100,
    });
    expect(loadProfileApplicationPreferences(storage, "bob")).toBe(DEFAULT_APPLICATION_PREFERENCES);
  });
});
