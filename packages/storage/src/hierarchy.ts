import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm } from "node:fs/promises";
import { join, sep } from "node:path";

import {
  CANONICAL_SCHEMA_VERSION,
  MARKDOWN_FONT_SIZE_MAX,
  MARKDOWN_FONT_SIZE_MIN,
  isAutosaveIntervalSeconds,
  isLaserPointerSettings,
  isMarkdownBoxAppearance,
  isMarkdownColorStyleLibrary,
  isSectionColor,
  isSynchronizedInkColors,
  readMarkdownBoxAppearance,
  type CanvasRecord,
  type AutosaveIntervalSeconds,
  type LaserPointerSettings,
  type MarkdownBoxAppearanceInput,
  type MarkdownColorStyleLibrary,
  type NotebookHierarchy,
  type NotebookManifest,
  type PageManifest,
  type SectionManifest,
  type SynchronizedInkColors,
  withMarkdownBoxAppearance,
  withMarkdownColorStyles,
  withAutosaveIntervalSeconds,
  withLanSharingDefault,
  withLaserPointerSettings,
  withSectionColor,
  withSynchronizedInkColors,
} from "@squillpad/core-model";

import type { StoredPage } from "./index.js";
import type { ProjectSession } from "./project-lifecycle.js";

/** Error raised when a hierarchy command is invalid or unsafe. */
export class HierarchyError extends Error {
  readonly code: "confirmation-required" | "conflict" | "not-found" | "invalid-order";

  constructor(
    code: "confirmation-required" | "conflict" | "not-found" | "invalid-order",
    message: string,
  ) {
    super(message);
    this.name = "HierarchyError";
    this.code = code;
  }
}

/** Canonical project/section/page commands for one locked project session. */
export class ProjectHierarchyService {
  readonly #session: ProjectSession;
  #pendingMutation: Promise<void> = Promise.resolve();

  constructor(session: ProjectSession) {
    this.#session = session;
  }

  /** Resolves after hierarchy and direct page-content mutations already in flight have settled. */
  async settled(): Promise<void> {
    await this.#pendingMutation;
  }

  async load(): Promise<NotebookHierarchy> {
    const notebook = await this.#session.loadNotebook();
    const sections = await Promise.all(
      notebook.sectionIds.map(async (sectionId) => {
        const manifest = await this.#session.loadSection(sectionId);
        const pages = await Promise.all(
          manifest.pageIds.map(async (pageId) => {
            return this.#session.loadPageManifest(sectionId, pageId);
          }),
        );
        return { manifest, pages };
      }),
    );
    return { notebook, sections };
  }

  /** Updates project-wide ink colors while preserving all other notebook settings. */
  updateSynchronizedInkColors(colors: SynchronizedInkColors): Promise<NotebookHierarchy> {
    return this.#mutate(async () => {
      if (!isSynchronizedInkColors(colors)) {
        throw new Error("Synchronized ink colors must be six-digit hexadecimal colors");
      }
      const notebook = await this.#session.loadNotebook();
      await this.#session.saveNotebook({
        ...notebook,
        settings: {
          ...notebook.settings,
          metadata: withSynchronizedInkColors(notebook.settings.metadata, colors),
        },
      });
    });
  }

  /** Updates the project-wide Markdown box appearance. */
  updateMarkdownBoxAppearance(appearance: MarkdownBoxAppearanceInput): Promise<NotebookHierarchy> {
    return this.#mutate(async () => {
      if (!isMarkdownBoxAppearance(appearance)) {
        throw new Error(
          `Markdown box opacity must be between zero and one and font size must be between ${MARKDOWN_FONT_SIZE_MIN} and ${MARKDOWN_FONT_SIZE_MAX}`,
        );
      }
      const notebook = await this.#session.loadNotebook();
      const current = readMarkdownBoxAppearance(notebook.settings.metadata);
      const fontSize = appearance.fontSize ?? current?.fontSize;
      const nextAppearance: MarkdownBoxAppearanceInput =
        fontSize === undefined ? { opacity: appearance.opacity } : { ...appearance, fontSize };
      await this.#session.saveNotebook({
        ...notebook,
        settings: {
          ...notebook.settings,
          metadata: withMarkdownBoxAppearance(notebook.settings.metadata, nextAppearance),
        },
      });
    });
  }

  /** Updates the synchronized project-wide Markdown color-style library. */
  updateMarkdownColorStyles(library: MarkdownColorStyleLibrary): Promise<NotebookHierarchy> {
    return this.#mutate(async () => {
      if (!isMarkdownColorStyleLibrary(library)) {
        throw new Error("Markdown color styles are invalid");
      }
      const notebook = await this.#session.loadNotebook();
      await this.#session.saveNotebook({
        ...notebook,
        settings: {
          ...notebook.settings,
          metadata: withMarkdownColorStyles(notebook.settings.metadata, library),
        },
      });
    });
  }

  /** Updates the project-wide laser pointer decay duration. */
  updateLaserPointerSettings(settings: LaserPointerSettings): Promise<NotebookHierarchy> {
    return this.#mutate(async () => {
      if (!isLaserPointerSettings(settings)) {
        throw new Error("Laser pointer decay must be between 0.5 and 5 seconds");
      }
      const notebook = await this.#session.loadNotebook();
      await this.#session.saveNotebook({
        ...notebook,
        settings: {
          ...notebook.settings,
          metadata: withLaserPointerSettings(notebook.settings.metadata, settings),
        },
      });
    });
  }

  /** Updates the project default for LAN sharing on the next host launch. */
  updateLanSharingDefault(enabled: boolean): Promise<NotebookHierarchy> {
    return this.#mutate(async () => {
      if (typeof enabled !== "boolean") throw new Error("LAN sharing default must be a boolean");
      const notebook = await this.#session.loadNotebook();
      await this.#session.saveNotebook({
        ...notebook,
        settings: {
          ...notebook.settings,
          metadata: withLanSharingDefault(notebook.settings.metadata, enabled),
        },
      });
    });
  }

  /** Updates the disabled-sharing autosave interval for this project. */
  updateAutosaveIntervalSeconds(seconds: AutosaveIntervalSeconds): Promise<NotebookHierarchy> {
    return this.#mutate(async () => {
      if (!isAutosaveIntervalSeconds(seconds)) {
        throw new Error("Autosave interval must be one of the supported project intervals");
      }
      const notebook = await this.#session.loadNotebook();
      await this.#session.saveNotebook({
        ...notebook,
        settings: {
          ...notebook.settings,
          metadata: withAutosaveIntervalSeconds(notebook.settings.metadata, seconds),
        },
      });
    });
  }

  /** Loads one referenced page including its canvas records and Markdown sources. */
  async loadPage(sectionId: string, pageId: string): Promise<StoredPage> {
    await this.#loadReferencedPage(sectionId, pageId);
    return this.#session.loadPage(sectionId, pageId);
  }

  async loadImageAsset(sectionId: string, pageId: string, asset: string): Promise<Uint8Array> {
    await this.#loadReferencedPage(sectionId, pageId);
    return this.#session.loadImageAsset(sectionId, pageId, asset);
  }

  async saveImageAsset(sectionId: string, pageId: string, bytes: Uint8Array): Promise<string> {
    await this.#loadReferencedPage(sectionId, pageId);
    return this.#session.saveImageAsset(sectionId, pageId, bytes);
  }

  /** Replaces editable page content while preserving its server-owned manifest. */
  savePageContent(
    sectionId: string,
    pageId: string,
    canvas: readonly CanvasRecord[],
    markdown: Readonly<Record<string, string>>,
  ): Promise<StoredPage> {
    return this.#mutateContent(async () => {
      await this.#loadReferencedPage(sectionId, pageId);
      await this.#session.savePageContent(sectionId, pageId, { canvas, markdown });
      return this.#session.loadPage(sectionId, pageId);
    });
  }

  createSection(title: string, targetIndex?: number): Promise<NotebookHierarchy> {
    return this.#mutate(async () => {
      const notebook = await this.#session.loadNotebook();
      const insertionIndex = validInsertionIndex(targetIndex, notebook.sectionIds.length);
      const section: SectionManifest = {
        schemaVersion: CANONICAL_SCHEMA_VERSION,
        id: randomUUID(),
        title: normalizedTitle(title, "Untitled Section"),
        pageIds: [],
        metadata: {},
      };
      await this.#session.saveSection(section);
      const sectionIds = [...notebook.sectionIds];
      sectionIds.splice(insertionIndex, 0, section.id);
      await this.#session.saveNotebook({
        ...notebook,
        sectionIds,
      });
    });
  }

  duplicateSection(sectionId: string, targetIndex?: number): Promise<NotebookHierarchy> {
    return this.#mutate(async () => {
      const notebook = await this.#session.loadNotebook();
      assertIncludes(notebook.sectionIds, sectionId, "section");
      const insertionIndex = validInsertionIndex(targetIndex, notebook.sectionIds.length);
      const source = await this.#session.loadSection(sectionId);
      const sourcePages = await Promise.all(
        source.pageIds.map((pageId) => this.#session.loadPage(sectionId, pageId)),
      );
      const duplicatedPages = sourcePages.map((page) => ({
        ...page,
        manifest: {
          ...page.manifest,
          id: randomUUID(),
          title: copiedTitle(page.manifest.title),
        },
      }));
      const duplicatedSection: SectionManifest = {
        ...source,
        id: randomUUID(),
        title: copiedTitle(source.title),
        pageIds: duplicatedPages.map((page) => page.manifest.id),
      };

      await this.#session.saveSection(duplicatedSection);
      for (const [index, page] of duplicatedPages.entries()) {
        const sourcePage = sourcePages[index];
        if (sourcePage === undefined) continue;
        await this.#session.savePage(duplicatedSection.id, page);
        await this.#copyPageAssets(sectionId, sourcePage, duplicatedSection.id, page.manifest.id);
      }

      const sectionIds = [...notebook.sectionIds];
      sectionIds.splice(insertionIndex, 0, duplicatedSection.id);
      await this.#session.saveNotebook({ ...notebook, sectionIds });
    });
  }

  renameSection(sectionId: string, title: string): Promise<NotebookHierarchy> {
    return this.#mutate(async () => {
      await this.#assertSectionReferenced(sectionId);
      const section = await this.#session.loadSection(sectionId);
      await this.#session.saveSection({ ...section, title: normalizedTitle(title, section.title) });
    });
  }

  updateSectionColor(sectionId: string, color: string | undefined): Promise<NotebookHierarchy> {
    return this.#mutate(async () => {
      await this.#assertSectionReferenced(sectionId);
      if (color !== undefined && !isSectionColor(color)) {
        throw new Error("Section color must be a six-digit hexadecimal color");
      }
      const section = await this.#session.loadSection(sectionId);
      await this.#session.saveSection({
        ...section,
        metadata: withSectionColor(section.metadata, color),
      });
    });
  }

  renameProject(title: string): Promise<NotebookHierarchy> {
    return this.#mutate(async () => {
      const notebook = await this.#session.loadNotebook();
      await this.#session.saveNotebook({
        ...notebook,
        title: normalizedTitle(title, notebook.title),
      });
    });
  }

  reorderSections(sectionIds: readonly string[]): Promise<NotebookHierarchy> {
    return this.#mutate(async () => {
      const notebook = await this.#session.loadNotebook();
      assertPermutation(notebook.sectionIds, sectionIds, "section");
      await this.#session.saveNotebook({ ...notebook, sectionIds: [...sectionIds] });
    });
  }

  deleteSection(sectionId: string, confirmed: boolean): Promise<NotebookHierarchy> {
    return this.#mutate(async () => {
      requireConfirmation(confirmed, "section");
      const notebook = await this.#session.loadNotebook();
      assertIncludes(notebook.sectionIds, sectionId, "section");
      await this.#session.saveNotebook({
        ...notebook,
        sectionIds: notebook.sectionIds.filter((id) => id !== sectionId),
      });
      await removeCanonicalDirectory(this.#session.projectRoot, sectionDirectory(sectionId));
    });
  }

  createPage(sectionId: string, title: string, targetIndex?: number): Promise<NotebookHierarchy> {
    return this.#mutate(async () => {
      await this.#assertSectionReferenced(sectionId);
      const section = await this.#session.loadSection(sectionId);
      const insertionIndex = validInsertionIndex(targetIndex, section.pageIds.length);
      const page: StoredPage = {
        manifest: {
          schemaVersion: CANONICAL_SCHEMA_VERSION,
          id: randomUUID(),
          title: normalizedTitle(title, "Untitled Page"),
          metadata: {},
        },
        canvas: [],
        markdown: {},
      };
      await this.#session.savePage(sectionId, page);
      const pageIds = [...section.pageIds];
      pageIds.splice(insertionIndex, 0, page.manifest.id);
      await this.#session.saveSection({
        ...section,
        pageIds,
      });
    });
  }

  duplicatePage(
    sourceSectionId: string,
    sourcePageId: string,
    targetSectionId: string,
    targetIndex?: number,
  ): Promise<NotebookHierarchy> {
    return this.#mutate(async () => {
      const { page: sourceManifest } = await this.#loadReferencedPage(
        sourceSectionId,
        sourcePageId,
      );
      await this.#assertSectionReferenced(targetSectionId);
      const targetSection = await this.#session.loadSection(targetSectionId);
      const insertionIndex = validInsertionIndex(targetIndex, targetSection.pageIds.length);
      const sourcePage = await this.#session.loadPage(sourceSectionId, sourcePageId);
      const duplicatedPage: StoredPage = {
        ...sourcePage,
        manifest: {
          ...sourceManifest,
          id: randomUUID(),
          title: copiedTitle(sourceManifest.title),
        },
      };

      await this.#session.savePage(targetSectionId, duplicatedPage);
      await this.#copyPageAssets(
        sourceSectionId,
        sourcePage,
        targetSectionId,
        duplicatedPage.manifest.id,
      );
      const pageIds = [...targetSection.pageIds];
      pageIds.splice(insertionIndex, 0, duplicatedPage.manifest.id);
      await this.#session.saveSection({ ...targetSection, pageIds });
    });
  }

  renamePage(sectionId: string, pageId: string, title: string): Promise<NotebookHierarchy> {
    return this.#mutate(async () => {
      const { page } = await this.#loadReferencedPage(sectionId, pageId);
      await this.#session.savePageManifest(sectionId, {
        ...page,
        title: normalizedTitle(title, page.title),
      });
    });
  }

  reorderPages(sectionId: string, pageIds: readonly string[]): Promise<NotebookHierarchy> {
    return this.#mutate(async () => {
      await this.#assertSectionReferenced(sectionId);
      const section = await this.#session.loadSection(sectionId);
      assertPermutation(section.pageIds, pageIds, "page");
      await this.#session.saveSection({ ...section, pageIds: [...pageIds] });
    });
  }

  movePage(
    sourceSectionId: string,
    targetSectionId: string,
    pageId: string,
    targetIndex?: number,
  ): Promise<NotebookHierarchy> {
    return this.#mutate(async () => {
      if (sourceSectionId === targetSectionId) {
        throw new HierarchyError("conflict", "Source and target sections must be different");
      }
      const notebook = await this.#session.loadNotebook();
      assertIncludes(notebook.sectionIds, sourceSectionId, "source section");
      assertIncludes(notebook.sectionIds, targetSectionId, "target section");
      const source = await this.#session.loadSection(sourceSectionId);
      const target = await this.#session.loadSection(targetSectionId);
      assertIncludes(source.pageIds, pageId, "page");
      if (target.pageIds.includes(pageId)) {
        throw new HierarchyError("conflict", `Page ${pageId} already exists in the target section`);
      }
      const insertionIndex = targetIndex ?? target.pageIds.length;
      if (
        !Number.isSafeInteger(insertionIndex) ||
        insertionIndex < 0 ||
        insertionIndex > target.pageIds.length
      ) {
        throw new HierarchyError("invalid-order", "Target page index is out of range");
      }

      await moveCanonicalPageDirectory(
        this.#session.projectRoot,
        sourceSectionId,
        targetSectionId,
        pageId,
      );
      await this.#session.saveSection({
        ...source,
        pageIds: source.pageIds.filter((id) => id !== pageId),
      });
      const targetPageIds = [...target.pageIds];
      targetPageIds.splice(insertionIndex, 0, pageId);
      await this.#session.saveSection({ ...target, pageIds: targetPageIds });
    });
  }

  deletePage(sectionId: string, pageId: string, confirmed: boolean): Promise<NotebookHierarchy> {
    return this.#mutate(async () => {
      requireConfirmation(confirmed, "page");
      const { section } = await this.#loadReferencedPage(sectionId, pageId);
      await this.#session.saveSection({
        ...section,
        pageIds: section.pageIds.filter((id) => id !== pageId),
      });
      await removeCanonicalDirectory(this.#session.projectRoot, pageDirectory(sectionId, pageId));
    });
  }

  async #assertSectionReferenced(sectionId: string): Promise<NotebookManifest> {
    const notebook = await this.#session.loadNotebook();
    assertIncludes(notebook.sectionIds, sectionId, "section");
    return notebook;
  }

  async #loadReferencedPage(
    sectionId: string,
    pageId: string,
  ): Promise<{ readonly section: SectionManifest; readonly page: PageManifest }> {
    await this.#assertSectionReferenced(sectionId);
    const section = await this.#session.loadSection(sectionId);
    assertIncludes(section.pageIds, pageId, "page");
    const page = await this.#session.loadPageManifest(sectionId, pageId);
    return { section, page };
  }

  async #copyPageAssets(
    sourceSectionId: string,
    sourcePage: StoredPage,
    targetSectionId: string,
    targetPageId: string,
  ): Promise<void> {
    for (const record of sourcePage.canvas) {
      if (record.kind !== "image") continue;
      const bytes = await this.#session.loadImageAsset(
        sourceSectionId,
        sourcePage.manifest.id,
        record.asset,
      );
      await this.#session.saveImageAsset(targetSectionId, targetPageId, bytes);
    }
  }

  #mutate(operation: () => Promise<void>): Promise<NotebookHierarchy> {
    return this.#mutateContent(async () => {
      await operation();
      return this.load();
    });
  }

  #mutateContent<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#pendingMutation.then(operation);
    this.#pendingMutation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function normalizedTitle(value: string, fallback: string): string {
  const title = value.trim();
  return title.length > 0 ? title : fallback;
}

function copiedTitle(title: string): string {
  return `Copy of ${title}`;
}

function validInsertionIndex(proposed: number | undefined, length: number): number {
  const index = proposed ?? length;
  if (!Number.isSafeInteger(index) || index < 0 || index > length) {
    throw new HierarchyError("invalid-order", "Target insertion index is out of range");
  }
  return index;
}

function assertPermutation(
  current: readonly string[],
  proposed: readonly string[],
  label: string,
): void {
  if (
    current.length !== proposed.length ||
    new Set(proposed).size !== proposed.length ||
    current.some((id) => !proposed.includes(id))
  ) {
    throw new HierarchyError(
      "invalid-order",
      `The proposed ${label} order must contain every existing ID exactly once`,
    );
  }
}

function assertIncludes(ids: readonly string[], id: string, label: string): void {
  if (!ids.includes(id)) {
    throw new HierarchyError("not-found", `Referenced ${label} ${id} was not found`);
  }
}

function requireConfirmation(confirmed: boolean, label: string): void {
  if (!confirmed) {
    throw new HierarchyError(
      "confirmation-required",
      `Deleting a ${label} requires explicit confirmation`,
    );
  }
}

function sectionDirectory(sectionId: string): string {
  assertStableId(sectionId);
  return join("sections", sectionId);
}

function pageDirectory(sectionId: string, pageId: string): string {
  assertStableId(sectionId);
  assertStableId(pageId);
  return join(sectionDirectory(sectionId), "pages", pageId);
}

async function removeCanonicalDirectory(projectRoot: string, relativePath: string): Promise<void> {
  const directory = join(projectRoot, relativePath);
  await assertRealDirectoryPath(projectRoot, relativePath);
  await rm(directory, { recursive: true });
}

async function moveCanonicalPageDirectory(
  projectRoot: string,
  sourceSectionId: string,
  targetSectionId: string,
  pageId: string,
): Promise<void> {
  const source = join(projectRoot, pageDirectory(sourceSectionId, pageId));
  const target = join(projectRoot, pageDirectory(targetSectionId, pageId));
  await assertRealDirectoryPath(projectRoot, pageDirectory(sourceSectionId, pageId));
  const targetSectionPath = sectionDirectory(targetSectionId);
  await assertRealDirectoryPath(projectRoot, targetSectionPath);
  const targetPages = join(projectRoot, targetSectionPath, "pages");
  try {
    const pagesStatus = await lstat(targetPages);
    if (pagesStatus.isSymbolicLink() || !pagesStatus.isDirectory()) {
      throw new HierarchyError("conflict", "Canonical pages path must be a real directory");
    }
  } catch (error) {
    if (!isMissingPath(error)) throw error;
    await mkdir(targetPages);
  }
  await rename(source, target);
}

async function assertRealDirectoryPath(projectRoot: string, relativePath: string): Promise<void> {
  let current = projectRoot;
  for (const segment of relativePath.split(sep)) {
    current = join(current, segment);
    const status = await lstat(current);
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new HierarchyError("conflict", "Canonical target must contain only real directories");
    }
  }
}

function isMissingPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function assertStableId(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new HierarchyError("not-found", "Hierarchy ID must be a lowercase RFC 4122 UUID");
  }
}
