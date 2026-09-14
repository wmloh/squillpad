import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_PROFILE_SETTINGS,
  serializeCanonicalJson,
  serializeCanvasJsonLines,
  type CanvasRecord,
} from "@squillpad/core-model";
import {
  createProject,
  ProfileSettingsStore,
  ProjectHierarchyService,
  type ProjectSession,
} from "@squillpad/storage";

import { RepositorySynchronizationService } from "./repository-synchronization.js";

const execute = promisify(execFile);
const roots: string[] = [];
const sessions: ProjectSession[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("repository synchronization", () => {
  it("requires the exact SSH GitHub repository format", async () => {
    const fixture = await createFixture();
    const service = new RepositorySynchronizationService({
      projectRoot: fixture.projectRoot,
      flushCanonical: () => Promise.resolve(),
      cleanupOrphanImageAssets: () => Promise.resolve(),
      reloadCanonical: () => Promise.resolve(),
    });

    await expect(service.configure("https://github.com/example/notebook.git")).rejects.toThrow(
      "Use an SSH GitHub repository URL in the form git@github.com:owner/repository.git.",
    );
    await expect(service.configure("git@github.com:example/notebook")).rejects.toThrow(
      "Use an SSH GitHub repository URL in the form git@github.com:owner/repository.git.",
    );
  });

  it("marks legacy HTTPS remotes as requiring SSH migration", async () => {
    const fixture = await createFixture();
    const legacyUrl = "https://github.com/example/notebook.git";
    await git(fixture.projectRoot, ["remote", "add", "squillpad-sync", legacyUrl]);
    await git(fixture.projectRoot, ["config", "squillpad.syncBranch", "main"]);
    const service = new RepositorySynchronizationService({
      projectRoot: fixture.projectRoot,
      flushCanonical: () => Promise.resolve(),
      cleanupOrphanImageAssets: () => Promise.resolve(),
      reloadCanonical: () => Promise.resolve(),
    });

    await expect(service.status()).resolves.toEqual({
      available: true,
      configured: false,
      remoteUrl: legacyUrl,
      branch: "main",
    });
    await expect(service.synchronize()).rejects.toThrow(
      "Update it to git@github.com:owner/repository.git before synchronizing.",
    );
  });

  it("replaces the configured remote and preserves local history", async () => {
    const fixture = await createFixture();
    const replacementRoot = join(fixture.root, "replacement.git");
    await mkdir(replacementRoot);
    await git(replacementRoot, ["init", "--bare", "--initial-branch=main"]);
    const replacementUrl = `file://${replacementRoot}`;
    const service = new RepositorySynchronizationService({
      projectRoot: fixture.projectRoot,
      flushCanonical: () => Promise.resolve(),
      cleanupOrphanImageAssets: () => Promise.resolve(),
      reloadCanonical: () => Promise.resolve(),
      allowNonGitHubRemoteForTests: true,
    });

    await service.configure(fixture.remoteUrl);
    const localHead = await gitOutput(fixture.projectRoot, ["rev-parse", "HEAD"]);
    await service.configure(replacementUrl);

    expect(await gitOutput(fixture.projectRoot, ["remote", "get-url", "squillpad-sync"])).toBe(
      replacementUrl,
    );
    expect(await gitOutput(fixture.projectRoot, ["rev-parse", "HEAD"])).toBe(localHead);
    expect(
      await gitOutput(fixture.root, [`--git-dir=${replacementRoot}`, "rev-parse", "refs/heads/main"]),
    ).toBe(localHead);
  });

  it("publishes settings-only profile records with the canonical project snapshot", async () => {
    const fixture = await createFixture();
    const profileStore = await ProfileSettingsStore.open(fixture.projectRoot);
    await profileStore.save("alice", {
      ...DEFAULT_PROFILE_SETTINGS,
      application: { theme: "dark", pageBackground: "blank" },
    });
    const service = new RepositorySynchronizationService({
      projectRoot: fixture.projectRoot,
      flushCanonical: () => Promise.resolve(),
      flushProfileSettings: () => profileStore.flush(),
      cleanupOrphanImageAssets: () => Promise.resolve(),
      reloadCanonical: async () => profileStore.reload(),
      beginExclusiveProfileOperation: () => profileStore.beginRepositoryOperation(),
      allowNonGitHubRemoteForTests: true,
    });

    await service.configure(fixture.remoteUrl);
    const remoteClone = join(fixture.root, "profile-remote-clone");
    await git(fixture.root, ["clone", fixture.remoteUrl, remoteClone]);
    const published = JSON.parse(
      await readFile(join(remoteClone, "profiles", "alice.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(published).toMatchObject({
      schemaVersion: 1,
      username: "alice",
      settings: {
        application: { theme: "dark", pageBackground: "blank" },
      },
    });
    expect(published).not.toHaveProperty("passwordHash");
    expect(published).not.toHaveProperty("sessions");
  });

  it("checks remote changes without committing or applying them", async () => {
    const fixture = await createFixture();
    let flushes = 0;
    let cleanups = 0;
    const service = new RepositorySynchronizationService({
      projectRoot: fixture.projectRoot,
      flushCanonical: () => {
        flushes += 1;
        return Promise.resolve();
      },
      cleanupOrphanImageAssets: () => {
        cleanups += 1;
        return Promise.resolve();
      },
      reloadCanonical: () => Promise.resolve(),
      allowNonGitHubRemoteForTests: true,
    });
    await service.configure(fixture.remoteUrl);
    flushes = 0;
    cleanups = 0;

    const remoteClone = join(fixture.root, "remote-clone");
    await git(fixture.root, ["clone", fixture.remoteUrl, remoteClone]);
    await configureIdentity(remoteClone);
    const remoteNotebook = JSON.parse(
      await readFile(join(remoteClone, "notebook.json"), "utf8"),
    ) as Awaited<ReturnType<ProjectSession["loadNotebook"]>>;
    await writeFile(
      join(remoteClone, "notebook.json"),
      serializeCanonicalJson({ ...remoteNotebook, title: "Remote change" }),
      "utf8",
    );
    await git(remoteClone, ["add", "notebook.json"]);
    await git(remoteClone, ["commit", "-m", "Remote edit"]);
    await git(remoteClone, ["push", "origin", "main"]);

    const check = await service.check();
    expect(check).toMatchObject({
      outcome: "sync-needed",
      remoteUpdateAvailable: true,
      review: {
        kind: "remote-update",
        publishLocal: { insertions: 1, deletions: 1 },
        applyRemote: { insertions: 1, deletions: 1 },
      },
    });
    expect(flushes).toBe(1);
    expect(cleanups).toBe(1);
    await expect(service.comparison()).resolves.toMatchObject({
      outcome: "apply-remote",
      applyRemote: { insertions: 1, deletions: 1 },
    });
    expect(flushes).toBe(2);
    expect(cleanups).toBe(2);
    expect((await fixture.session.loadNotebook()).title).toBe("Local project");
  });

  it("refreshes a dirty local working tree against the fetched GitHub snapshot without committing", async () => {
    const fixture = await createFixture();
    const service = new RepositorySynchronizationService({
      projectRoot: fixture.projectRoot,
      flushCanonical: () => Promise.resolve(),
      cleanupOrphanImageAssets: () => Promise.resolve(),
      reloadCanonical: () => Promise.resolve(),
      allowNonGitHubRemoteForTests: true,
    });
    await service.configure(fixture.remoteUrl);
    const headBeforeRefresh = await gitOutput(fixture.projectRoot, ["rev-parse", "HEAD"]);

    const localNotebook = await fixture.session.loadNotebook();
    await fixture.session.saveNotebook({ ...localNotebook, title: "Local working tree" });

    const remoteClone = join(fixture.root, "refresh-remote-clone");
    await git(fixture.root, ["clone", fixture.remoteUrl, remoteClone]);
    await configureIdentity(remoteClone);
    const remoteNotebook = JSON.parse(
      await readFile(join(remoteClone, "notebook.json"), "utf8"),
    ) as typeof localNotebook;
    await writeFile(
      join(remoteClone, "notebook.json"),
      serializeCanonicalJson({ ...remoteNotebook, title: "Fetched GitHub state" }),
      "utf8",
    );
    await git(remoteClone, ["add", "notebook.json"]);
    await git(remoteClone, ["commit", "-m", "Remote refresh edit"]);
    await git(remoteClone, ["push", "origin", "main"]);

    const comparison = await service.comparison();

    expect(comparison).toMatchObject({
      outcome: "conflict",
      review: {
        kind: "conflict",
        publishLocal: { insertions: 1, deletions: 1 },
        applyRemote: { insertions: 1, deletions: 1 },
      },
    });
    expect(await gitOutput(fixture.projectRoot, ["rev-parse", "HEAD"])).toBe(headBeforeRefresh);
    expect(comparison.review?.local.message).toBe("Current local working tree");
    expect(
      (await service.historicalSnapshot(comparison.review!.local.commit)).hierarchy.notebook.title,
    ).toBe("Local working tree");
    expect(
      (await service.historicalSnapshot(comparison.review!.remote.commit)).hierarchy.notebook.title,
    ).toBe("Fetched GitHub state");
  });

  it("combines the refreshed local working tree with the fetched GitHub snapshot", async () => {
    const fixture = await createFixture();
    const service = new RepositorySynchronizationService({
      projectRoot: fixture.projectRoot,
      flushCanonical: () => Promise.resolve(),
      cleanupOrphanImageAssets: () => Promise.resolve(),
      reloadCanonical: () => Promise.resolve(),
      allowNonGitHubRemoteForTests: true,
    });
    await service.configure(fixture.remoteUrl);

    const hierarchy = new ProjectHierarchyService(fixture.session);
    const notebook = await hierarchy.load();
    const section = notebook.sections[0]!;
    const page = section.pages[0]!;
    const lineId = "323e4567-e89b-42d3-a456-426614174002";
    const line: CanvasRecord = {
      id: lineId,
      kind: "shape",
      position: [20, 30],
      z: 0,
      geometry: { kind: "line", start: [0, 0], end: [100, 80] },
      style: { strokeColor: "#111111", strokeWidth: 2, fillColor: null, opacity: 1 },
    };
    await hierarchy.savePageContent(section.manifest.id, page.id, [line], {});

    const remoteClone = join(fixture.root, "dirty-combine-remote-clone");
    await git(fixture.root, ["clone", fixture.remoteUrl, remoteClone]);
    await configureIdentity(remoteClone);
    const pageRoot = join(remoteClone, "sections", section.manifest.id, "pages", page.id);
    const textId = "423e4567-e89b-42d3-a456-426614174003";
    const text: CanvasRecord = {
      id: textId,
      kind: "markdown",
      position: [180, 120],
      z: 0,
      width: 320,
      height: 160,
      source: `markdown/${textId}.md`,
    };
    await mkdir(join(pageRoot, "markdown"), { recursive: true });
    await writeFile(join(pageRoot, "canvas.jsonl"), serializeCanvasJsonLines([text]), "utf8");
    await writeFile(join(pageRoot, "markdown", `${textId}.md`), "# GitHub text\n", "utf8");
    await git(remoteClone, ["add", "."]);
    await git(remoteClone, ["commit", "-m", "GitHub dirty combine edit"]);
    await git(remoteClone, ["push", "origin", "main"]);

    const comparison = await service.comparison();
    expect(comparison.review).toBeDefined();
    const preview = await service.mergePreview(
      comparison.review!.local.commit,
      comparison.review!.remote.commit,
    );
    const candidatePage = await service.mergeCandidatePage(
      preview.candidateId,
      section.manifest.id,
      page.id,
    );

    expect(candidatePage.canvas.map((record) => record.id)).toEqual([lineId, textId]);
    await expect(
      service.applyMergeCandidate(
        preview.candidateId,
        comparison.review!.local.commit,
        comparison.review!.remote.commit,
        [],
        [],
      ),
    ).resolves.toMatchObject({ outcome: "synced" });
  });

  it("blocks GitHub synchronization when automatic orphan cleanup fails", async () => {
    const fixture = await createFixture();
    let cleanupFails = false;
    const events: string[] = [];
    const service = new RepositorySynchronizationService({
      projectRoot: fixture.projectRoot,
      flushCanonical: () => {
        events.push("flush");
        return Promise.resolve();
      },
      cleanupOrphanImageAssets: () => {
        events.push("cleanup");
        return cleanupFails
          ? Promise.reject(new Error("injected orphan cleanup failure"))
          : Promise.resolve();
      },
      reloadCanonical: () => Promise.resolve(),
      allowNonGitHubRemoteForTests: true,
    });
    await service.configure(fixture.remoteUrl);
    const headBefore = await gitOutput(fixture.projectRoot, ["rev-parse", "HEAD"]);
    const notebook = await fixture.session.loadNotebook();
    await fixture.session.saveNotebook({ ...notebook, title: "Must not publish" });
    cleanupFails = true;
    events.length = 0;

    await expect(service.synchronize()).rejects.toThrow("injected orphan cleanup failure");
    expect(events).toEqual(["flush", "cleanup"]);
    expect(await gitOutput(fixture.projectRoot, ["rev-parse", "HEAD"])).toBe(headBefore);
  });

  it("flushes and reports the directional line effect of the next sync", async () => {
    const fixture = await createFixture();
    let flushes = 0;
    const service = new RepositorySynchronizationService({
      projectRoot: fixture.projectRoot,
      flushCanonical: () => {
        flushes += 1;
        return Promise.resolve();
      },
      cleanupOrphanImageAssets: () => Promise.resolve(),
      reloadCanonical: () => Promise.resolve(),
      allowNonGitHubRemoteForTests: true,
    });
    await service.configure(fixture.remoteUrl);
    flushes = 0;
    const hierarchy = new ProjectHierarchyService(fixture.session);
    const notebook = await hierarchy.load();
    const section = notebook.sections[0]!;
    const page = section.pages[0]!;
    const markdownId = "323e4567-e89b-42d3-a456-426614174002";
    await hierarchy.savePageContent(
      section.manifest.id,
      page.id,
      [
        {
          id: markdownId,
          kind: "markdown",
          position: [0, 0],
          z: 0,
          width: 320,
          height: 160,
          source: `markdown/${markdownId}.md`,
        },
      ],
      { [markdownId]: "first line\nsecond line" },
    );

    await expect(service.comparison()).resolves.toEqual({
      outcome: "publish-local",
      publishLocal: { insertions: 3, deletions: 0 },
      applyRemote: { insertions: 0, deletions: 3 },
    });
    expect(flushes).toBe(1);
  });

  it("publishes snapshots to an empty remote and exposes historical page previews", async () => {
    const fixture = await createFixture();
    let flushes = 0;
    const service = new RepositorySynchronizationService({
      projectRoot: fixture.projectRoot,
      flushCanonical: () => {
        flushes += 1;
        return Promise.resolve();
      },
      cleanupOrphanImageAssets: () => Promise.resolve(),
      reloadCanonical: () => Promise.resolve(),
      allowNonGitHubRemoteForTests: true,
    });

    await expect(service.configure(fixture.remoteUrl, "Initial notebook")).resolves.toMatchObject({
      outcome: "synced",
    });
    expect(await service.status()).toMatchObject({ configured: true, branch: "main" });

    const notebook = await fixture.session.loadNotebook();
    await fixture.session.saveNotebook({ ...notebook, title: "Changed locally" });
    await expect(service.synchronize("Rename notebook")).resolves.toMatchObject({
      outcome: "synced",
    });
    expect(flushes).toBe(2);

    const history = await service.history();
    expect(history[0]?.message).toContain("SquillPad snapshot");
    expect(history[0]?.changedPaths).toContain("notebook.json");
    const oldest = history.at(-1);
    expect(oldest).toBeDefined();
    const snapshot = await service.historicalSnapshot(oldest!.commit);
    const section = snapshot.hierarchy.sections[0];
    const page = section?.pages[0];
    expect(snapshot.hierarchy.notebook.title).toBe("Local project");
    await expect(
      service.historicalSnapshot(history[0]!.commit, oldest!.commit),
    ).resolves.toMatchObject({ changes: { insertions: 1, deletions: 1 } });
    await expect(
      service.historicalPage(oldest!.commit, section!.manifest.id, page!.id),
    ).resolves.toMatchObject({ manifest: { id: page!.id } });
  });

  it("does not mark local-only changes as a newer GitHub update", async () => {
    const fixture = await createFixture();
    const service = new RepositorySynchronizationService({
      projectRoot: fixture.projectRoot,
      flushCanonical: () => Promise.resolve(),
      cleanupOrphanImageAssets: () => Promise.resolve(),
      reloadCanonical: () => Promise.resolve(),
      allowNonGitHubRemoteForTests: true,
    });
    await service.configure(fixture.remoteUrl);

    const notebook = await fixture.session.loadNotebook();
    await fixture.session.saveNotebook({ ...notebook, title: "Changed locally" });

    await expect(service.check()).resolves.toMatchObject({
      outcome: "sync-needed",
      remoteUpdateAvailable: false,
    });
  });

  it("does not create a new snapshot when local and GitHub trees are identical", async () => {
    const fixture = await createFixture();
    const service = new RepositorySynchronizationService({
      projectRoot: fixture.projectRoot,
      flushCanonical: () => Promise.resolve(),
      cleanupOrphanImageAssets: () => Promise.resolve(),
      reloadCanonical: () => Promise.resolve(),
      allowNonGitHubRemoteForTests: true,
    });
    await service.configure(fixture.remoteUrl);

    await git(fixture.projectRoot, ["commit", "--allow-empty", "-m", "Local history only"]);
    const remoteClone = join(fixture.root, "identical-tree-remote-clone");
    await git(fixture.root, ["clone", fixture.remoteUrl, remoteClone]);
    await configureIdentity(remoteClone);
    await git(remoteClone, ["commit", "--allow-empty", "-m", "Remote history only"]);
    await git(remoteClone, ["push", "origin", "main"]);

    const remoteHead = await gitOutput(fixture.root, [
      `--git-dir=${fixture.remoteUrl.slice("file://".length)}`,
      "rev-parse",
      "refs/heads/main",
    ]);
    await expect(service.check()).resolves.toMatchObject({
      outcome: "up-to-date",
      remoteUpdateAvailable: false,
    });
    await expect(service.comparison()).resolves.toMatchObject({ outcome: "up-to-date" });
    await expect(service.synchronize()).resolves.toMatchObject({ outcome: "up-to-date" });

    expect(await gitOutput(fixture.projectRoot, ["rev-parse", "HEAD"])).toBe(remoteHead);
    expect(
      await gitOutput(fixture.root, [
        `--git-dir=${fixture.remoteUrl.slice("file://".length)}`,
        "rev-parse",
        "refs/heads/main",
      ]),
    ).toBe(remoteHead);
    expect((await service.history())[0]?.message).toBe("Remote history only");
  });

  it("stops on divergent snapshots and preserves both histories when remote wins", async () => {
    const fixture = await createFixture();
    const reloadedProjects: string[] = [];
    const service = new RepositorySynchronizationService({
      projectRoot: fixture.projectRoot,
      flushCanonical: () => Promise.resolve(),
      cleanupOrphanImageAssets: () => Promise.resolve(),
      reloadCanonical: (projectId) => {
        reloadedProjects.push(projectId);
        return Promise.resolve();
      },
      allowNonGitHubRemoteForTests: true,
    });
    await service.configure(fixture.remoteUrl);

    const localNotebook = await fixture.session.loadNotebook();
    await fixture.session.saveNotebook({ ...localNotebook, title: "Local truth candidate" });
    const remoteClone = join(fixture.root, "remote-clone");
    await git(fixture.root, ["clone", fixture.remoteUrl, remoteClone]);
    await configureIdentity(remoteClone);
    const remoteNotebook = JSON.parse(
      await readFile(join(remoteClone, "notebook.json"), "utf8"),
    ) as typeof localNotebook;
    await writeFile(
      join(remoteClone, "notebook.json"),
      serializeCanonicalJson({ ...remoteNotebook, title: "Remote truth candidate" }),
      "utf8",
    );
    await git(remoteClone, ["add", "notebook.json"]);
    await git(remoteClone, ["commit", "-m", "Remote edit"]);
    await git(remoteClone, ["push", "origin", "main"]);

    await expect(service.comparison()).resolves.toMatchObject({ outcome: "conflict" });
    const conflictResult = await service.synchronize();
    expect(conflictResult.outcome).toBe("conflict");
    const conflict = conflictResult.conflict!;
    await expect(
      service.resolveConflict("remote", conflict.local.commit, conflict.remote.commit),
    ).resolves.toMatchObject({ outcome: "synced", projectReloaded: true });
    expect((await fixture.session.loadNotebook()).title).toBe("Remote truth candidate");
    expect(reloadedProjects).toEqual([localNotebook.projectId]);
    expect(
      (await service.history()).some((commit) => commit.message.includes("remote snapshot")),
    ).toBe(true);
  });

  it("uses a lease-protected replacement when the local snapshot wins a conflict", async () => {
    const fixture = await createFixture();
    const service = new RepositorySynchronizationService({
      projectRoot: fixture.projectRoot,
      flushCanonical: () => Promise.resolve(),
      cleanupOrphanImageAssets: () => Promise.resolve(),
      reloadCanonical: () => Promise.resolve(),
      allowNonGitHubRemoteForTests: true,
    });
    await service.configure(fixture.remoteUrl);

    const localNotebook = await fixture.session.loadNotebook();
    await fixture.session.saveNotebook({ ...localNotebook, title: "Local truth" });
    const remoteClone = join(fixture.root, "force-remote-clone");
    await git(fixture.root, ["clone", fixture.remoteUrl, remoteClone]);
    await configureIdentity(remoteClone);
    const remoteNotebook = JSON.parse(
      await readFile(join(remoteClone, "notebook.json"), "utf8"),
    ) as typeof localNotebook;
    await writeFile(
      join(remoteClone, "notebook.json"),
      serializeCanonicalJson({ ...remoteNotebook, title: "Remote truth" }),
      "utf8",
    );
    await git(remoteClone, ["add", "notebook.json"]);
    await git(remoteClone, ["commit", "-m", "Remote force edit"]);
    await git(remoteClone, ["push", "origin", "main"]);

    const conflict = await service.synchronize();
    const localCommit = conflict.conflict!.local.commit;
    const remoteCommit = conflict.conflict!.remote.commit;

    await expect(
      service.resolveConflict("local", localCommit, remoteCommit),
    ).resolves.toMatchObject({
      outcome: "synced",
    });
    expect(
      await gitOutput(join(fixture.root, "remote.git"), ["rev-parse", "refs/heads/main"]),
    ).toBe(localCommit);
    expect(await gitOutput(fixture.projectRoot, ["rev-parse", "HEAD"])).toBe(localCommit);
    expect((await fixture.session.loadNotebook()).title).toBe("Local truth");
  });

  it("combines independent local and GitHub canvas changes into one published snapshot", async () => {
    const fixture = await createFixture();
    const service = new RepositorySynchronizationService({
      projectRoot: fixture.projectRoot,
      flushCanonical: () => Promise.resolve(),
      cleanupOrphanImageAssets: () => Promise.resolve(),
      reloadCanonical: () => Promise.resolve(),
      allowNonGitHubRemoteForTests: true,
    });
    await service.configure(fixture.remoteUrl);

    const hierarchy = new ProjectHierarchyService(fixture.session);
    const notebook = await hierarchy.load();
    const section = notebook.sections[0]!;
    const page = section.pages[0]!;
    const lineId = "323e4567-e89b-42d3-a456-426614174002";
    const textId = "423e4567-e89b-42d3-a456-426614174003";
    const line: CanvasRecord = {
      id: lineId,
      kind: "shape",
      position: [20, 30],
      z: 0,
      geometry: { kind: "line", start: [0, 0], end: [100, 80] },
      style: { strokeColor: "#111111", strokeWidth: 2, fillColor: null, opacity: 1 },
    };
    await hierarchy.savePageContent(section.manifest.id, page.id, [line], {});

    const remoteClone = join(fixture.root, "remote-combine-clone");
    await git(fixture.root, ["clone", fixture.remoteUrl, remoteClone]);
    await configureIdentity(remoteClone);
    const pageRoot = join(remoteClone, "sections", section.manifest.id, "pages", page.id);
    const text: CanvasRecord = {
      id: textId,
      kind: "markdown",
      position: [180, 120],
      z: 0,
      width: 320,
      height: 160,
      source: `markdown/${textId}.md`,
    };
    await mkdir(join(pageRoot, "markdown"), { recursive: true });
    await writeFile(join(pageRoot, "canvas.jsonl"), serializeCanvasJsonLines([text]), "utf8");
    await writeFile(join(pageRoot, "markdown", `${textId}.md`), "# GitHub text\n", "utf8");
    await git(remoteClone, ["add", "."]);
    await git(remoteClone, ["commit", "-m", "GitHub text box"]);
    await git(remoteClone, ["push", "origin", "main"]);

    const conflict = await service.synchronize();
    expect(conflict.outcome).toBe("conflict");
    const preview = await service.mergePreview(
      conflict.conflict!.local.commit,
      conflict.conflict!.remote.commit,
    );
    expect(preview).toMatchObject({ mergeable: true, conflicts: [] });

    const candidatePage = await service.mergeCandidatePage(
      preview.candidateId,
      section.manifest.id,
      page.id,
    );
    expect(candidatePage.canvas.map((record) => record.id)).toEqual([lineId, textId]);
    expect(candidatePage.markdown[textId]).toBe("# GitHub text\n");
    await expect(
      service.applyMergeCandidate(
        preview.candidateId,
        preview.local.commit,
        preview.remote.commit,
        [],
        [],
      ),
    ).resolves.toMatchObject({ outcome: "synced", projectReloaded: true });

    const combined = await hierarchy.loadPage(section.manifest.id, page.id);
    expect(combined.canvas.map((record) => record.id)).toEqual([lineId, textId]);
    expect(combined.markdown[textId]).toBe("# GitHub text\n");
    expect((await service.history())[0]?.message).toContain("Combine local and GitHub snapshots");
  });

  it("uses GitHub as the base when two independently created projects are combined", async () => {
    const fixture = await createFixture();
    const service = new RepositorySynchronizationService({
      projectRoot: fixture.projectRoot,
      flushCanonical: () => Promise.resolve(),
      cleanupOrphanImageAssets: () => Promise.resolve(),
      reloadCanonical: () => Promise.resolve(),
      allowNonGitHubRemoteForTests: true,
    });
    await service.configure(fixture.remoteUrl);
    const localNotebook = await fixture.session.loadNotebook();

    const remoteRoot = join(fixture.root, "independent-github-project");
    const remoteSession = await createProject(remoteRoot, {
      title: "GitHub project",
      initializeGit: true,
    });
    sessions.push(remoteSession);
    await configureIdentity(remoteRoot);
    await git(remoteRoot, ["add", "."]);
    await git(remoteRoot, ["commit", "-m", "Independent GitHub project"]);
    await git(remoteRoot, ["remote", "add", "origin", fixture.remoteUrl]);
    await git(remoteRoot, ["push", "--force", "origin", "HEAD:main"]);
    const remoteNotebook = await remoteSession.loadNotebook();

    const conflict = await service.synchronize();
    const preview = await service.mergePreview(
      conflict.conflict!.local.commit,
      conflict.conflict!.remote.commit,
    );

    expect(preview.baseCommit).toBe(preview.remote.commit);
    expect(preview.mergeable).toBe(true);
    expect(preview.conflicts).toEqual([]);
    expect(preview.hierarchy?.notebook.projectId).toBe(remoteNotebook.projectId);
    expect(preview.hierarchy?.sections).toHaveLength(2);

    await expect(
      service.applyMergeCandidate(
        preview.candidateId,
        preview.local.commit,
        preview.remote.commit,
        [],
        [],
      ),
    ).resolves.toMatchObject({ outcome: "synced" });
    const combined = await new ProjectHierarchyService(fixture.session).load();
    expect(combined.notebook.projectId).toBe(remoteNotebook.projectId);
    expect(combined.sections).toHaveLength(2);
    expect(combined.notebook.projectId).not.toBe(localNotebook.projectId);
  });

  it("rejects a combined snapshot until every overlapping element conflict is resolved", async () => {
    const fixture = await createFixture();
    const service = new RepositorySynchronizationService({
      projectRoot: fixture.projectRoot,
      flushCanonical: () => Promise.resolve(),
      cleanupOrphanImageAssets: () => Promise.resolve(),
      reloadCanonical: () => Promise.resolve(),
      allowNonGitHubRemoteForTests: true,
    });
    await service.configure(fixture.remoteUrl);

    const hierarchy = new ProjectHierarchyService(fixture.session);
    const notebook = await hierarchy.load();
    const section = notebook.sections[0]!;
    const page = section.pages[0]!;
    const elementId = "323e4567-e89b-42d3-a456-426614174002";
    const local: CanvasRecord = {
      id: elementId,
      kind: "shape",
      position: [20, 30],
      z: 0,
      geometry: { kind: "line", start: [0, 0], end: [100, 80] },
      style: { strokeColor: "#111111", strokeWidth: 2, fillColor: null, opacity: 1 },
    };
    await hierarchy.savePageContent(section.manifest.id, page.id, [local], {});

    const remoteClone = join(fixture.root, "remote-overlap-clone");
    await git(fixture.root, ["clone", fixture.remoteUrl, remoteClone]);
    await configureIdentity(remoteClone);
    const pageRoot = join(remoteClone, "sections", section.manifest.id, "pages", page.id);
    const remote = { ...local, position: [180, 30] as const };
    await writeFile(join(pageRoot, "canvas.jsonl"), serializeCanvasJsonLines([remote]), "utf8");
    await git(remoteClone, ["add", "."]);
    await git(remoteClone, ["commit", "-m", "Move element remotely"]);
    await git(remoteClone, ["push", "origin", "main"]);

    const conflict = await service.synchronize();
    const preview = await service.mergePreview(
      conflict.conflict!.local.commit,
      conflict.conflict!.remote.commit,
    );
    expect(preview).toMatchObject({ mergeable: true });
    expect(preview.conflicts).toHaveLength(1);
    expect(preview.conflicts[0]).toMatchObject({
      kind: "canvas-record",
      path: `sections/${section.manifest.id}/pages/${page.id}/canvas.jsonl#${elementId}`,
      editable: true,
    });
    const remotePage = await service.historicalPage(
      preview.remote.commit,
      section.manifest.id,
      page.id,
    );

    await expect(
      service.applyMergeCandidate(
        preview.candidateId,
        preview.local.commit,
        preview.remote.commit,
        [],
        [],
      ),
    ).rejects.toThrow("Resolve every combined snapshot conflict");
    await expect(
      service.applyMergeCandidate(
        preview.candidateId,
        preview.local.commit,
        preview.remote.commit,
        [],
        preview.conflicts.map((entry) => entry.path),
      ),
    ).rejects.toThrow("Submit the edited page");
    await expect(
      service.applyMergeCandidate(
        preview.candidateId,
        preview.local.commit,
        preview.remote.commit,
        [{ sectionId: section.manifest.id, pageId: page.id, page: remotePage }],
        preview.conflicts.map((entry) => entry.path),
      ),
    ).resolves.toMatchObject({ outcome: "synced" });
    expect((await hierarchy.loadPage(section.manifest.id, page.id)).canvas[0]?.position[0]).toBe(
      180,
    );
  });

  it("requires typed confirmation before publishing a clean deletion", async () => {
    const fixture = await createFixture();
    const service = new RepositorySynchronizationService({
      projectRoot: fixture.projectRoot,
      flushCanonical: () => Promise.resolve(),
      cleanupOrphanImageAssets: () => Promise.resolve(),
      reloadCanonical: () => Promise.resolve(),
      allowNonGitHubRemoteForTests: true,
    });
    await service.configure(fixture.remoteUrl);
    const hierarchy = new ProjectHierarchyService(fixture.session);
    const before = await hierarchy.load();
    const section = before.sections[0]!;
    const page = section.pages[0]!;
    await hierarchy.deletePage(section.manifest.id, page.id, true);

    const warning = await service.synchronize();
    expect(warning).toMatchObject({
      outcome: "confirmation-required",
      confirmation: { phrase: "PUBLISH DELETIONS" },
    });
    expect(warning.confirmation?.deletedPaths).toContain(
      `sections/${section.manifest.id}/pages/${page.id}/page.json`,
    );
    await expect(service.synchronize(undefined, "PUBLISH DELETIONS")).resolves.toMatchObject({
      outcome: "synced",
    });
  });

  it("reviews a newer remote deletion before applying its exact tree", async () => {
    const fixture = await createFixture();
    const hierarchy = new ProjectHierarchyService(fixture.session);
    const tree = await hierarchy.load();
    const section = tree.sections[0]!;
    const page = section.pages[0]!;
    const markdownId = "323e4567-e89b-42d3-a456-426614174002";
    await hierarchy.savePageContent(
      section.manifest.id,
      page.id,
      [
        {
          id: markdownId,
          kind: "markdown",
          position: [0, 0],
          z: 0,
          width: 320,
          height: 160,
          source: `markdown/${markdownId}.md`,
        },
      ],
      { [markdownId]: "local content that remote removes" },
    );
    const reloadedProjects: string[] = [];
    const service = new RepositorySynchronizationService({
      projectRoot: fixture.projectRoot,
      flushCanonical: () => Promise.resolve(),
      cleanupOrphanImageAssets: () => Promise.resolve(),
      reloadCanonical: (projectId) => {
        reloadedProjects.push(projectId);
        return Promise.resolve();
      },
      allowNonGitHubRemoteForTests: true,
    });
    await service.configure(fixture.remoteUrl);

    const remoteClone = join(fixture.root, "remote-deletion-clone");
    await git(fixture.root, ["clone", fixture.remoteUrl, remoteClone]);
    await configureIdentity(remoteClone);
    const remoteNotebook = JSON.parse(
      await readFile(join(remoteClone, "notebook.json"), "utf8"),
    ) as Awaited<ReturnType<ProjectSession["loadNotebook"]>>;
    await writeFile(
      join(remoteClone, "notebook.json"),
      serializeCanonicalJson({ ...remoteNotebook, title: "Authoritative remote snapshot" }),
      "utf8",
    );
    const pageRoot = join(remoteClone, "sections", section.manifest.id, "pages", page.id);
    await writeFile(join(pageRoot, "canvas.jsonl"), "", "utf8");
    await rm(join(pageRoot, "markdown", `${markdownId}.md`));
    await git(remoteClone, ["add", "."]);
    await git(remoteClone, ["commit", "-m", "Remote snapshot removes content"]);
    await git(remoteClone, ["push", "origin", "main"]);

    const warning = await service.synchronize();
    expect(warning).toMatchObject({
      outcome: "review-required",
      review: { kind: "remote-update" },
    });
    expect((await fixture.session.loadNotebook()).title).toBe("Local project");
    expect(reloadedProjects).toEqual([]);

    const review = warning.review!;
    await expect(
      service.applyRemoteSnapshot(review.local.commit, review.remote.commit),
    ).resolves.toMatchObject({
      outcome: "synced",
      projectReloaded: true,
    });
    expect((await fixture.session.loadNotebook()).title).toBe("Authoritative remote snapshot");
    expect((await hierarchy.loadPage(section.manifest.id, page.id)).canvas).toEqual([]);
    expect(reloadedProjects).toEqual([remoteNotebook.projectId]);
    const resolutionParents = (
      await gitOutput(fixture.projectRoot, ["rev-list", "--parents", "-n", "1", "HEAD"])
    )
      .trim()
      .split(/\s+/);
    expect(resolutionParents).toHaveLength(3);
    expect(resolutionParents).toContain(review.local.commit);
    expect(resolutionParents).toContain(review.remote.commit);
    expect((await service.history())[0]?.message).toContain("GitHub snapshot");
  });

  it("restores over a dirty current snapshot without implicitly publishing that snapshot", async () => {
    const fixture = await createFixture();
    const reloadedProjects: string[] = [];
    const service = new RepositorySynchronizationService({
      projectRoot: fixture.projectRoot,
      flushCanonical: () => Promise.resolve(),
      cleanupOrphanImageAssets: () => Promise.resolve(),
      reloadCanonical: (projectId) => {
        reloadedProjects.push(projectId);
        return Promise.resolve();
      },
      allowNonGitHubRemoteForTests: true,
    });
    await service.configure(fixture.remoteUrl);
    const selected = (await service.history())[0]!;
    const remoteBefore = await gitOutput(fixture.root, [
      `--git-dir=${fixture.remoteUrl.slice("file://".length)}`,
      "rev-parse",
      "refs/heads/main",
    ]);

    const notebook = await fixture.session.loadNotebook();
    await fixture.session.saveNotebook({ ...notebook, title: "Dirty stale current snapshot" });
    const warning = await service.restore(selected.commit, selected.commit, undefined);
    expect(warning).toMatchObject({
      outcome: "confirmation-required",
      confirmation: { phrase: `RESTORE ${selected.commit.slice(0, 7)}` },
    });
    expect((await fixture.session.loadNotebook()).title).toBe("Dirty stale current snapshot");
    expect(
      await gitOutput(fixture.root, [
        `--git-dir=${fixture.remoteUrl.slice("file://".length)}`,
        "rev-parse",
        "refs/heads/main",
      ]),
    ).toBe(remoteBefore);

    await expect(
      service.restore(selected.commit, selected.commit, `RESTORE ${selected.commit.slice(0, 7)}`),
    ).resolves.toMatchObject({ outcome: "synced", projectReloaded: true });
    expect((await fixture.session.loadNotebook()).title).toBe("Local project");
    expect(reloadedProjects).toEqual([notebook.projectId]);
  });
});

async function createFixture(): Promise<{
  readonly root: string;
  readonly projectRoot: string;
  readonly remoteUrl: string;
  readonly session: ProjectSession;
}> {
  const root = await mkdtemp(join(tmpdir(), "squillpad-repository-sync-"));
  roots.push(root);
  const projectRoot = join(root, "project");
  const remoteRoot = join(root, "remote.git");
  await mkdir(remoteRoot);
  await git(remoteRoot, ["init", "--bare", "--initial-branch=main"]);
  const session = await createProject(projectRoot, { title: "Local project" });
  sessions.push(session);
  await git(projectRoot, ["init", "--initial-branch=main"]);
  await configureIdentity(projectRoot);
  return { root, projectRoot, remoteUrl: `file://${remoteRoot}`, session };
}

async function configureIdentity(directory: string): Promise<void> {
  await git(directory, ["config", "user.name", "SquillPad Test"]);
  await git(directory, ["config", "user.email", "squillpad@example.invalid"]);
}

async function git(directory: string, args: readonly string[]): Promise<void> {
  await execute("git", [...args], { cwd: directory, encoding: "utf8" });
}

async function gitOutput(directory: string, args: readonly string[]): Promise<string> {
  const result = await execute("git", [...args], { cwd: directory, encoding: "utf8" });
  return result.stdout.trim();
}
