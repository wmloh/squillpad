import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_PROFILE_SETTINGS } from "@squillpad/core-model";

import { ProfileSettingsStore } from "./profile-settings.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("profile settings store", () => {
  it("persists one validated settings-only file per profile and reloads it", async () => {
    const root = await mkdtemp(join(tmpdir(), "squillpad-profile-settings-"));
    roots.push(root);
    const store = await ProfileSettingsStore.open(root);
    const settings = {
      ...DEFAULT_PROFILE_SETTINGS,
      application: { theme: "dark" as const, pageBackground: "ruled" as const },
      toolbarHeight: 72,
    };

    await expect(store.save("alice", settings)).resolves.toEqual(settings);
    const source = await readFile(join(root, "profiles", "alice.json"), "utf8");
    expect(source).toContain('"username": "alice"');
    expect(source).not.toContain("password");
    expect(source).not.toContain("session");

    const reopened = await ProfileSettingsStore.open(root);
    expect(reopened.get("alice")).toEqual(settings);
    expect(reopened.list()).toMatchObject([{ username: "alice", settings }]);
  });

  it("keeps profile updates out while a repository snapshot owns the store", async () => {
    const root = await mkdtemp(join(tmpdir(), "squillpad-profile-settings-"));
    roots.push(root);
    const store = await ProfileSettingsStore.open(root);
    const release = await store.beginRepositoryOperation();
    await expect(store.save("alice", DEFAULT_PROFILE_SETTINGS)).rejects.toThrow(
      "Repository snapshot operation in progress",
    );
    release();
    await expect(store.save("alice", DEFAULT_PROFILE_SETTINGS)).resolves.toEqual(
      DEFAULT_PROFILE_SETTINGS,
    );
  });

  it("loads legacy profile files with the default arrow-key pan speed", async () => {
    const root = await mkdtemp(join(tmpdir(), "squillpad-profile-settings-"));
    roots.push(root);
    await mkdir(join(root, "profiles"));
    const legacySettings = { ...DEFAULT_PROFILE_SETTINGS };
    delete legacySettings.keyboardPanSpeedMultiplier;
    await writeFile(
      join(root, "profiles", "alice.json"),
      JSON.stringify({ schemaVersion: 1, username: "alice", settings: legacySettings }),
      "utf8",
    );

    const store = await ProfileSettingsStore.open(root);

    expect(store.get("alice")).toEqual(DEFAULT_PROFILE_SETTINGS);
  });
});
