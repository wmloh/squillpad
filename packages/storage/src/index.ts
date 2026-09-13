import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export * from "./project-lifecycle.js";
export * from "./hierarchy.js";
export * from "./diagnostics.js";
export * from "./profile-settings.js";

import {
  CANONICAL_SCHEMA_VERSION,
  serializeCanonicalJson,
  serializeCanvasJsonLines,
  validateCanvasRecords,
  validateNotebookManifest,
  validatePageManifest,
  validateSectionManifest,
  type CanonicalDocumentKind,
  type CanonicalMigrationRegistry,
  type CanvasRecord,
  type NotebookManifest,
  type PageManifest,
  type SectionManifest,
  type ValidationIssue,
  type ValidationResult,
} from "@squillpad/core-model";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

/** Error raised when canonical project content or a requested path is unsafe. */
export class CanonicalStorageError extends Error {
  readonly filePath: string;
  readonly issues: readonly ValidationIssue[];

  constructor(message: string, filePath: string, issues: readonly ValidationIssue[] = []) {
    super(message);
    this.name = "CanonicalStorageError";
    this.filePath = filePath;
    this.issues = issues;
  }
}

/** Fully loaded page data, with Markdown source keyed by permanent object ID. */
export interface StoredPage {
  readonly manifest: PageManifest;
  readonly canvas: readonly CanvasRecord[];
  readonly markdown: Readonly<Record<string, string>>;
}

/** Editable page content that can be persisted without rewriting its manifest. */
export interface StoredPageContent {
  readonly canvas: readonly CanvasRecord[];
  readonly markdown: Readonly<Record<string, string>>;
}

/** Optional hooks used by tests and host integrations around atomic canonical writes. */
export interface FileSystemProjectStorageOptions {
  readonly beforeAtomicWrite?: (relativePath: string, contents: string) => void | Promise<void>;
}

/** Typed persistence contract independent of browser UI code. */
export interface ProjectStorage {
  loadNotebook(): Promise<NotebookManifest>;
  loadSection(sectionId: string): Promise<SectionManifest>;
  loadPageManifest(sectionId: string, pageId: string): Promise<PageManifest>;
  loadPage(sectionId: string, pageId: string): Promise<StoredPage>;
  loadMarkdown(sectionId: string, pageId: string, objectId: string): Promise<string>;
  loadCanvas(sectionId: string, pageId: string): Promise<readonly CanvasRecord[]>;
  loadImageAsset(sectionId: string, pageId: string, asset: string): Promise<Uint8Array>;
  saveNotebook(notebook: NotebookManifest): Promise<void>;
  saveSection(section: SectionManifest): Promise<void>;
  savePageManifest(sectionId: string, page: PageManifest): Promise<void>;
  savePage(sectionId: string, page: StoredPage): Promise<void>;
  savePageContent(sectionId: string, pageId: string, content: StoredPageContent): Promise<void>;
  saveMarkdown(
    sectionId: string,
    pageId: string,
    objectId: string,
    markdown: string,
  ): Promise<void>;
  saveCanvas(sectionId: string, pageId: string, records: readonly CanvasRecord[]): Promise<void>;
  saveImageAsset(sectionId: string, pageId: string, bytes: Uint8Array): Promise<string>;
}

/** Executes adjacent migrations without mutating the supplied document. */
export function migrateCanonicalDocument(
  documentKind: CanonicalDocumentKind,
  document: unknown,
  registry: CanonicalMigrationRegistry,
): unknown {
  let migrated = document;
  let version = readSchemaVersion(document, documentKind);
  if (version > CANONICAL_SCHEMA_VERSION) {
    throw new CanonicalStorageError(
      `Unsupported ${documentKind} schema version ${version}`,
      documentKind,
    );
  }

  while (version < CANONICAL_SCHEMA_VERSION) {
    const candidates = registry.filter(
      (step) => step.documentKind === documentKind && step.fromVersion === version,
    );
    const step = candidates[0];
    if (candidates.length !== 1 || step?.toVersion !== version + 1) {
      throw new CanonicalStorageError(
        `No unambiguous ${documentKind} migration from schema version ${version}`,
        documentKind,
      );
    }
    migrated = step.migrate(migrated);
    const nextVersion = readSchemaVersion(migrated, documentKind);
    if (nextVersion !== version + 1) {
      throw new CanonicalStorageError(
        `${documentKind} migration ${version} -> ${version + 1} produced version ${nextVersion}`,
        documentKind,
      );
    }
    version = nextVersion;
  }
  return migrated;
}

/** Node filesystem implementation of canonical project persistence. */
export class FileSystemProjectStorage implements ProjectStorage {
  readonly #projectRoot: string;
  readonly #migrations: CanonicalMigrationRegistry;
  readonly #options: FileSystemProjectStorageOptions;
  #realProjectRoot: string | undefined;

  constructor(
    projectRoot: string,
    migrations: CanonicalMigrationRegistry = [],
    options: FileSystemProjectStorageOptions = {},
  ) {
    if (!isAbsolute(projectRoot)) {
      throw new CanonicalStorageError("Project root must be an absolute path", projectRoot);
    }
    this.#projectRoot = resolve(projectRoot);
    this.#migrations = migrations;
    this.#options = options;
  }

  async loadNotebook(): Promise<NotebookManifest> {
    const filePath = await this.#safeExistingPath("notebook.json");
    return this.#loadJson(filePath, "notebook", validateNotebookManifest);
  }

  async loadSection(sectionId: string): Promise<SectionManifest> {
    assertStableId(sectionId, "section ID");
    const filePath = await this.#safeExistingPath(sectionManifestPath(sectionId));
    const section = await this.#loadJson(filePath, "section", validateSectionManifest);
    if (section.id !== sectionId) throw identityMismatch(filePath, sectionId, section.id);
    return section;
  }

  async loadPage(sectionId: string, pageId: string): Promise<StoredPage> {
    const manifest = await this.loadPageManifest(sectionId, pageId);
    const canvas = await this.loadCanvas(sectionId, pageId);
    const markdownEntries: readonly (readonly [string, string])[] = await Promise.all(
      canvas
        .filter((record) => record.kind === "markdown")
        .map(async (record) => {
          const source = await this.loadMarkdown(sectionId, pageId, record.id);
          return [record.id, source] as const;
        }),
    );
    const markdown: Record<string, string> = {};
    for (const [objectId, source] of markdownEntries) markdown[objectId] = source;
    return { manifest, canvas, markdown };
  }

  async loadPageManifest(sectionId: string, pageId: string): Promise<PageManifest> {
    validateHierarchyIds(sectionId, pageId);
    const filePath = await this.#safeExistingPath(pageManifestPath(sectionId, pageId));
    const page = await this.#loadJson(filePath, "page", validatePageManifest);
    if (page.id !== pageId) throw identityMismatch(filePath, pageId, page.id);
    return page;
  }

  async loadMarkdown(sectionId: string, pageId: string, objectId: string): Promise<string> {
    validateHierarchyIds(sectionId, pageId);
    assertStableId(objectId, "Markdown object ID");
    const filePath = await this.#safeExistingPath(markdownPath(sectionId, pageId, objectId));
    return readUtf8(filePath);
  }

  async loadCanvas(sectionId: string, pageId: string): Promise<readonly CanvasRecord[]> {
    validateHierarchyIds(sectionId, pageId);
    const filePath = await this.#safeExistingPath(canvasPath(sectionId, pageId));
    const source = await readUtf8(filePath);
    const records = parseJsonLines(source, filePath);
    return validated(filePath, validateCanvasRecords(records));
  }

  async loadImageAsset(sectionId: string, pageId: string, asset: string): Promise<Uint8Array> {
    validateHierarchyIds(sectionId, pageId);
    assertImageAssetPath(asset);
    const bytes = new Uint8Array(
      await readFile(await this.#safeExistingPath(pageAssetPath(sectionId, pageId, asset))),
    );
    if (bytes.byteLength === 0 || bytes.byteLength > 25 * 1024 * 1024) {
      throw new CanonicalStorageError("Image assets must be between 1 byte and 25 MiB", asset);
    }
    const extension = rasterExtension(bytes);
    const storedExtension = asset.slice(asset.lastIndexOf(".") + 1);
    if (storedExtension !== extension && !(storedExtension === "jpeg" && extension === "jpg")) {
      throw new CanonicalStorageError("Image asset extension does not match its bytes", asset);
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (!asset.startsWith(`assets/${digest}.`)) {
      throw new CanonicalStorageError("Image asset bytes do not match their content hash", asset);
    }
    return bytes;
  }

  async saveNotebook(notebook: NotebookManifest): Promise<void> {
    const valid = validated("notebook.json", validateNotebookManifest(notebook));
    await this.#atomicWrite("notebook.json", serializeCanonicalJson(valid));
  }

  async saveSection(section: SectionManifest): Promise<void> {
    const valid = validated("section.json", validateSectionManifest(section));
    await this.#atomicWrite(sectionManifestPath(valid.id), serializeCanonicalJson(valid));
  }

  async savePageManifest(sectionId: string, page: PageManifest): Promise<void> {
    assertStableId(sectionId, "section ID");
    const valid = validated("page.json", validatePageManifest(page));
    await this.#atomicWrite(pageManifestPath(sectionId, valid.id), serializeCanonicalJson(valid));
  }

  async savePage(sectionId: string, page: StoredPage): Promise<void> {
    assertStableId(sectionId, "section ID");
    const manifest = validated("page.json", validatePageManifest(page.manifest));
    const canvas = validated("canvas.jsonl", validateCanvasRecords(page.canvas));
    const markdownIds = canvas
      .filter((record) => record.kind === "markdown")
      .map((record) => record.id)
      .sort();
    const suppliedIds = Object.keys(page.markdown).sort();
    if (
      markdownIds.length !== suppliedIds.length ||
      markdownIds.some((id, index) => suppliedIds[index] !== id)
    ) {
      throw new CanonicalStorageError(
        "Markdown sources must exactly match the page's Markdown canvas records",
        pageManifestPath(sectionId, manifest.id),
      );
    }
    for (const objectId of markdownIds) {
      if (typeof page.markdown[objectId] !== "string") {
        throw new CanonicalStorageError(
          `Markdown source ${objectId} must be a string`,
          pageManifestPath(sectionId, manifest.id),
        );
      }
    }

    await this.savePageManifest(sectionId, manifest);
    await this.savePageContent(sectionId, manifest.id, { canvas, markdown: page.markdown });
  }

  async savePageContent(
    sectionId: string,
    pageId: string,
    content: StoredPageContent,
  ): Promise<void> {
    validateHierarchyIds(sectionId, pageId);
    const canvas = validated("canvas.jsonl", validateCanvasRecords(content.canvas));
    const markdownIds = canvas
      .filter((record) => record.kind === "markdown")
      .map((record) => record.id)
      .sort();
    const suppliedIds = Object.keys(content.markdown).sort();
    if (
      markdownIds.length !== suppliedIds.length ||
      markdownIds.some((id, index) => suppliedIds[index] !== id)
    ) {
      throw new CanonicalStorageError(
        "Markdown sources must exactly match the page's Markdown canvas records",
        pageManifestPath(sectionId, pageId),
      );
    }
    for (const objectId of markdownIds) {
      if (typeof content.markdown[objectId] !== "string") {
        throw new CanonicalStorageError(
          `Markdown source ${objectId} must be a string`,
          pageManifestPath(sectionId, pageId),
        );
      }
    }

    const previousCanvas = await this.#loadOptionalCanvas(sectionId, pageId);
    const previousMarkdownIds = new Set(
      (previousCanvas ?? [])
        .filter((record) => record.kind === "markdown")
        .map((record) => record.id),
    );
    for (const objectId of markdownIds) {
      await this.saveMarkdown(sectionId, pageId, objectId, content.markdown[objectId] as string);
    }
    await this.saveCanvas(sectionId, pageId, canvas);
    for (const objectId of previousMarkdownIds) {
      if (!markdownIds.includes(objectId)) await this.#removeMarkdown(sectionId, pageId, objectId);
    }
  }

  async saveMarkdown(
    sectionId: string,
    pageId: string,
    objectId: string,
    markdown: string,
  ): Promise<void> {
    validateHierarchyIds(sectionId, pageId);
    assertStableId(objectId, "Markdown object ID");
    await this.#atomicWrite(markdownPath(sectionId, pageId, objectId), canonicalMarkdown(markdown));
  }

  async saveCanvas(
    sectionId: string,
    pageId: string,
    records: readonly CanvasRecord[],
  ): Promise<void> {
    validateHierarchyIds(sectionId, pageId);
    const valid = validated("canvas.jsonl", validateCanvasRecords(records));
    await this.#atomicWrite(canvasPath(sectionId, pageId), serializeCanvasJsonLines(valid));
  }

  async saveImageAsset(sectionId: string, pageId: string, bytes: Uint8Array): Promise<string> {
    validateHierarchyIds(sectionId, pageId);
    if (bytes.byteLength === 0 || bytes.byteLength > 25 * 1024 * 1024) {
      throw new CanonicalStorageError("Image assets must be between 1 byte and 25 MiB", "assets");
    }
    const extension = rasterExtension(bytes);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const asset = `assets/${digest}.${extension}`;
    await this.#atomicWriteBytes(pageAssetPath(sectionId, pageId, asset), bytes);
    return asset;
  }

  async #loadJson<T>(
    filePath: string,
    documentKind: CanonicalDocumentKind,
    validator: (value: unknown) => ValidationResult<T>,
  ): Promise<T> {
    const source = await readUtf8(filePath);
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch (error) {
      throw new CanonicalStorageError(
        `Malformed JSON in ${filePath}: ${errorMessage(error)}`,
        filePath,
      );
    }
    const migrated = migrateCanonicalDocument(documentKind, parsed, this.#migrations);
    return validated(filePath, validator(migrated));
  }

  async #atomicWrite(relativePath: string, contents: string): Promise<void> {
    const filePath = await this.#safeWritePath(relativePath);
    await this.#assertNoSymlinks(filePath);
    try {
      const existing = await readFile(filePath);
      if (Buffer.compare(existing, Buffer.from(contents, "utf8")) === 0) return;
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
    await this.#options.beforeAtomicWrite?.(relativePath, contents);
    await mkdir(dirname(filePath), { recursive: true });
    await this.#assertNoSymlinks(dirname(filePath));
    const temporaryPath = resolve(
      dirname(filePath),
      `.${basename(filePath)}.${process.pid}.${Date.now()}.${Math.random()
        .toString(16)
        .slice(2)}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(
        temporaryPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        0o600,
      );
      await handle.writeFile(contents, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, filePath);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  async #atomicWriteBytes(relativePath: string, contents: Uint8Array): Promise<void> {
    const filePath = await this.#safeWritePath(relativePath);
    await this.#assertNoSymlinks(filePath);
    try {
      const existing = await readFile(filePath);
      if (Buffer.compare(existing, Buffer.from(contents)) === 0) return;
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
    await mkdir(dirname(filePath), { recursive: true });
    await this.#assertNoSymlinks(dirname(filePath));
    const temporaryPath = resolve(
      dirname(filePath),
      `.${basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(
        temporaryPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        0o600,
      );
      await handle.writeFile(contents);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, filePath);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  async #loadOptionalCanvas(
    sectionId: string,
    pageId: string,
  ): Promise<readonly CanvasRecord[] | undefined> {
    const filePath = await this.#safeWritePath(canvasPath(sectionId, pageId));
    await this.#assertNoSymlinks(filePath);
    let source: string;
    try {
      source = UTF8_DECODER.decode(await readFile(filePath));
    } catch (error) {
      if (isMissingFileError(error)) return undefined;
      throw new CanonicalStorageError(
        `Unable to read ${filePath}: ${errorMessage(error)}`,
        filePath,
      );
    }
    return validated(filePath, validateCanvasRecords(parseJsonLines(source, filePath)));
  }

  async #removeMarkdown(sectionId: string, pageId: string, objectId: string): Promise<void> {
    const filePath = await this.#safeWritePath(markdownPath(sectionId, pageId, objectId));
    await this.#assertNoSymlinks(filePath);
    try {
      await unlink(filePath);
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
  }

  async #safeExistingPath(relativePath: string): Promise<string> {
    const candidate = await this.#safeWritePath(relativePath);
    await this.#assertNoSymlinks(candidate);
    const candidateRealPath = await realpath(candidate);
    const root = await this.#getRealProjectRoot();
    if (!isWithin(root, candidateRealPath)) {
      throw new CanonicalStorageError("Path resolves outside the project directory", candidate);
    }
    return candidate;
  }

  async #safeWritePath(relativePath: string): Promise<string> {
    if (isAbsolute(relativePath)) {
      throw new CanonicalStorageError("Canonical paths must be relative", relativePath);
    }
    const lexicalCandidate = resolve(this.#projectRoot, relativePath);
    if (!isWithin(this.#projectRoot, lexicalCandidate)) {
      throw new CanonicalStorageError("Path escapes the project directory", lexicalCandidate);
    }
    const root = await this.#getRealProjectRoot();
    return resolve(root, relativePath);
  }

  async #getRealProjectRoot(): Promise<string> {
    this.#realProjectRoot ??= await realpath(this.#projectRoot);
    return this.#realProjectRoot;
  }

  async #assertNoSymlinks(candidate: string): Promise<void> {
    const root = await this.#getRealProjectRoot();
    const relativePath = relative(root, candidate);
    if (relativePath === "" || relativePath.startsWith(`..${sep}`) || relativePath === "..") return;
    let current = root;
    for (const segment of relativePath.split(sep)) {
      current = resolve(current, segment);
      try {
        const status = await lstat(current);
        if (status.isSymbolicLink()) {
          throw new CanonicalStorageError(
            "Symbolic links are not allowed in canonical paths",
            current,
          );
        }
        if (!status.isDirectory() && (!status.isFile() || status.nlink !== 1)) {
          throw new CanonicalStorageError(
            "Canonical paths must be regular files without hard links",
            current,
          );
        }
      } catch (error) {
        if (isMissingFileError(error)) return;
        throw error;
      }
    }
  }
}

function sectionManifestPath(sectionId: string): string {
  return `sections/${sectionId}/section.json`;
}

function pageDirectory(sectionId: string, pageId: string): string {
  return `sections/${sectionId}/pages/${pageId}`;
}

function pageManifestPath(sectionId: string, pageId: string): string {
  return `${pageDirectory(sectionId, pageId)}/page.json`;
}

function canvasPath(sectionId: string, pageId: string): string {
  return `${pageDirectory(sectionId, pageId)}/canvas.jsonl`;
}

function pageAssetPath(sectionId: string, pageId: string, asset: string): string {
  assertImageAssetPath(asset);
  return `${pageDirectory(sectionId, pageId)}/${asset}`;
}

function assertImageAssetPath(asset: string): void {
  if (!/^assets\/[0-9a-f]{64}\.(?:png|jpe?g|gif|webp)$/.test(asset)) {
    throw new CanonicalStorageError(
      "Image asset path must be content-addressed and page-local",
      asset,
    );
  }
}

function rasterExtension(bytes: Uint8Array): "png" | "jpg" | "gif" | "webp" {
  if (
    bytes.length >= 8 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)
  )
    return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "jpg";
  const ascii = (start: number, length: number) =>
    String.fromCharCode(...bytes.slice(start, start + length));
  if (bytes.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return "gif";
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "webp";
  throw new CanonicalStorageError(
    "Image asset bytes are not a supported PNG, JPEG, GIF, or WebP raster",
    "assets",
  );
}

function markdownPath(sectionId: string, pageId: string, objectId: string): string {
  return `${pageDirectory(sectionId, pageId)}/markdown/${objectId}.md`;
}

function validateHierarchyIds(sectionId: string, pageId: string): void {
  assertStableId(sectionId, "section ID");
  assertStableId(pageId, "page ID");
}

function assertStableId(value: string, label: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new CanonicalStorageError(`${label} must be a lowercase RFC 4122 UUID`, value);
  }
}

function canonicalMarkdown(markdown: string): string {
  const withoutBom = markdown.startsWith("\uFEFF") ? markdown.slice(1) : markdown;
  return withoutBom.replace(/\r\n?/g, "\n");
}

function parseJsonLines(source: string, filePath: string): unknown[] {
  if (source === "") return [];
  const lines = source.endsWith("\n") ? source.slice(0, -1).split("\n") : source.split("\n");
  return lines.map((line, index) => {
    if (line.length === 0) {
      throw new CanonicalStorageError(`Blank JSONL record at line ${index + 1}`, filePath);
    }
    try {
      return JSON.parse(line) as unknown;
    } catch (error) {
      throw new CanonicalStorageError(
        `Malformed JSONL at line ${index + 1}: ${errorMessage(error)}`,
        filePath,
      );
    }
  });
}

async function readUtf8(filePath: string): Promise<string> {
  const bytes = await readFile(filePath);
  try {
    return UTF8_DECODER.decode(bytes);
  } catch (error) {
    throw new CanonicalStorageError(`File is not valid UTF-8: ${errorMessage(error)}`, filePath);
  }
}

function validated<T>(filePath: string, result: ValidationResult<T>): T {
  if (result.success) return result.data;
  throw new CanonicalStorageError(
    `Canonical validation failed for ${filePath}`,
    filePath,
    result.issues,
  );
}

function readSchemaVersion(document: unknown, documentKind: CanonicalDocumentKind): number {
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new CanonicalStorageError(`${documentKind} document must be an object`, documentKind);
  }
  const version = (document as Record<string, unknown>).schemaVersion;
  if (!Number.isSafeInteger(version) || (version as number) < 0) {
    throw new CanonicalStorageError(
      `${documentKind} schema version must be a non-negative integer`,
      documentKind,
    );
  }
  return version as number;
}

function identityMismatch(
  filePath: string,
  requested: string,
  actual: string,
): CanonicalStorageError {
  return new CanonicalStorageError(
    `Manifest identity ${actual} does not match requested identity ${requested}`,
    filePath,
  );
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot))
  );
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
