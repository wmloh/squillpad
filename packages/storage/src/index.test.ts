import {
  access,
  chmod,
  link,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import {
  CANONICAL_SCHEMA_VERSION,
  AUTOSAVE_INTERVAL_SECONDS_METADATA_KEY,
  DEFAULT_PROFILE_SETTINGS,
  LAN_SHARING_DEFAULT_METADATA_KEY,
  LASER_POINTER_SETTINGS_METADATA_KEY,
  MARKDOWN_BOX_APPEARANCE_METADATA_KEY,
  MARKDOWN_COLOR_KEYS,
  MARKDOWN_COLOR_STYLES_METADATA_KEY,
  SECTION_COLOR_METADATA_KEY,
  SYNCHRONIZED_INK_COLORS_METADATA_KEY,
  serializeCanvasJsonLines,
  type CanvasRecord,
  type NotebookManifest,
  type SectionManifest,
} from "@squillpad/core-model";
import { beforeEach, describe, expect, it } from "vitest";

import {
  CanonicalStorageError,
  cleanupOrphanImageAssets,
  cleanupRuntimeCache,
  FileSystemProjectStorage,
  HierarchyError,
  migrateCanonicalDocument,
  ProjectHierarchyService,
  ProjectLifecycleError,
  createProject,
  openProject,
  inspectProjectStorage,
  type StoredPage,
} from "./index.js";

const PROJECT_ID = "018f1f2e-7c8a-7b1c-8d2e-3f4a5b6c7d8e";
const SECTION_ID = "123e4567-e89b-42d3-a456-426614174000";
const PAGE_ID = "223e4567-e89b-42d3-a456-426614174001";
const MARKDOWN_ID = "323e4567-e89b-42d3-a456-426614174002";
const SHAPE_ID = "523e4567-e89b-42d3-a456-426614174004";
const IMAGE_ID = "623e4567-e89b-42d3-a456-426614174005";

const notebook: NotebookManifest = {
  schemaVersion: CANONICAL_SCHEMA_VERSION,
  projectId: PROJECT_ID,
  title: "Persistence test",
  sectionIds: [SECTION_ID],
  settings: { defaultZoom: 1, metadata: { future: { retained: true } } },
};

const section: SectionManifest = {
  schemaVersion: CANONICAL_SCHEMA_VERSION,
  id: SECTION_ID,
  title: "Section",
  pageIds: [PAGE_ID],
  metadata: {},
};

const markdownRecord: CanvasRecord = {
  kind: "markdown",
  id: MARKDOWN_ID,
  position: [12.25, -4],
  z: 2,
  width: 400,
  height: 200,
  source: `markdown/${MARKDOWN_ID}.md`,
};

const shapeRecord: CanvasRecord = {
  kind: "shape",
  id: SHAPE_ID,
  position: [0, 0],
  z: 1,
  geometry: { kind: "rectangle", width: 40, height: 20 },
  style: { strokeColor: "#000000", strokeWidth: 2, fillColor: null, opacity: 1 },
};

const page: StoredPage = {
  manifest: {
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    id: PAGE_ID,
    title: "Page",
    metadata: { future: ["preserved", 1] },
  },
  canvas: [markdownRecord, shapeRecord],
  markdown: { [MARKDOWN_ID]: "# Heading\r\n\r\nText\r\n" },
};

describe("filesystem canonical persistence", () => {
  let projectRoot: string;
  let storage: FileSystemProjectStorage;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "squillpad-storage-"));
    storage = new FileSystemProjectStorage(projectRoot);
  });

  it("round-trips notebook, section, page, canvas, and Markdown data", async () => {
    await storage.saveNotebook(notebook);
    await storage.saveSection(section);
    await storage.savePage(SECTION_ID, page);

    expect(await storage.loadNotebook()).toEqual(notebook);
    expect(await storage.loadSection(SECTION_ID)).toEqual(section);
    expect(await storage.loadPage(SECTION_ID, PAGE_ID)).toEqual({
      ...page,
      canvas: [shapeRecord, markdownRecord],
      markdown: { [MARKDOWN_ID]: "# Heading\n\nText\n" },
    });
  });

  it("writes byte-identical canonical files for identical logical documents", async () => {
    await storage.saveNotebook(notebook);
    await storage.saveCanvas(SECTION_ID, PAGE_ID, [markdownRecord, shapeRecord]);
    const notebookPath = join(projectRoot, "notebook.json");
    const canvasPath = join(projectRoot, "sections", SECTION_ID, "pages", PAGE_ID, "canvas.jsonl");
    const first = [await readFile(notebookPath), await readFile(canvasPath)];

    await storage.saveNotebook({
      settings: notebook.settings,
      sectionIds: notebook.sectionIds,
      title: notebook.title,
      projectId: notebook.projectId,
      schemaVersion: notebook.schemaVersion,
    });
    await storage.saveCanvas(SECTION_ID, PAGE_ID, [shapeRecord, markdownRecord]);

    expect(await readFile(notebookPath)).toEqual(first[0]);
    expect(await readFile(canvasPath)).toEqual(first[1]);
    expect((await readdir(dirname(canvasPath))).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("stores page-local raster assets by content and removes only verified orphans", async () => {
    await storage.savePage(SECTION_ID, { ...page, canvas: [], markdown: {} });
    const referencedBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
    const orphanBytes = Uint8Array.from([0xff, 0xd8, 0xff, 2]);
    const referencedAsset = await storage.saveImageAsset(SECTION_ID, PAGE_ID, referencedBytes);
    const duplicateAsset = await storage.saveImageAsset(SECTION_ID, PAGE_ID, referencedBytes);
    const orphanAsset = await storage.saveImageAsset(SECTION_ID, PAGE_ID, orphanBytes);
    expect(duplicateAsset).toBe(referencedAsset);
    expect(await storage.loadImageAsset(SECTION_ID, PAGE_ID, referencedAsset)).toEqual(
      referencedBytes,
    );

    await storage.savePageContent(SECTION_ID, PAGE_ID, {
      canvas: [
        {
          kind: "image",
          id: IMAGE_ID,
          position: [0, 0],
          z: 0,
          width: 320,
          height: 180,
          asset: referencedAsset,
        },
      ],
      markdown: {},
    });

    expect(await cleanupOrphanImageAssets(projectRoot)).toEqual({
      removedBytes: orphanBytes.byteLength,
      removedFileCount: 1,
    });
    await expect(storage.loadImageAsset(SECTION_ID, PAGE_ID, orphanAsset)).rejects.toThrow();
    expect(await storage.loadImageAsset(SECTION_ID, PAGE_ID, referencedAsset)).toEqual(
      referencedBytes,
    );
  });

  it("rejects unsupported image bytes", async () => {
    await expect(
      storage.saveImageAsset(SECTION_ID, PAGE_ID, Uint8Array.from([1, 2, 3, 4])),
    ).rejects.toThrow("supported PNG, JPEG, GIF, or WebP");
  });

  it("rejects a page asset whose bytes no longer match its content hash", async () => {
    const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
    const asset = await storage.saveImageAsset(SECTION_ID, PAGE_ID, bytes);
    await writeFile(
      join(projectRoot, "sections", SECTION_ID, "pages", PAGE_ID, asset),
      Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 2]),
    );

    await expect(storage.loadImageAsset(SECTION_ID, PAGE_ID, asset)).rejects.toThrow(
      "do not match their content hash",
    );
  });

  it("reports canonical and runtime bytes separately and cleans only sync history", async () => {
    const session = await createProject(join(projectRoot, "project"));
    const projectPath = session.projectRoot;
    const syncPath = join(projectPath, ".squillpad-runtime", "sync");
    await mkdir(syncPath, { recursive: true });
    await writeFile(join(syncPath, "history.updates"), "runtime history", "utf8");

    const before = await inspectProjectStorage(projectPath);
    expect(before.canonicalBytes).toBeGreaterThan(0);
    expect(before.runtimeCacheBytes).toBeGreaterThan(before.runtimeCacheFileCount);
    expect(before.runtimeCacheFileCount).toBeGreaterThan(0);

    const cleanup = await cleanupRuntimeCache(projectPath);
    const after = await inspectProjectStorage(projectPath);
    expect(cleanup.removedFileCount).toBe(1);
    expect(cleanup.removedBytes).toBeGreaterThan(0);
    expect(after.canonicalBytes).toBe(before.canonicalBytes);
    expect(after.runtimeCacheBytes).toBeLessThan(before.runtimeCacheBytes);
    await access(join(projectPath, "notebook.json"));
    await access(join(projectPath, ".squillpad-runtime", "project.lock"));
    await session.close();
  });

  it("materializes page content incrementally without rewriting unrelated Markdown", async () => {
    const writes: string[] = [];
    storage = new FileSystemProjectStorage(projectRoot, [], {
      beforeAtomicWrite: (relativePath) => {
        writes.push(relativePath);
      },
    });
    await storage.savePage(SECTION_ID, page);
    writes.length = 0;

    await storage.savePageContent(SECTION_ID, PAGE_ID, {
      canvas: [markdownRecord, { ...shapeRecord, position: [8, 12] }],
      markdown: { [MARKDOWN_ID]: "# Heading\n\nText\n" },
    });

    expect(writes).toEqual([`sections/${SECTION_ID}/pages/${PAGE_ID}/canvas.jsonl`]);

    writes.length = 0;
    await storage.savePageContent(SECTION_ID, PAGE_ID, {
      canvas: [markdownRecord, { ...shapeRecord, position: [8, 12] }],
      markdown: { [MARKDOWN_ID]: "# Heading\n\nChanged\n" },
    });
    expect(writes).toEqual([`sections/${SECTION_ID}/pages/${PAGE_ID}/markdown/${MARKDOWN_ID}.md`]);
  });

  it("rejects an older manifest without rewriting its source file", async () => {
    const oldSource = JSON.stringify({
      schemaVersion: 0,
      projectId: PROJECT_ID,
      title: "Old notebook",
      sectionIds: [SECTION_ID],
      settings: { defaultZoom: 1, metadata: { retained: "yes" } },
    });
    await writeFile(join(projectRoot, "notebook.json"), oldSource, "utf8");
    await expect(new FileSystemProjectStorage(projectRoot).loadNotebook()).rejects.toThrow(
      "No unambiguous notebook migration",
    );
    expect(await readFile(join(projectRoot, "notebook.json"), "utf8")).toBe(oldSource);
  });

  it("rejects ambiguous, skipped, and future schema migrations", () => {
    expect(() =>
      migrateCanonicalDocument("notebook", { schemaVersion: 0 }, [
        { documentKind: "notebook", fromVersion: 0, toVersion: 2, migrate: (value) => value },
      ]),
    ).toThrow("No unambiguous notebook migration");
    expect(() =>
      migrateCanonicalDocument("notebook", { schemaVersion: CANONICAL_SCHEMA_VERSION + 1 }, []),
    ).toThrow("Unsupported notebook schema version");
  });

  it("rejects malformed records without rewriting their source", async () => {
    const notebookPath = join(projectRoot, "notebook.json");
    const malformed = '{"schemaVersion":1,"title":"missing required data"}\n';
    await writeFile(notebookPath, malformed, "utf8");

    await expect(storage.loadNotebook()).rejects.toBeInstanceOf(CanonicalStorageError);
    expect(await readFile(notebookPath, "utf8")).toBe(malformed);
  });

  it("rejects traversal-like identifiers before filesystem access", async () => {
    await expect(storage.loadSection("../outside")).rejects.toThrow("lowercase RFC 4122 UUID");
    await expect(storage.loadMarkdown(SECTION_ID, PAGE_ID, "/etc/passwd")).rejects.toThrow(
      "lowercase RFC 4122 UUID",
    );
  });

  it("rejects symlinks in canonical paths", async () => {
    const outside = await mkdtemp(join(tmpdir(), "squillpad-outside-"));
    const markdownDirectory = join(
      projectRoot,
      "sections",
      SECTION_ID,
      "pages",
      PAGE_ID,
      "markdown",
    );
    await mkdir(dirname(markdownDirectory), { recursive: true });
    await writeFile(join(outside, `${MARKDOWN_ID}.md`), "escaped", "utf8");
    await symlink(outside, markdownDirectory, "dir");

    await expect(storage.loadMarkdown(SECTION_ID, PAGE_ID, MARKDOWN_ID)).rejects.toThrow(
      "Symbolic links are not allowed",
    );
  });

  it("validates all page content before replacing an existing manifest", async () => {
    await storage.savePage(SECTION_ID, page);
    const pagePath = join(projectRoot, "sections", SECTION_ID, "pages", PAGE_ID, "page.json");
    const original = await readFile(pagePath, "utf8");
    const invalidPage = { ...page, markdown: {} };

    await expect(storage.savePage(SECTION_ID, invalidPage)).rejects.toThrow(
      "Markdown sources must exactly match",
    );
    expect(await readFile(pagePath, "utf8")).toBe(original);
  });

  it("keeps the previous canvas readable when writing a new Markdown source fails", async () => {
    const storage = new FileSystemProjectStorage(projectRoot);
    await storage.savePage(SECTION_ID, { ...page, canvas: [], markdown: {} });
    const failing = new FileSystemProjectStorage(projectRoot, [], {
      beforeAtomicWrite: (path) => {
        if (path.endsWith(".md")) throw new Error("injected Markdown failure");
      },
    });
    await expect(failing.savePageContent(SECTION_ID, PAGE_ID, page)).rejects.toThrow(
      "injected Markdown failure",
    );
    expect((await storage.loadPage(SECTION_ID, PAGE_ID)).canvas).toEqual([]);
  });

  it("rejects hard-linked canonical files before reading or overwriting outside content", async () => {
    const outside = join(projectRoot, "outside.json");
    await writeFile(outside, JSON.stringify(notebook));
    await link(outside, join(projectRoot, "notebook.json"));
    const storage = new FileSystemProjectStorage(projectRoot);
    await expect(storage.loadNotebook()).rejects.toThrow("without hard links");
    await expect(storage.saveNotebook(notebook)).rejects.toThrow("without hard links");
    expect(await readFile(outside, "utf8")).toBe(JSON.stringify(notebook));
  });
});

describe("project lifecycle", () => {
  let parentDirectory: string;
  let projectRoot: string;

  beforeEach(async () => {
    parentDirectory = await mkdtemp(join(tmpdir(), "squillpad-lifecycle-"));
    projectRoot = join(parentDirectory, "project");
  });

  it("creates a valid starter hierarchy in a missing or empty directory", async () => {
    const session = await createProject(projectRoot, {
      title: "My notebook",
      starterSectionTitle: "Ideas",
      starterPageTitle: "First page",
    });

    const notebook = await session.loadNotebook();
    const section = await session.loadSection(notebook.sectionIds[0] as string);
    const storedPage = await session.loadPage(section.id, section.pageIds[0] as string);

    expect(notebook.title).toBe("My notebook");
    expect(section.title).toBe("Ideas");
    expect(storedPage).toMatchObject({
      manifest: { title: "First page" },
      canvas: [],
      markdown: {},
    });
    expect(await readFile(join(projectRoot, ".squillpad-runtime", ".gitignore"), "utf8")).toBe(
      "*\n",
    );
    expect(await readFile(join(projectRoot, ".gitignore"), "utf8")).toContain(
      ".squillpad-runtime/",
    );
    await session.close();

    await mkdir(join(parentDirectory, "empty"));
    const emptyDirectorySession = await createProject(join(parentDirectory, "empty"));
    await emptyDirectorySession.close();
  });

  it("rejects a non-empty creation target without changing it", async () => {
    await mkdir(projectRoot);
    const existingPath = join(projectRoot, "keep.txt");
    await writeFile(existingPath, "keep", "utf8");

    await expect(createProject(projectRoot)).rejects.toMatchObject({
      code: "target-not-empty",
    });
    expect(await readFile(existingPath, "utf8")).toBe("keep");
  });

  it("validates an existing project without rewriting canonical files", async () => {
    const created = await createProject(projectRoot);
    await created.close();
    const before = await canonicalSnapshot(projectRoot);

    const opened = await openProject(projectRoot);
    expect(await opened.loadNotebook()).toMatchObject({ title: "Untitled Project" });
    await opened.close();

    expect(await canonicalSnapshot(projectRoot)).toEqual(before);
  });

  it("prevents concurrent sessions and releases the lock on close", async () => {
    const first = await createProject(projectRoot);

    await expect(openProject(projectRoot)).rejects.toMatchObject({
      code: "project-locked",
    });
    await first.close();
    await expect(access(join(projectRoot, ".squillpad-runtime", "project.lock"))).rejects.toThrow();

    const second = await openProject(projectRoot);
    await second.close();
  });

  it("recovers malformed and same-host dead-process locks", async () => {
    const created = await createProject(projectRoot);
    await created.close();
    const lockPath = join(projectRoot, ".squillpad-runtime", "project.lock");

    await writeFile(lockPath, "not json", "utf8");
    const afterMalformedLock = await openProject(projectRoot);
    await afterMalformedLock.close();

    await writeFile(
      lockPath,
      JSON.stringify({
        createdAt: new Date(0).toISOString(),
        hostname: hostname(),
        pid: 2_147_483_647,
        sessionId: "123e4567-e89b-42d3-a456-426614174000",
      }),
      "utf8",
    );
    const afterDeadProcessLock = await openProject(projectRoot);
    await afterDeadProcessLock.close();
  });

  it("does not reclaim a valid lock from another host", async () => {
    const created = await createProject(projectRoot);
    await created.close();
    const lockPath = join(projectRoot, ".squillpad-runtime", "project.lock");
    await writeFile(
      lockPath,
      JSON.stringify({
        createdAt: new Date().toISOString(),
        hostname: "another-host.example",
        pid: 1234,
        sessionId: "123e4567-e89b-42d3-a456-426614174000",
      }),
      "utf8",
    );

    await expect(openProject(projectRoot)).rejects.toMatchObject({
      code: "project-locked",
    });
    const persistedLock: unknown = JSON.parse(await readFile(lockPath, "utf8"));
    expect(persistedLock).toMatchObject({
      hostname: "another-host.example",
    });
  });

  it("flushes pending canonical writes before releasing the lock", async () => {
    const session = await createProject(projectRoot);
    const notebook = await session.loadNotebook();
    void session.saveNotebook({ ...notebook, title: "Saved during close" });

    await session.close();
    const reopened = await openProject(projectRoot);
    expect((await reopened.loadNotebook()).title).toBe("Saved during close");
    await reopened.close();
  });

  it("recovers one valid temporary file when its canonical target is missing", async () => {
    const created = await createProject(projectRoot);
    const notebook = await created.loadNotebook();
    const section = await created.loadSection(notebook.sectionIds[0] as string);
    const pageId = section.pageIds[0] as string;
    await created.close();
    const pagePath = join(projectRoot, "sections", section.id, "pages", pageId, "page.json");
    const temporaryPath = join(dirname(pagePath), ".page.json.123.456.abcdef.tmp");
    await rename(pagePath, temporaryPath);

    const recovered = await openProject(projectRoot);
    expect((await recovered.loadPage(section.id, pageId)).manifest.id).toBe(pageId);
    await recovered.close();
    await expect(access(temporaryPath)).rejects.toThrow();
  });

  it("does not recover profile settings into a mismatched profile filename", async () => {
    const created = await createProject(projectRoot);
    await created.close();
    const profilesPath = join(projectRoot, "profiles");
    await mkdir(profilesPath);
    const temporaryPath = join(profilesPath, ".alice.json.123.456.abcdef.tmp");
    await writeFile(
      temporaryPath,
      JSON.stringify({
        schemaVersion: 1,
        username: "bob",
        settings: DEFAULT_PROFILE_SETTINGS,
      }),
      "utf8",
    );

    await expect(openProject(projectRoot)).rejects.toMatchObject({ code: "malformed-project" });
    await expect(access(temporaryPath)).resolves.toBeUndefined();
    await expect(access(join(profilesPath, "alice.json"))).rejects.toThrow();
  });

  it("returns actionable errors for unsupported and malformed projects", async () => {
    const created = await createProject(projectRoot);
    await created.close();
    const notebookPath = join(projectRoot, "notebook.json");
    const unsupported = JSON.stringify({
      ...(JSON.parse(await readFile(notebookPath, "utf8")) as object),
      schemaVersion: CANONICAL_SCHEMA_VERSION + 1,
    });
    await writeFile(notebookPath, unsupported, "utf8");

    const unsupportedError = await openProject(projectRoot).catch((error: unknown) => error);
    expect(unsupportedError).toBeInstanceOf(ProjectLifecycleError);
    expect(unsupportedError).toMatchObject({ code: "unsupported-schema" });
    expect((unsupportedError as Error).message).toContain("Upgrade SquillPad");
    expect(await readFile(notebookPath, "utf8")).toBe(unsupported);

    await writeFile(notebookPath, "{bad json", "utf8");
    const malformedError = await openProject(projectRoot).catch((error: unknown) => error);
    expect(malformedError).toMatchObject({ code: "malformed-project" });
    expect((malformedError as Error).message).toContain("Repair the referenced canonical file");
  });

  it("reports a corrupted page as recoverable without replacing its canonical file", async () => {
    const created = await createProject(projectRoot);
    const notebook = await created.loadNotebook();
    const section = await created.loadSection(notebook.sectionIds[0] as string);
    await created.close();
    const canvasPath = join(
      projectRoot,
      "sections",
      section.id,
      "pages",
      section.pageIds[0] as string,
      "canvas.jsonl",
    );
    const malformed = "{not a canvas record}\n";
    await writeFile(canvasPath, malformed, "utf8");

    const error = await openProject(projectRoot).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "malformed-project" });
    expect((error as Error).message).toContain("Repair the referenced canonical file");
    expect(await readFile(canvasPath, "utf8")).toBe(malformed);
  });

  it("fails read-only project opens with an actionable permissions error", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const created = await createProject(projectRoot);
    await created.close();
    const runtimePath = join(projectRoot, ".squillpad-runtime");
    await chmod(projectRoot, 0o555);
    await chmod(runtimePath, 0o555);
    try {
      await expect(openProject(projectRoot)).rejects.toMatchObject({ code: "permissions" });
    } finally {
      await chmod(runtimePath, 0o755);
      await chmod(projectRoot, 0o755);
    }
  });

  it("supports the Git commit, readable diff, external edit, and reload workflow", async () => {
    const git = promisify(execFileCallback);
    try {
      await git("git", ["--version"]);
    } catch {
      return;
    }

    const session = await createProject(projectRoot, { initializeGit: true });
    const hierarchy = await new ProjectHierarchyService(session).load();
    const sectionId = hierarchy.sections[0]?.manifest.id as string;
    const pageId = hierarchy.sections[0]?.pages[0]?.id as string;
    const record: CanvasRecord = {
      kind: "markdown",
      id: MARKDOWN_ID,
      position: [0, 0],
      z: 0,
      width: 320,
      height: 160,
      source: `markdown/${MARKDOWN_ID}.md`,
    };
    await session.savePageContent(sectionId, pageId, {
      canvas: [record],
      markdown: { [MARKDOWN_ID]: "# Initial\n" },
    });
    await session.close();

    const runGit = async (...args: string[]) =>
      git("git", args, { cwd: projectRoot, encoding: "utf8" });
    await expect(access(join(projectRoot, ".git", "HEAD"))).resolves.toBeUndefined();
    await runGit("add", ".");
    await runGit(
      "-c",
      "user.name=SquillPad Tests",
      "-c",
      "user.email=squillpad@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "initial",
    );

    const canvasFile = join(projectRoot, "sections", sectionId, "pages", pageId, "canvas.jsonl");
    const stroke: CanvasRecord = {
      kind: "ink",
      id: SHAPE_ID,
      position: [10, 20],
      z: 1,
      points: [
        [0, 0],
        [12, 8],
      ],
      style: { color: "#000000", width: 3, opacity: 1, highlighter: false },
    };
    await writeFile(canvasFile, serializeCanvasJsonLines([record, stroke]), "utf8");
    const canvasDiff = await runGit(
      "diff",
      "--",
      "sections",
      sectionId,
      "pages",
      pageId,
      "canvas.jsonl",
    );
    expect(canvasDiff.stdout).toContain('"kind":"ink"');
    const changedFiles = await runGit("diff", "--name-only");
    expect(changedFiles.stdout.trim().split("\n")).toEqual([
      `sections/${sectionId}/pages/${pageId}/canvas.jsonl`,
    ]);
    await runGit("add", ".");
    await runGit(
      "-c",
      "user.name=SquillPad Tests",
      "-c",
      "user.email=squillpad@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "stroke",
    );

    const markdownFile = join(
      projectRoot,
      "sections",
      sectionId,
      "pages",
      pageId,
      "markdown",
      `${MARKDOWN_ID}.md`,
    );
    await writeFile(markdownFile, "# Changed\n", "utf8");
    const diff = await runGit("diff", "--", "sections");
    expect(diff.stdout).toContain("-# Initial");
    expect(diff.stdout).toContain("+# Changed");
    await runGit("add", ".");
    await runGit(
      "-c",
      "user.name=SquillPad Tests",
      "-c",
      "user.email=squillpad@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "edited",
    );

    await writeFile(markdownFile, "# External edit\n", "utf8");
    const reopened = await openProject(projectRoot);
    expect((await reopened.loadPage(sectionId, pageId)).markdown[MARKDOWN_ID]).toBe(
      "# External edit\n",
    );
    await reopened.close();
  });
});

describe("project hierarchy", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = join(await mkdtemp(join(tmpdir(), "squillpad-hierarchy-")), "project");
  });

  it("creates, renames, orders, and moves stable section and page identities", async () => {
    const session = await createProject(projectRoot, {
      starterSectionTitle: "First section",
      starterPageTitle: "First page",
    });
    const hierarchy = new ProjectHierarchyService(session);
    const initial = await hierarchy.load();
    const firstSectionId = initial.sections[0]?.manifest.id as string;
    const firstPageId = initial.sections[0]?.pages[0]?.id as string;

    const withSecond = await hierarchy.createSection("Second section");
    const secondSectionId = withSecond.sections[1]?.manifest.id as string;
    const withSecondPage = await hierarchy.createPage(secondSectionId, "Second page");
    const secondPageId = withSecondPage.sections[1]?.pages[0]?.id as string;

    await hierarchy.renameProject("Renamed project");
    await hierarchy.renameSection(firstSectionId, "Renamed section");
    await hierarchy.renamePage(firstSectionId, firstPageId, "Renamed page");
    await hierarchy.reorderSections([secondSectionId, firstSectionId]);
    await hierarchy.movePage(secondSectionId, firstSectionId, secondPageId, 0);
    const result = await hierarchy.reorderPages(firstSectionId, [firstPageId, secondPageId]);

    expect(result.notebook).toMatchObject({
      projectId: initial.notebook.projectId,
      title: "Renamed project",
      sectionIds: [secondSectionId, firstSectionId],
    });
    expect(result.sections[1]?.manifest).toMatchObject({
      id: firstSectionId,
      title: "Renamed section",
    });
    expect(
      result.sections[1]?.pages.map((pageManifest) => [pageManifest.id, pageManifest.title]),
    ).toEqual([
      [firstPageId, "Renamed page"],
      [secondPageId, "Second page"],
    ]);
    expect(
      await readFile(
        join(projectRoot, "sections", firstSectionId, "pages", secondPageId, "page.json"),
        "utf8",
      ),
    ).toContain(secondPageId);
    await expect(
      access(join(projectRoot, "sections", secondSectionId, "pages", secondPageId)),
    ).rejects.toThrow();
    await session.close();
  });

  it("requires explicit confirmation before deleting canonical directories", async () => {
    const session = await createProject(projectRoot);
    const hierarchy = new ProjectHierarchyService(session);
    const initial = await hierarchy.load();
    const sectionId = initial.sections[0]?.manifest.id as string;
    const pageId = initial.sections[0]?.pages[0]?.id as string;

    await expect(hierarchy.deletePage(sectionId, pageId, false)).rejects.toBeInstanceOf(
      HierarchyError,
    );
    expect((await hierarchy.load()).sections[0]?.pages).toHaveLength(1);
    await hierarchy.deletePage(sectionId, pageId, true);
    await expect(
      access(join(projectRoot, "sections", sectionId, "pages", pageId)),
    ).rejects.toThrow();

    await expect(hierarchy.deleteSection(sectionId, false)).rejects.toMatchObject({
      code: "confirmation-required",
    });
    await hierarchy.deleteSection(sectionId, true);
    expect((await hierarchy.load()).sections).toEqual([]);
    await expect(access(join(projectRoot, "sections", sectionId))).rejects.toThrow();
    await session.close();
  });

  it("inserts and duplicates complete pages and sections with their assets", async () => {
    const session = await createProject(projectRoot, {
      starterSectionTitle: "Source section",
      starterPageTitle: "Source page",
    });
    const hierarchy = new ProjectHierarchyService(session);
    const initial = await hierarchy.load();
    const sourceSectionId = initial.sections[0]?.manifest.id as string;
    const sourcePageId = initial.sections[0]?.pages[0]?.id as string;
    const imageBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 3]);
    const asset = await session.saveImageAsset(sourceSectionId, sourcePageId, imageBytes);
    await session.savePageContent(sourceSectionId, sourcePageId, {
      canvas: [
        {
          kind: "image",
          id: IMAGE_ID,
          position: [10, 20],
          z: 1,
          width: 320,
          height: 180,
          asset,
        },
      ],
      markdown: {},
    });

    const withInsertedPage = await hierarchy.createPage(sourceSectionId, "Inserted page", 0);
    const insertedPageId = withInsertedPage.sections[0]?.pages[0]?.id as string;
    expect(withInsertedPage.sections[0]?.pages.map((page) => page.id)).toEqual([
      insertedPageId,
      sourcePageId,
    ]);

    const withPageCopy = await hierarchy.duplicatePage(
      sourceSectionId,
      sourcePageId,
      sourceSectionId,
      2,
    );
    const copiedPage = withPageCopy.sections[0]?.pages[2];
    expect(copiedPage?.title).toBe("Copy of Source page");
    expect(copiedPage?.id).not.toBe(sourcePageId);
    expect(await session.loadPage(sourceSectionId, copiedPage?.id as string)).toMatchObject({
      canvas: [expect.objectContaining({ kind: "image", asset })],
    });
    expect(await session.loadImageAsset(sourceSectionId, copiedPage?.id as string, asset)).toEqual(
      imageBytes,
    );

    const withSectionCopy = await hierarchy.duplicateSection(sourceSectionId, 1);
    const copiedSection = withSectionCopy.sections[1];
    const copiedSectionPage = copiedSection?.pages.find(
      (page) => page.title === "Copy of Source page",
    );
    expect(copiedSection?.manifest.title).toBe("Copy of Source section");
    expect(copiedSectionPage?.title).toBe("Copy of Source page");
    expect(copiedSectionPage?.id).not.toBe(sourcePageId);
    expect(
      await session.loadImageAsset(
        copiedSection?.manifest.id as string,
        copiedSectionPage?.id as string,
        asset,
      ),
    ).toEqual(imageBytes);
    await session.close();
  });

  it("stores synchronized ink colors in the notebook settings metadata", async () => {
    const session = await createProject(projectRoot);
    const hierarchy = new ProjectHierarchyService(session);
    const result = await hierarchy.updateSynchronizedInkColors({
      pen: "#fb923c",
      highlighter: "#4ade80",
    });

    expect(result.notebook.settings.metadata[SYNCHRONIZED_INK_COLORS_METADATA_KEY]).toEqual({
      pen: "#fb923c",
      highlighter: "#4ade80",
    });
    expect(JSON.parse(await readFile(join(projectRoot, "notebook.json"), "utf8"))).toMatchObject({
      settings: {
        metadata: {
          [SYNCHRONIZED_INK_COLORS_METADATA_KEY]: {
            pen: "#fb923c",
            highlighter: "#4ade80",
          },
        },
      },
    });
    await session.close();
  });

  it("stores and clears a section color in the canonical section metadata", async () => {
    const session = await createProject(projectRoot);
    const hierarchy = new ProjectHierarchyService(session);
    const sectionId = (await hierarchy.load()).sections[0]?.manifest.id;
    if (sectionId === undefined) throw new Error("Missing starter section");

    const colored = await hierarchy.updateSectionColor(sectionId, "#ef4444");
    expect(colored.sections[0]?.manifest.metadata[SECTION_COLOR_METADATA_KEY]).toBe("#ef4444");
    expect(
      JSON.parse(
        await readFile(join(projectRoot, "sections", sectionId, "section.json"), "utf8"),
      ),
    ).toMatchObject({ metadata: { [SECTION_COLOR_METADATA_KEY]: "#ef4444" } });

    const cleared = await hierarchy.updateSectionColor(sectionId, undefined);
    expect(cleared.sections[0]?.manifest.metadata[SECTION_COLOR_METADATA_KEY]).toBeUndefined();
    await session.close();
  });

  it("stores Markdown appearance in the notebook settings metadata", async () => {
    const session = await createProject(projectRoot);
    const hierarchy = new ProjectHierarchyService(session);
    const result = await hierarchy.updateMarkdownBoxAppearance({ opacity: 0, fontSize: 22 });

    expect(result.notebook.settings.metadata[MARKDOWN_BOX_APPEARANCE_METADATA_KEY]).toEqual({
      opacity: 0,
      fontSize: 22,
    });
    expect(JSON.parse(await readFile(join(projectRoot, "notebook.json"), "utf8"))).toMatchObject({
      settings: {
        metadata: {
          [MARKDOWN_BOX_APPEARANCE_METADATA_KEY]: { opacity: 0, fontSize: 22 },
        },
      },
    });
    await session.close();
  });

  it("stores Markdown color styles in the notebook settings metadata", async () => {
    const session = await createProject(projectRoot);
    const hierarchy = new ProjectHierarchyService(session);
    const id = "323e4567-e89b-42d3-a456-426614174002";
    const colors = Object.fromEntries(
      MARKDOWN_COLOR_KEYS.map((key) => [key, { light: "#123456", dark: "#654321" }]),
    ) as Record<
      (typeof MARKDOWN_COLOR_KEYS)[number],
      { light: string; dark: string }
    >;
    const result = await hierarchy.updateMarkdownColorStyles({
      defaultStyleId: id,
      styles: [{ id, name: "Lecture", colors }],
    });

    expect(result.notebook.settings.metadata[MARKDOWN_COLOR_STYLES_METADATA_KEY]).toMatchObject({
      defaultStyleId: id,
      styles: [{ id, name: "Lecture" }],
    });
    await session.close();
  });

  it("stores laser pointer decay settings in the notebook settings metadata", async () => {
    const session = await createProject(projectRoot);
    const hierarchy = new ProjectHierarchyService(session);
    const result = await hierarchy.updateLaserPointerSettings({ decaySeconds: 2.7 });

    expect(result.notebook.settings.metadata[LASER_POINTER_SETTINGS_METADATA_KEY]).toEqual({
      decaySeconds: 2.7,
    });
    expect(JSON.parse(await readFile(join(projectRoot, "notebook.json"), "utf8"))).toMatchObject({
      settings: {
        metadata: {
          [LASER_POINTER_SETTINGS_METADATA_KEY]: { decaySeconds: 2.7 },
        },
      },
    });
    await session.close();
  });

  it("stores sharing default and autosave frequency in project metadata", async () => {
    const session = await createProject(projectRoot);
    const hierarchy = new ProjectHierarchyService(session);
    const withDefault = await hierarchy.updateLanSharingDefault(false);
    const result = await hierarchy.updateAutosaveIntervalSeconds(300);

    expect(withDefault.notebook.settings.metadata[LAN_SHARING_DEFAULT_METADATA_KEY]).toBe(false);
    expect(result.notebook.settings.metadata[AUTOSAVE_INTERVAL_SECONDS_METADATA_KEY]).toBe(300);
    expect(JSON.parse(await readFile(join(projectRoot, "notebook.json"), "utf8"))).toMatchObject({
      settings: {
        metadata: {
          [LAN_SHARING_DEFAULT_METADATA_KEY]: false,
          [AUTOSAVE_INTERVAL_SECONDS_METADATA_KEY]: 300,
        },
      },
    });
    await session.close();
  });

  it("rejects incomplete reorder commands without changing canonical order", async () => {
    const session = await createProject(projectRoot);
    const hierarchy = new ProjectHierarchyService(session);
    const initial = await hierarchy.createSection("Second");

    await expect(
      hierarchy.reorderSections([initial.notebook.sectionIds[0] as string]),
    ).rejects.toMatchObject({ code: "invalid-order" });
    expect((await hierarchy.load()).notebook.sectionIds).toEqual(initial.notebook.sectionIds);
    await session.close();
  });

  it("refuses to move pages through a symbolic-link destination", async () => {
    const session = await createProject(projectRoot);
    const hierarchy = new ProjectHierarchyService(session);
    const initial = await hierarchy.load();
    const sourceSectionId = initial.sections[0]?.manifest.id as string;
    const pageId = initial.sections[0]?.pages[0]?.id as string;
    const withTarget = await hierarchy.createSection("Target");
    const targetSectionId = withTarget.sections[1]?.manifest.id as string;
    const outside = await mkdtemp(join(tmpdir(), "squillpad-move-outside-"));
    await symlink(outside, join(projectRoot, "sections", targetSectionId, "pages"), "dir");

    await expect(
      hierarchy.movePage(sourceSectionId, targetSectionId, pageId),
    ).rejects.toMatchObject({
      code: "conflict",
    });
    expect((await hierarchy.load()).sections[0]?.pages[0]?.id).toBe(pageId);
    await session.close();
  });
});

async function canonicalSnapshot(projectRoot: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};

  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".squillpad-runtime") continue;
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else {
        snapshot[entryPath.slice(projectRoot.length + 1)] = await readFile(entryPath, "utf8");
      }
    }
  }

  await visit(projectRoot);
  return snapshot;
}
