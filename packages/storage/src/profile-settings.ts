import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import {
  DEFAULT_PROFILE_SETTINGS,
  isProfileSettings,
  isProfileUsername,
  readKeyboardPanSpeedMultiplier,
  PROFILE_SETTINGS_SCHEMA_VERSION,
  serializeCanonicalJson,
  validateProfileSettingsRecord,
  type ProfileSettings,
  type ProfileSettingsRecord,
} from "@squillpad/core-model";

export const PROFILE_SETTINGS_DIRECTORY = "profiles";

/** Owns the canonical, settings-only profile files for one project. */
export class ProfileSettingsStore {
  readonly #projectRoot: string;
  readonly #directory: string;
  #profiles = new Map<string, ProfileSettings>();
  #mutationQueue: Promise<unknown> = Promise.resolve();
  #writeQueue: Promise<void> = Promise.resolve();
  #repositoryOperationActive = false;

  private constructor(projectRoot: string) {
    this.#projectRoot = resolve(projectRoot);
    this.#directory = join(this.#projectRoot, PROFILE_SETTINGS_DIRECTORY);
  }

  static async open(projectRoot: string): Promise<ProfileSettingsStore> {
    const store = new ProfileSettingsStore(projectRoot);
    await store.reload();
    return store;
  }

  /** Returns one loaded profile without exposing account credentials or sessions. */
  get(username: string): ProfileSettings | undefined {
    const settings = this.#profiles.get(username);
    return settings === undefined ? undefined : cloneProfileSettings(settings);
  }

  /** Lists every settings-only profile currently loaded from the project. */
  list(): readonly ProfileSettingsRecord[] {
    return [...this.#profiles.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([username, settings]) => ({
        schemaVersion: PROFILE_SETTINGS_SCHEMA_VERSION,
        username,
        settings: cloneProfileSettings(settings),
      }));
  }

  /** Reloads all canonical profile files after an external Git tree replacement. */
  async reload(): Promise<void> {
    await this.#writeQueue;
    let entries;
    try {
      const status = await lstat(this.#directory);
      if (status.isSymbolicLink() || !status.isDirectory()) {
        throw new Error("The profile settings path must be a real directory");
      }
      entries = await readdir(this.#directory, { withFileTypes: true });
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) {
        this.#profiles.clear();
        return;
      }
      throw error;
    }

    const next = new Map<string, ProfileSettings>();
    for (const entry of entries) {
      const username = profileUsernameFromFilename(entry.name);
      if (entry.isSymbolicLink() || !entry.isFile() || username === undefined) {
        throw new Error(`Invalid profile settings entry: ${join(this.#directory, entry.name)}`);
      }
      const path = join(this.#directory, entry.name);
      const status = await lstat(path);
      if (status.nlink !== 1) throw new Error(`Profile settings file must not be linked: ${path}`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
      } catch (error) {
        throw new Error(`Profile settings file ${path} is malformed: ${errorMessage(error)}`);
      }
      const validation = validateProfileSettingsRecord(parsed);
      if (!validation.success) {
        throw new Error(
          `Profile settings file ${path} is invalid: ${formatIssues(validation.issues)}`,
        );
      }
      if (validation.data.username !== username) {
        throw new Error(`Profile settings file ${path} has a mismatched profile name`);
      }
      next.set(username, cloneProfileSettings(validation.data.settings));
    }
    this.#profiles = next;
  }

  /** Replaces one complete profile settings record and persists it atomically. */
  save(username: string, settings: ProfileSettings): Promise<ProfileSettings> {
    return this.#exclusive(async () => {
      assertProfileUsername(username);
      assertProfileSettings(settings);
      const previous = this.#profiles.get(username);
      const next = cloneProfileSettings(settings);
      this.#profiles.set(username, next);
      try {
        await this.#persist(username, next);
      } catch (error) {
        if (previous === undefined) this.#profiles.delete(username);
        else this.#profiles.set(username, previous);
        throw error;
      }
      return cloneProfileSettings(next);
    });
  }

  /** Merges one complete imported settings object into the existing profile. */
  merge(username: string, settings: ProfileSettings): Promise<ProfileSettings> {
    return this.#exclusive(async () => {
      assertProfileUsername(username);
      assertProfileSettings(settings);
      const current = this.#profiles.get(username) ?? DEFAULT_PROFILE_SETTINGS;
      const next = mergeProfileSettings(current, settings);
      const previous = this.#profiles.get(username);
      this.#profiles.set(username, next);
      try {
        await this.#persist(username, next);
      } catch (error) {
        if (previous === undefined) this.#profiles.delete(username);
        else this.#profiles.set(username, previous);
        throw error;
      }
      return cloneProfileSettings(next);
    });
  }

  /** Waits for all atomic profile writes already queued by this host. */
  async flush(): Promise<void> {
    await this.#writeQueue;
  }

  /** Prevents profile writes while a repository snapshot is being inspected or replaced. */
  async beginRepositoryOperation(): Promise<() => void> {
    const result = this.#mutationQueue.then(async () => {
      if (this.#repositoryOperationActive) {
        throw new Error("Another repository snapshot operation is already running");
      }
      this.#repositoryOperationActive = true;
      await this.#writeQueue;
    });
    this.#mutationQueue = result.catch(() => undefined);
    await result;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#repositoryOperationActive = false;
    };
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutationQueue.then(async () => {
      if (this.#repositoryOperationActive) {
        throw new Error("Repository snapshot operation in progress; retry shortly");
      }
      return operation();
    });
    this.#mutationQueue = result.catch(() => undefined);
    return result;
  }

  async #persist(username: string, settings: ProfileSettings): Promise<void> {
    await ensureProfileDirectory(this.#directory);
    const path = join(this.#directory, `${username}.json`);
    const contents = serializeCanonicalJson({
      schemaVersion: PROFILE_SETTINGS_SCHEMA_VERSION,
      username,
      settings,
    });
    const temporaryPath = join(
      this.#directory,
      `.${basename(path)}.${process.pid}.${Date.now()}.${randomBytes(8).toString("hex")}.tmp`,
    );
    const operation = this.#writeQueue.then(async () => {
      try {
        await writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
        await rename(temporaryPath, path);
      } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
      }
    });
    this.#writeQueue = operation.catch(() => undefined);
    await operation;
  }
}

export function profileSettingsRelativePath(username: string): string {
  assertProfileUsername(username);
  return `${PROFILE_SETTINGS_DIRECTORY}/${username}.json`;
}

function mergeProfileSettings(
  current: ProfileSettings,
  imported: ProfileSettings,
): ProfileSettings {
  return {
    ...current,
    ...imported,
    application: { ...current.application, ...imported.application },
    drawing: {
      ...current.drawing,
      ...imported.drawing,
      pen: { ...current.drawing.pen, ...imported.drawing.pen },
      highlighter: { ...current.drawing.highlighter, ...imported.drawing.highlighter },
      shape: { ...current.drawing.shape, ...imported.drawing.shape },
    },
    drawingPalettes: {
      ...current.drawingPalettes,
      ...imported.drawingPalettes,
      pen: clonePalette(imported.drawingPalettes.pen),
      highlighter: clonePalette(imported.drawingPalettes.highlighter),
      shape: clonePalette(imported.drawingPalettes.shape),
    },
  };
}

function cloneProfileSettings(settings: ProfileSettings): ProfileSettings {
  return {
    ...settings,
    application: { ...settings.application },
    drawing: {
      ...settings.drawing,
      pen: { ...settings.drawing.pen },
      highlighter: { ...settings.drawing.highlighter },
      shape: { ...settings.drawing.shape },
    },
    drawingPalettes: {
      pen: clonePalette(settings.drawingPalettes.pen),
      highlighter: clonePalette(settings.drawingPalettes.highlighter),
      shape: clonePalette(settings.drawingPalettes.shape),
    },
    keyboardPanSpeedMultiplier: readKeyboardPanSpeedMultiplier(settings.keyboardPanSpeedMultiplier),
  };
}

function clonePalette(
  palette: ProfileSettings["drawingPalettes"]["pen"],
): ProfileSettings["drawingPalettes"]["pen"] {
  return { ...palette, slots: palette.slots.map((slot) => ({ ...slot })) };
}

async function ensureProfileDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const status = await lstat(directory);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error("The profile settings path must be a real directory");
  }
}

function profileUsernameFromFilename(filename: string): string | undefined {
  if (!filename.endsWith(".json")) return undefined;
  const username = filename.slice(0, -".json".length);
  return isProfileUsername(username) ? username : undefined;
}

function assertProfileUsername(username: string): void {
  if (!isProfileUsername(username)) throw new Error("Profile name is invalid");
}

function assertProfileSettings(settings: unknown): asserts settings is ProfileSettings {
  if (!isProfileSettings(settings)) throw new Error("Profile settings are invalid");
}

function formatIssues(issues: readonly { path: string; message: string }[]): string {
  return issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
