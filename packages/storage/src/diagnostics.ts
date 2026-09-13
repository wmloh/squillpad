import { lstat, readFile, readdir, rm, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { validateCanvasRecords } from "@squillpad/core-model";

const RUNTIME_DIRECTORY = ".squillpad-runtime";
const RUNTIME_SYNC_DIRECTORY = "sync";

export interface ProjectStorageDiagnostics {
  readonly canonicalBytes: number;
  readonly canonicalFileCount: number;
  readonly runtimeCacheBytes: number;
  readonly runtimeCacheFileCount: number;
  readonly measuredAt: string;
}

export interface RuntimeCacheCleanupResult {
  readonly removedBytes: number;
  readonly removedFileCount: number;
}

export interface OrphanAssetCleanupResult {
  readonly removedBytes: number;
  readonly removedFileCount: number;
}

/** Removes only page-local image assets not referenced by that page's canvas JSONL. */
export async function cleanupOrphanImageAssets(
  projectRoot: string,
): Promise<OrphanAssetCleanupResult> {
  const root = await validateProjectRoot(projectRoot);
  const sections = await readOptionalDirectory(join(root, "sections"));
  const orphaned: { readonly path: string; readonly size: number }[] = [];
  for (const section of sections) {
    if (!section.isDirectory() || !UUID_PATTERN.test(section.name)) continue;
    const pagesDirectory = join(root, "sections", section.name, "pages");
    await assertOptionalRealDirectory(pagesDirectory, root);
    for (const page of await readOptionalDirectory(pagesDirectory)) {
      if (!page.isDirectory() || !UUID_PATTERN.test(page.name)) continue;
      const pageDirectory = join(pagesDirectory, page.name);
      const canvasSource = await readFile(join(pageDirectory, "canvas.jsonl"), "utf8");
      const parsed = canvasSource
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as unknown);
      const validation = validateCanvasRecords(parsed);
      if (!validation.success) {
        throw new Error(
          `Cannot safely clean image assets because ${join(pageDirectory, "canvas.jsonl")} is invalid`,
        );
      }
      const referenced = new Set<string>();
      for (const record of validation.data) {
        if (record.kind === "image") referenced.add(record.asset);
      }
      const assetsDirectory = join(pageDirectory, "assets");
      await assertOptionalRealDirectory(assetsDirectory, root);
      for (const asset of await readOptionalDirectory(assetsDirectory)) {
        if (!asset.isFile() || !ASSET_FILENAME_PATTERN.test(asset.name)) continue;
        if (referenced.has(`assets/${asset.name}`)) continue;
        const assetPath = join(assetsDirectory, asset.name);
        const stats = await lstat(assetPath);
        orphaned.push({ path: assetPath, size: stats.size });
      }
    }
  }
  for (const asset of orphaned) await unlink(asset.path);
  return {
    removedBytes: orphaned.reduce((total, asset) => total + asset.size, 0),
    removedFileCount: orphaned.length,
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ASSET_FILENAME_PATTERN = /^[0-9a-f]{64}\.(?:png|jpe?g|gif|webp)$/;

/** Measures canonical project files and disposable runtime files independently. */
export async function inspectProjectStorage(
  projectRoot: string,
): Promise<ProjectStorageDiagnostics> {
  const root = await validateProjectRoot(projectRoot);
  const canonical = await measureDirectory(root, true);
  const runtime = await measureOptionalDirectory(join(root, RUNTIME_DIRECTORY));
  return {
    canonicalBytes: canonical.bytes,
    canonicalFileCount: canonical.fileCount,
    runtimeCacheBytes: runtime.bytes,
    runtimeCacheFileCount: runtime.fileCount,
    measuredAt: new Date().toISOString(),
  };
}

/** Removes only synchronization history below the disposable runtime directory. */
export async function cleanupRuntimeCache(
  projectRoot: string,
  preservedFiles: ReadonlySet<string> = new Set(),
): Promise<RuntimeCacheCleanupResult> {
  const root = await validateProjectRoot(projectRoot);
  const runtime = join(root, RUNTIME_DIRECTORY);
  const sync = join(runtime, RUNTIME_SYNC_DIRECTORY);
  await assertOptionalRealDirectory(runtime, root);
  await assertOptionalRealDirectory(sync, root);
  await measureOptionalDirectory(sync);
  let removedBytes = 0;
  let removedFileCount = 0;
  const entries = await readOptionalDirectory(sync);
  for (const entry of entries) {
    if (preservedFiles.has(entry.name)) continue;
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Runtime cache cleanup will not follow symbolic links: ${join(sync, entry.name)}`,
      );
    }
    const path = join(sync, entry.name);
    const size = entry.isDirectory()
      ? await measureDirectory(path, false)
      : { bytes: (await lstat(path)).size, fileCount: 1 };
    await rm(path, { force: true, recursive: true });
    removedBytes += size.bytes;
    removedFileCount += size.fileCount;
  }
  return { removedBytes, removedFileCount };
}

interface SizeTotal {
  readonly bytes: number;
  readonly fileCount: number;
}

async function measureDirectory(directory: string, skipRuntimeAtRoot: boolean): Promise<SizeTotal> {
  let bytes = 0;
  let fileCount = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (skipRuntimeAtRoot && entry.name === RUNTIME_DIRECTORY) continue;
    if (entry.name === ".git") continue;
    const entryPath = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Storage diagnostics do not follow symbolic links: ${entryPath}`);
    }
    if (entry.isDirectory()) {
      const nested = await measureDirectory(entryPath, false);
      bytes += nested.bytes;
      fileCount += nested.fileCount;
    } else if (entry.isFile()) {
      const stats = await lstat(entryPath);
      bytes += stats.size;
      fileCount += 1;
    }
  }
  return { bytes, fileCount };
}

async function measureOptionalDirectory(directory: string): Promise<SizeTotal> {
  try {
    const stats = await lstat(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`Runtime cache path must be a real directory: ${directory}`);
    }
    return measureDirectory(directory, false);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return { bytes: 0, fileCount: 0 };
    throw error;
  }
}

async function readOptionalDirectory(directory: string) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return [];
    throw error;
  }
}

async function assertOptionalRealDirectory(directory: string, root: string): Promise<void> {
  if (!isWithin(root, directory)) throw new Error("Cleanup path escaped the project root");
  try {
    const stats = await lstat(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`Cleanup path must be a real directory: ${directory}`);
    }
  } catch (error) {
    if (!isFileSystemError(error, "ENOENT")) throw error;
  }
}

async function validateProjectRoot(projectRoot: string): Promise<string> {
  if (!isAbsolute(projectRoot)) throw new Error("Project root must be an absolute path");
  const root = resolve(projectRoot);
  const stats = await lstat(root);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("Project root must be a real directory");
  }
  return root;
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot))
  );
}

function isFileSystemError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
