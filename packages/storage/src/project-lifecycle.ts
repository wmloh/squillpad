import { constants as fsConstants } from "node:fs";
import { execFile as execFileCallback } from "node:child_process";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import {
  CANONICAL_SCHEMA_VERSION,
  serializeCanonicalJson,
  validateCanvasRecords,
  validateNotebookManifest,
  validatePageManifest,
  validateProfileSettingsRecord,
  validateSectionManifest,
  type CanonicalMigrationRegistry,
  type CanvasRecord,
  type NotebookManifest,
  type PageManifest,
  type SectionManifest,
} from "@squillpad/core-model";

import {
  CanonicalStorageError,
  FileSystemProjectStorage,
  type ProjectStorage,
  type StoredPage,
  type StoredPageContent,
} from "./index.js";
import {
  cleanupOrphanImageAssets as cleanupProjectOrphanImageAssets,
  cleanupRuntimeCache as cleanupProjectRuntimeCache,
  inspectProjectStorage,
  type OrphanAssetCleanupResult,
  type ProjectStorageDiagnostics,
  type RuntimeCacheCleanupResult,
} from "./diagnostics.js";

const RUNTIME_DIRECTORY = ".squillpad-runtime";
const LOCK_FILENAME = "project.lock";
const RUNTIME_IGNORE_CONTENT = "*\n";
const PROJECT_GITIGNORE_CONTENT = `# SquillPad disposable runtime state
.squillpad-runtime/

# Temporary, cache, log, and packaged output files
*.tmp
*.log
*.lock
.cache/
coverage/
dist/
out/
build/
node_modules/
playwright-report/
test-results/
.vite/
*.tsbuildinfo
.DS_Store
Thumbs.db
`;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const TEMPORARY_FILENAME_PATTERN = /^\.(.+)\.\d+\.\d+\.[0-9a-f]+\.tmp$/;

export type ProjectLifecycleErrorCode =
  | "invalid-path"
  | "malformed-project"
  | "permissions"
  | "project-locked"
  | "session-closed"
  | "target-not-empty"
  | "unsupported-schema";

/** Actionable failure raised while creating, opening, or closing a project. */
export class ProjectLifecycleError extends Error {
  readonly code: ProjectLifecycleErrorCode;
  readonly filePath: string;
  override readonly cause: unknown;

  constructor(code: ProjectLifecycleErrorCode, message: string, filePath: string, cause?: unknown) {
    super(message);
    this.name = "ProjectLifecycleError";
    this.code = code;
    this.filePath = filePath;
    this.cause = cause;
  }
}

export interface CreateProjectOptions {
  readonly title?: string;
  readonly starterSectionTitle?: string;
  readonly starterPageTitle?: string;
  readonly initializeGit?: boolean;
}

export interface OpenProjectOptions {
  readonly migrations?: CanonicalMigrationRegistry;
}

interface LockRecord {
  readonly createdAt: string;
  readonly hostname: string;
  readonly pid: number;
  readonly sessionId: string;
}

interface HeldLock {
  readonly filePath: string;
  readonly record: LockRecord;
}

/** A locked project session whose writes are flushed before its lock is released. */
export class ProjectSession implements ProjectStorage {
  readonly projectRoot: string;
  readonly #storage: FileSystemProjectStorage;
  readonly #lock: HeldLock;
  readonly #pendingWrites = new Set<Promise<unknown>>();
  #state: "open" | "closing" | "closed" = "open";
  #closePromise: Promise<void> | undefined;

  constructor(projectRoot: string, storage: FileSystemProjectStorage, lock: HeldLock) {
    this.projectRoot = projectRoot;
    this.#storage = storage;
    this.#lock = lock;
  }

  loadNotebook(): Promise<NotebookManifest> {
    this.#assertOpen();
    return this.#storage.loadNotebook();
  }

  loadSection(sectionId: string): Promise<SectionManifest> {
    this.#assertOpen();
    return this.#storage.loadSection(sectionId);
  }

  loadPageManifest(sectionId: string, pageId: string): Promise<PageManifest> {
    this.#assertOpen();
    return this.#storage.loadPageManifest(sectionId, pageId);
  }

  loadPage(sectionId: string, pageId: string): Promise<StoredPage> {
    this.#assertOpen();
    return this.#storage.loadPage(sectionId, pageId);
  }

  loadMarkdown(sectionId: string, pageId: string, objectId: string): Promise<string> {
    this.#assertOpen();
    return this.#storage.loadMarkdown(sectionId, pageId, objectId);
  }

  loadCanvas(sectionId: string, pageId: string): Promise<readonly CanvasRecord[]> {
    this.#assertOpen();
    return this.#storage.loadCanvas(sectionId, pageId);
  }

  loadImageAsset(sectionId: string, pageId: string, asset: string): Promise<Uint8Array> {
    this.#assertOpen();
    return this.#storage.loadImageAsset(sectionId, pageId, asset);
  }

  saveNotebook(notebook: NotebookManifest): Promise<void> {
    return this.#trackWrite(() => this.#storage.saveNotebook(notebook));
  }

  saveSection(section: SectionManifest): Promise<void> {
    return this.#trackWrite(() => this.#storage.saveSection(section));
  }

  savePageManifest(sectionId: string, page: PageManifest): Promise<void> {
    return this.#trackWrite(() => this.#storage.savePageManifest(sectionId, page));
  }

  savePage(sectionId: string, page: StoredPage): Promise<void> {
    return this.#trackWrite(() => this.#storage.savePage(sectionId, page));
  }

  savePageContent(sectionId: string, pageId: string, content: StoredPageContent): Promise<void> {
    return this.#trackWrite(() => this.#storage.savePageContent(sectionId, pageId, content));
  }

  saveMarkdown(
    sectionId: string,
    pageId: string,
    objectId: string,
    markdown: string,
  ): Promise<void> {
    return this.#trackWrite(() =>
      this.#storage.saveMarkdown(sectionId, pageId, objectId, markdown),
    );
  }

  saveCanvas(sectionId: string, pageId: string, records: readonly CanvasRecord[]): Promise<void> {
    return this.#trackWrite(() => this.#storage.saveCanvas(sectionId, pageId, records));
  }

  saveImageAsset(sectionId: string, pageId: string, bytes: Uint8Array): Promise<string> {
    return this.#trackWrite(() => this.#storage.saveImageAsset(sectionId, pageId, bytes));
  }

  /** Reports canonical and disposable runtime bytes for the open project. */
  storageDiagnostics(): Promise<ProjectStorageDiagnostics> {
    this.#assertOpen();
    return inspectProjectStorage(this.projectRoot);
  }

  /** Removes only disposable synchronization history while preserving the project lock. */
  cleanupRuntimeCache(): Promise<RuntimeCacheCleanupResult> {
    this.#assertOpen();
    return cleanupProjectRuntimeCache(this.projectRoot);
  }

  /** Removes verified unreferenced page-local image assets across the project. */
  cleanupOrphanImageAssets(): Promise<OrphanAssetCleanupResult> {
    this.#assertOpen();
    return cleanupProjectOrphanImageAssets(this.projectRoot);
  }

  /** Flushes in-flight canonical writes, then releases the owned project lock. */
  close(): Promise<void> {
    if (this.#state === "closed") return Promise.resolve();
    if (this.#closePromise !== undefined) return this.#closePromise;

    this.#state = "closing";
    this.#closePromise = this.#finishClose();
    return this.#closePromise;
  }

  async #finishClose(): Promise<void> {
    try {
      await Promise.all([...this.#pendingWrites]);
      await releaseLock(this.#lock);
      this.#state = "closed";
    } catch (error) {
      this.#state = "open";
      this.#closePromise = undefined;
      throw lifecycleError(error, this.projectRoot, "close the project");
    }
  }

  #assertOpen(): void {
    if (this.#state !== "open") {
      throw new ProjectLifecycleError(
        "session-closed",
        "This project session is closing or closed; open a new session before accessing it.",
        this.projectRoot,
      );
    }
  }

  #trackWrite<T>(operation: () => Promise<T>): Promise<T> {
    this.#assertOpen();
    const pending = operation();
    this.#pendingWrites.add(pending);
    void pending.then(
      () => this.#pendingWrites.delete(pending),
      () => this.#pendingWrites.delete(pending),
    );
    return pending;
  }
}

/** Creates a valid starter project and returns it with an exclusive session lock. */
export async function createProject(
  projectRoot: string,
  options: CreateProjectOptions = {},
): Promise<ProjectSession> {
  const root = validateAbsoluteRoot(projectRoot);
  await prepareEmptyProjectRoot(root);
  const lock = await acquireLock(root);
  const storage = new FileSystemProjectStorage(root);
  const sectionId = randomUUID();
  const pageId = randomUUID();
  const notebook: NotebookManifest = {
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    projectId: randomUUID(),
    title: options.title ?? "Untitled Project",
    sectionIds: [sectionId],
    settings: { defaultZoom: 1, metadata: {} },
  };
  const section: SectionManifest = {
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    id: sectionId,
    title: options.starterSectionTitle ?? "Section 1",
    pageIds: [pageId],
    metadata: {},
  };
  const page: StoredPage = {
    manifest: {
      schemaVersion: CANONICAL_SCHEMA_VERSION,
      id: pageId,
      title: options.starterPageTitle ?? "Untitled Page",
      metadata: {},
    },
    canvas: [],
    markdown: {},
  };

  try {
    await writeProjectGitignore(root);
    await storage.saveNotebook(notebook);
    await storage.saveSection(section);
    await storage.savePage(sectionId, page);
    if (options.initializeGit === true) await initializeGitRepository(root);
    return new ProjectSession(root, storage, lock);
  } catch (error) {
    await releaseLock(lock).catch(() => undefined);
    throw lifecycleError(error, root, "create the project");
  }
}

async function writeProjectGitignore(root: string): Promise<void> {
  const filePath = join(root, ".gitignore");
  try {
    await writeFile(filePath, PROJECT_GITIGNORE_CONTENT, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (!isFileSystemError(error, "EEXIST")) throw error;
  }
}

async function initializeGitRepository(root: string): Promise<void> {
  try {
    await promisify(execFileCallback)("git", ["init", "--quiet"], { cwd: root });
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return;
    throw error;
  }
}

/** Opens and fully validates a project before exposing a locked writable session. */
export async function openProject(
  projectRoot: string,
  options: OpenProjectOptions = {},
): Promise<ProjectSession> {
  const root = validateAbsoluteRoot(projectRoot);
  await assertExistingProjectRoot(root);
  const lock = await acquireLock(root);
  const storage = new FileSystemProjectStorage(root, options.migrations);
  try {
    await recoverInterruptedWrites(root);
    await validateProject(storage);
    return new ProjectSession(root, storage, lock);
  } catch (error) {
    await releaseLock(lock).catch(() => undefined);
    throw lifecycleError(error, root, "open the project");
  }
}

async function validateProject(storage: FileSystemProjectStorage): Promise<void> {
  const notebook = await storage.loadNotebook();
  const pageIds = new Set<string>();
  for (const sectionId of notebook.sectionIds) {
    const section = await storage.loadSection(sectionId);
    for (const pageId of section.pageIds) {
      if (pageIds.has(pageId)) {
        throw new CanonicalStorageError(
          `Page ID ${pageId} is referenced by more than one section`,
          pageId,
        );
      }
      pageIds.add(pageId);
      await storage.loadPage(sectionId, pageId);
    }
  }
}

async function prepareEmptyProjectRoot(root: string): Promise<void> {
  try {
    const status = await lstat(root);
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new ProjectLifecycleError(
        "invalid-path",
        "The project path must be a real directory, not a file or symbolic link.",
        root,
      );
    }
    if ((await readdir(root)).length > 0) {
      throw new ProjectLifecycleError(
        "target-not-empty",
        "The project directory is not empty. Choose a missing or empty directory.",
        root,
      );
    }
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) {
      try {
        await mkdir(root, { recursive: true });
        return;
      } catch (mkdirError) {
        throw lifecycleError(mkdirError, root, "create the project directory");
      }
    }
    if (error instanceof ProjectLifecycleError) throw error;
    throw lifecycleError(error, root, "inspect the project directory");
  }
}

async function assertExistingProjectRoot(root: string): Promise<void> {
  try {
    const status = await lstat(root);
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new ProjectLifecycleError(
        "invalid-path",
        "The project path must be an existing real directory, not a file or symbolic link.",
        root,
      );
    }
  } catch (error) {
    if (error instanceof ProjectLifecycleError) throw error;
    if (isFileSystemError(error, "ENOENT")) {
      throw new ProjectLifecycleError(
        "invalid-path",
        "The project directory does not exist. Create it before opening it.",
        root,
        error,
      );
    }
    throw lifecycleError(error, root, "inspect the project directory");
  }
}

async function acquireLock(root: string): Promise<HeldLock> {
  const runtimePath = join(root, RUNTIME_DIRECTORY);
  const lockPath = join(runtimePath, LOCK_FILENAME);
  await prepareRuntimeDirectory(runtimePath);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const record: LockRecord = {
      createdAt: new Date().toISOString(),
      hostname: hostname(),
      pid: process.pid,
      sessionId: randomUUID(),
    };
    try {
      await publishLock(lockPath, runtimePath, record);
      return { filePath: lockPath, record };
    } catch (error) {
      if (!isFileSystemError(error, "EEXIST")) {
        throw lifecycleError(error, lockPath, "acquire the project lock");
      }
      const existing = await readLock(lockPath);
      if (existing !== undefined && !isProvablyStale(existing)) {
        throw new ProjectLifecycleError(
          "project-locked",
          `Project is already open by process ${existing.pid} on ${existing.hostname} since ${existing.createdAt}. Close that session before opening it again.`,
          lockPath,
        );
      }
      await quarantineStaleLock(lockPath, runtimePath);
    }
  }
  throw new ProjectLifecycleError(
    "project-locked",
    "The project lock changed repeatedly while opening. Wait for the other host process to finish and try again.",
    lockPath,
  );
}

async function publishLock(
  lockPath: string,
  runtimePath: string,
  record: LockRecord,
): Promise<void> {
  const candidatePath = join(runtimePath, `.lock-candidate.${record.sessionId}`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      candidatePath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    await handle.writeFile(serializeCanonicalJson(record), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(candidatePath, lockPath);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(candidatePath).catch(() => undefined);
  }
}

async function prepareRuntimeDirectory(runtimePath: string): Promise<void> {
  try {
    await mkdir(runtimePath, { recursive: true });
    const status = await lstat(runtimePath);
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new ProjectLifecycleError(
        "invalid-path",
        "The project runtime path must be a real directory.",
        runtimePath,
      );
    }
    await writeFile(join(runtimePath, ".gitignore"), RUNTIME_IGNORE_CONTENT, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    }).catch((error: unknown) => {
      if (!isFileSystemError(error, "EEXIST")) throw error;
    });
  } catch (error) {
    if (error instanceof ProjectLifecycleError) throw error;
    throw lifecycleError(error, runtimePath, "prepare the ignored runtime directory");
  }
}

async function readLock(lockPath: string): Promise<LockRecord | undefined> {
  try {
    const status = await lstat(lockPath);
    if (!status.isFile() || status.nlink !== 1) {
      throw new ProjectLifecycleError(
        "invalid-path",
        "Project lock must be a regular file without links.",
        lockPath,
      );
    }
    const parsed: unknown = JSON.parse(await readFile(lockPath, "utf8"));
    if (!isLockRecord(parsed)) return undefined;
    return parsed;
  } catch (error) {
    if (isFileSystemError(error, "ENOENT") || error instanceof SyntaxError) return undefined;
    throw lifecycleError(error, lockPath, "read the existing project lock");
  }
}

function isLockRecord(value: unknown): value is LockRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.createdAt === "string" &&
    !Number.isNaN(Date.parse(record.createdAt)) &&
    typeof record.hostname === "string" &&
    Number.isSafeInteger(record.pid) &&
    (record.pid as number) > 0 &&
    typeof record.sessionId === "string" &&
    new RegExp(`^${UUID_PATTERN}$`).test(record.sessionId)
  );
}

function isProvablyStale(lock: LockRecord): boolean {
  if (lock.hostname !== hostname()) return false;
  try {
    process.kill(lock.pid, 0);
    return false;
  } catch (error) {
    return isFileSystemError(error, "ESRCH");
  }
}

async function quarantineStaleLock(lockPath: string, runtimePath: string): Promise<void> {
  const quarantinePath = join(runtimePath, `.stale-lock.${randomUUID()}`);
  try {
    await rename(lockPath, quarantinePath);
    await unlink(quarantinePath);
  } catch (error) {
    if (!isFileSystemError(error, "ENOENT")) {
      throw lifecycleError(error, lockPath, "recover the stale project lock");
    }
  }
}

async function releaseLock(lock: HeldLock): Promise<void> {
  const existing = await readLock(lock.filePath);
  if (existing === undefined) {
    throw new ProjectLifecycleError(
      "project-locked",
      "The project lock disappeared or became malformed before shutdown; it was not safe to release.",
      lock.filePath,
    );
  }
  if (existing.sessionId !== lock.record.sessionId) {
    throw new ProjectLifecycleError(
      "project-locked",
      "The project lock is now owned by another session; it was not removed.",
      lock.filePath,
    );
  }
  await unlink(lock.filePath);
}

async function recoverInterruptedWrites(root: string): Promise<void> {
  const temporaryFiles = await findCanonicalTemporaryFiles(root, root);
  const grouped = new Map<string, string[]>();
  for (const temporaryPath of temporaryFiles) {
    const targetPath = temporaryTargetPath(temporaryPath, root);
    if (targetPath === undefined) continue;
    const entries = grouped.get(targetPath) ?? [];
    entries.push(temporaryPath);
    grouped.set(targetPath, entries);
  }

  for (const [targetPath, candidates] of grouped) {
    if (await pathExists(targetPath)) {
      await Promise.all(candidates.map((candidate) => unlink(candidate)));
      continue;
    }
    if (candidates.length !== 1) {
      throw new ProjectLifecycleError(
        "malformed-project",
        `Multiple interrupted writes could restore ${targetPath}. Keep the intended file and remove the other temporary files before reopening.`,
        targetPath,
      );
    }
    const candidate = candidates[0] as string;
    await validateTemporaryFile(candidate, targetPath, root);
    await rename(candidate, targetPath);
  }
}

async function findCanonicalTemporaryFiles(root: string, directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new ProjectLifecycleError(
        "malformed-project",
        "Symbolic links are not allowed inside a canonical project.",
        entryPath,
      );
    }
    if (entry.isDirectory()) {
      if (entryPath !== join(root, RUNTIME_DIRECTORY)) {
        found.push(...(await findCanonicalTemporaryFiles(root, entryPath)));
      }
    } else if (entry.isFile() && TEMPORARY_FILENAME_PATTERN.test(entry.name)) {
      found.push(entryPath);
    }
  }
  return found;
}

function temporaryTargetPath(temporaryPath: string, root: string): string | undefined {
  const match = TEMPORARY_FILENAME_PATTERN.exec(basename(temporaryPath));
  const targetName = match?.[1];
  if (targetName === undefined) return undefined;
  const targetPath = join(dirname(temporaryPath), targetName);
  const projectRelative = relative(root, targetPath).split(sep).join("/");
  const canonicalPatterns = [
    /^notebook\.json$/,
    new RegExp(`^sections/${UUID_PATTERN}/section\\.json$`),
    new RegExp(`^sections/${UUID_PATTERN}/pages/${UUID_PATTERN}/(?:page\\.json|canvas\\.jsonl)$`),
    new RegExp(`^sections/${UUID_PATTERN}/pages/${UUID_PATTERN}/markdown/${UUID_PATTERN}\\.md$`),
    /^profiles\/[a-z0-9][a-z0-9._-]{2,31}\.json$/,
  ];
  return canonicalPatterns.some((pattern) => pattern.test(projectRelative))
    ? targetPath
    : undefined;
}

async function validateTemporaryFile(
  filePath: string,
  targetPath: string,
  root: string,
): Promise<void> {
  const targetName = basename(targetPath);
  const targetRelative = relative(root, targetPath).split(sep).join("/");
  let source: string;
  try {
    source = UTF8_DECODER.decode(await readFile(filePath));
  } catch (error) {
    throw new ProjectLifecycleError(
      "malformed-project",
      `Interrupted write ${filePath} is not valid UTF-8 and cannot be recovered automatically.`,
      filePath,
      error,
    );
  }
  if (targetName.endsWith(".md")) return;

  let parsed: unknown;
  try {
    parsed =
      targetName === "canvas.jsonl"
        ? parseJsonLinesForRecovery(source)
        : (JSON.parse(source) as unknown);
  } catch (error) {
    throw new ProjectLifecycleError(
      "malformed-project",
      `Interrupted write ${filePath} is malformed and cannot be recovered automatically.`,
      filePath,
      error,
    );
  }
  const profileResult = targetRelative.startsWith("profiles/")
    ? validateProfileSettingsRecord(parsed)
    : undefined;
  const result =
    targetName === "notebook.json"
      ? validateNotebookManifest(parsed)
      : targetName === "section.json"
        ? validateSectionManifest(parsed)
        : targetName === "page.json"
          ? validatePageManifest(parsed)
          : (profileResult ?? validateCanvasRecords(parsed));
  if (!result.success) {
    throw new ProjectLifecycleError(
      "malformed-project",
      `Interrupted write ${filePath} failed canonical validation and was left in place for manual recovery.`,
      filePath,
    );
  }
  if (
    profileResult?.success === true &&
    profileResult.data.username !== targetName.slice(0, -".json".length)
  ) {
    throw new ProjectLifecycleError(
      "malformed-project",
      `Interrupted write ${filePath} has a profile identity that does not match its target filename and was left in place for manual recovery.`,
      filePath,
    );
  }
}

function parseJsonLinesForRecovery(source: string): unknown[] {
  if (source === "") return [];
  const lines = source.endsWith("\n") ? source.slice(0, -1).split("\n") : source.split("\n");
  if (lines.some((line) => line.length === 0)) throw new SyntaxError("Blank JSONL record");
  return lines.map((line) => JSON.parse(line) as unknown);
}

function validateAbsoluteRoot(projectRoot: string): string {
  if (!isAbsolute(projectRoot)) {
    throw new ProjectLifecycleError(
      "invalid-path",
      "Project paths must be absolute so lifecycle operations cannot target an unexpected directory.",
      projectRoot,
    );
  }
  return resolve(projectRoot);
}

function lifecycleError(
  error: unknown,
  filePath: string,
  operation: string,
): ProjectLifecycleError {
  if (error instanceof ProjectLifecycleError) return error;
  if (isPermissionError(error)) {
    return new ProjectLifecycleError(
      "permissions",
      `Unable to ${operation} because ${filePath} is not writable or accessible. Check its permissions and try again.`,
      filePath,
      error,
    );
  }
  if (error instanceof CanonicalStorageError) {
    const unsupported = error.message.startsWith("Unsupported ");
    return new ProjectLifecycleError(
      unsupported ? "unsupported-schema" : "malformed-project",
      unsupported
        ? `${error.message}. Upgrade SquillPad or open the project with a compatible version.`
        : `${error.message}. Repair the referenced canonical file and try again.`,
      error.filePath,
      error,
    );
  }
  return new ProjectLifecycleError(
    "malformed-project",
    `Unable to ${operation}: ${errorMessage(error)}. Inspect ${filePath} and try again.`,
    filePath,
    error,
  );
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return false;
    throw error;
  }
}

function isPermissionError(error: unknown): boolean {
  return ["EACCES", "EPERM", "EROFS"].some((code) => isFileSystemError(error, code));
}

function isFileSystemError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
