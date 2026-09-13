import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  serializeCanonicalJson,
  serializeCanvasJsonLines,
  validateCanvasRecords,
  validateNotebookManifest,
  validatePageManifest,
  validateProfileSettingsRecord,
  validateSectionManifest,
  type CanvasRecord,
  type NotebookHierarchy,
  type PageManifest,
  type ValidationResult,
} from "@squillpad/core-model";
import type { StoredPage } from "@squillpad/storage";

import {
  mergeCanonicalFiles,
  mergeCanonicalFilesWithGitHubBase,
  type RepositoryMergeConflict,
} from "./repository-merge.js";

const REMOTE_NAME = "squillpad-sync";
const SYNC_BRANCH_KEY = "squillpad.syncBranch";
const GIT_OUTPUT_LIMIT = 128 * 1024 * 1024;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface RepositorySynchronizationOptions {
  readonly projectRoot: string;
  readonly flushCanonical: () => Promise<void>;
  readonly flushProfileSettings?: () => Promise<void>;
  readonly cleanupOrphanImageAssets: () => Promise<unknown>;
  readonly reloadCanonical: (projectId: string) => Promise<void>;
  readonly beginExclusiveCanonicalOperation?: () => Promise<() => void>;
  readonly beginExclusiveProfileOperation?: () => Promise<() => void>;
  readonly allowNonGitHubRemoteForTests?: boolean;
}

export interface RepositorySynchronizationStatus {
  readonly available: true;
  readonly configured: boolean;
  readonly remoteUrl?: string;
  readonly branch?: string;
}

export interface RepositorySynchronizationCheck {
  readonly outcome: "up-to-date" | "sync-needed";
  readonly message: string;
  readonly remoteUpdateAvailable: boolean;
  readonly review?: RepositorySnapshotReview;
}

export interface RepositorySnapshotReview {
  readonly kind: "remote-update" | "conflict";
  readonly local: RepositoryCommitSummary;
  readonly remote: RepositoryCommitSummary;
  readonly publishLocal: RepositoryLineChanges;
  readonly applyRemote: RepositoryLineChanges;
}

export interface RepositoryLineChanges {
  readonly insertions: number;
  readonly deletions: number;
}

export interface RepositorySynchronizationComparison {
  readonly outcome: "up-to-date" | "publish-local" | "apply-remote" | "conflict";
  readonly publishLocal: RepositoryLineChanges;
  readonly applyRemote: RepositoryLineChanges;
  readonly review?: RepositorySnapshotReview;
}

export interface RepositoryCommitSummary {
  readonly commit: string;
  readonly timestamp: string;
  readonly author: string;
  readonly message: string;
  readonly changedPaths: readonly string[];
  readonly affectedPages: readonly AffectedPage[];
}

export interface AffectedPage {
  readonly sectionId: string;
  readonly pageId: string;
  readonly title: string;
}

export interface RepositoryConflict {
  readonly local: RepositoryCommitSummary;
  readonly remote: RepositoryCommitSummary;
  readonly publishLocal: RepositoryLineChanges;
  readonly applyRemote: RepositoryLineChanges;
}

export interface RepositoryConfirmation {
  readonly phrase: string;
  readonly deletedPaths: readonly string[];
}

export interface RepositorySynchronizationResult {
  readonly outcome:
    | "synced"
    | "up-to-date"
    | "conflict"
    | "confirmation-required"
    | "review-required";
  readonly message: string;
  readonly projectReloaded?: boolean;
  readonly conflict?: RepositoryConflict;
  readonly confirmation?: RepositoryConfirmation;
  readonly review?: RepositorySnapshotReview;
}

export interface RepositoryMergePreview {
  readonly candidateId: string;
  readonly baseCommit: string;
  readonly local: RepositoryCommitSummary;
  readonly remote: RepositoryCommitSummary;
  readonly conflicts: readonly RepositoryMergeConflict[];
  readonly mergeable: boolean;
  readonly hierarchy?: NotebookHierarchy;
}

export interface RepositoryMergePageOverride {
  readonly sectionId: string;
  readonly pageId: string;
  readonly page: unknown;
}

export interface HistoricalSnapshot {
  readonly commit: string;
  readonly hierarchy: NotebookHierarchy;
  readonly changes: RepositoryLineChanges;
}

interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

interface TreeEntry {
  readonly mode: string;
  readonly type: string;
  readonly path: string;
}

interface MergeCandidate {
  readonly id: string;
  readonly localCommit: string;
  readonly remoteCommit: string;
  readonly tree: string;
  readonly files: ReadonlyMap<string, Buffer>;
  readonly hierarchy?: NotebookHierarchy;
  readonly conflicts: readonly RepositoryMergeConflict[];
}

interface WorkingTreePreview {
  readonly tree: string;
  readonly baseHead: string | undefined;
  readonly hierarchy: NotebookHierarchy;
}

/** Synchronizes one open canonical project through a dedicated GitHub repository. */
export class RepositorySynchronizationService {
  readonly #options: RepositorySynchronizationOptions;
  readonly #mergeCandidates = new Map<string, MergeCandidate>();
  readonly #workingTreePreviews = new Map<string, WorkingTreePreview>();
  #pending: Promise<unknown> = Promise.resolve();
  #mutationActive = false;

  constructor(options: RepositorySynchronizationOptions) {
    this.#options = options;
  }

  get mutationActive(): boolean {
    return this.#mutationActive;
  }

  /** Resolves after repository work already requested by the host has settled. */
  async settled(): Promise<void> {
    await this.#pending;
  }

  async status(): Promise<RepositorySynchronizationStatus> {
    if (!(await this.#hasGitRepository())) return { available: true, configured: false };
    const remoteUrl = await this.#optionalGit(["remote", "get-url", REMOTE_NAME]);
    const branch = await this.#optionalGit(["config", "--get", SYNC_BRANCH_KEY]);
    return {
      available: true,
      configured: remoteUrl !== undefined && branch !== undefined,
      ...(remoteUrl === undefined ? {} : { remoteUrl }),
      ...(branch === undefined ? {} : { branch }),
    };
  }

  check(): Promise<RepositorySynchronizationCheck> {
    return this.#serialize(() => this.#mutate(() => this.#check()));
  }

  comparison(): Promise<RepositorySynchronizationComparison> {
    return this.#serialize(() =>
      this.#mutate(async () => {
        await this.#assertConfigured();
        await this.#assertCleanGitOperation();
        await this.#assertDedicatedLocalRoot();
        const branch = await this.#configuredBranch();
        const remote = await this.#discoverRemote();
        if (remote === undefined || remote.branch !== branch) {
          throw new Error("The configured GitHub branch changed. Synchronize to review it.");
        }
        await this.#fetch(branch);
        const remoteHead = await this.#fetchedHead(branch);
        await this.#loadHierarchy(remoteHead);
        const localHead = await this.#requiredGit(
          ["rev-parse", "--verify", "HEAD"],
          "Git could not inspect the local snapshot",
        );
        assertCommit(localHead);
        const publishLocal = await this.#workingTreeLineChanges(remoteHead);
        const applyRemote = {
          insertions: publishLocal.deletions,
          deletions: publishLocal.insertions,
        };
        const workingTree = await this.#git([
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
          "--",
          ".",
        ]);
        const dirty = workingTree.stdout.trim().length > 0;
        const sameTree = (await this.#tree(localHead)) === (await this.#tree(remoteHead));

        if (sameTree && !dirty) {
          return { outcome: "up-to-date", publishLocal, applyRemote };
        }
        if (sameTree) return { outcome: "publish-local", publishLocal, applyRemote };
        if (await this.#isAncestor(remoteHead, localHead)) {
          return { outcome: "publish-local", publishLocal, applyRemote };
        }
        if (await this.#isAncestor(localHead, remoteHead)) {
          if (!dirty) return { outcome: "apply-remote", publishLocal, applyRemote };
          return {
            outcome: "conflict",
            publishLocal,
            applyRemote,
            review: await this.#workingTreeReview(localHead, remoteHead, "conflict"),
          };
        }
        return {
          outcome: "conflict",
          publishLocal,
          applyRemote,
          review: await this.#workingTreeReview(localHead, remoteHead, "conflict"),
        };
      }),
    );
  }

  configure(
    url: string,
    note?: string,
    confirmation?: string,
  ): Promise<RepositorySynchronizationResult> {
    return this.#serialize(() =>
      this.#mutate(async () => {
        const normalizedUrl =
          this.#options.allowNonGitHubRemoteForTests === true ? url.trim() : validateGitHubUrl(url);
        await this.#ensureRepository();
        await this.#assertCleanGitOperation();
        const existingUrl = await this.#optionalGit(["remote", "get-url", REMOTE_NAME]);
        if (existingUrl === undefined) {
          await this.#git(["remote", "add", REMOTE_NAME, normalizedUrl]);
        } else if (existingUrl !== normalizedUrl) {
          throw new Error(
            `This project is already linked to ${existingUrl}. Remove that link explicitly before connecting another repository.`,
          );
        }

        const remote = await this.#discoverRemote();
        const localHead = await this.#commitCanonicalSnapshot(note);
        if (remote === undefined) {
          const branch = await this.#currentBranch();
          await this.#git(["config", SYNC_BRANCH_KEY, branch]);
          await this.#push(localHead, branch);
          return {
            outcome: "synced",
            message: `Published the first project snapshot to ${branch}.`,
          };
        }

        await this.#git(["config", SYNC_BRANCH_KEY, remote.branch]);
        await this.#fetch(remote.branch);
        const remoteHead = await this.#fetchedHead(remote.branch);
        await this.#loadHierarchy(remoteHead);
        return this.#synchronizeHeads(localHead, remoteHead, remote.branch, confirmation);
      }),
    );
  }

  synchronize(note?: string, confirmation?: string): Promise<RepositorySynchronizationResult> {
    return this.#serialize(() =>
      this.#mutate(async () => {
        await this.#assertConfigured();
        await this.#assertCleanGitOperation();
        const branch = await this.#configuredBranch();
        const localHead = await this.#commitCanonicalSnapshot(note);
        const remote = await this.#discoverRemote();
        if (remote === undefined) {
          throw new Error(
            "The configured GitHub branch no longer exists. No local files were changed; restore the branch on GitHub or reconnect the repository.",
          );
        }
        if (remote.branch !== branch) {
          throw new Error(
            `GitHub now reports ${remote.branch} as its default branch, but this project is linked to ${branch}. Reconnect deliberately before changing branches.`,
          );
        }
        await this.#fetch(branch);
        const remoteHead = await this.#fetchedHead(branch);
        await this.#loadHierarchy(remoteHead);
        return this.#synchronizeHeads(localHead, remoteHead, branch, confirmation);
      }),
    );
  }

  applyRemoteSnapshot(
    expectedLocal: string,
    expectedRemote: string,
  ): Promise<RepositorySynchronizationResult> {
    return this.#serialize(() =>
      this.#mutate(async () => {
        assertCommit(expectedLocal);
        assertCommit(expectedRemote);
        await this.#assertConfigured();
        await this.#assertCleanGitOperation();
        const branch = await this.#configuredBranch();
        const materializedLocal = await this.#materializeReviewedLocal(expectedLocal);
        const localHead = materializedLocal.head;
        const remote = await this.#discoverRemote();
        if (remote === undefined || remote.branch !== branch) {
          throw new Error("The GitHub branch changed while the snapshot review was open.");
        }
        await this.#fetch(branch);
        const remoteHead = await this.#fetchedHead(branch);
        if (
          (!materializedLocal.preview && localHead !== expectedLocal) ||
          remoteHead !== expectedRemote
        ) {
          return this.#synchronizeHeads(localHead, remoteHead, branch);
        }
        if ((await this.#tree(localHead)) === (await this.#tree(remoteHead))) {
          await this.#adoptRemoteHead(remoteHead);
          this.#workingTreePreviews.delete(expectedLocal);
          return {
            outcome: "up-to-date",
            message: "Local and GitHub snapshots contain identical project content.",
          };
        }
        const selected = await this.#loadHierarchy(remoteHead);
        const resolution = await this.#resolutionCommit(
          remoteHead,
          [localHead, remoteHead],
          "Resolve synchronization using GitHub snapshot",
        );
        await this.#applyCommit(resolution, selected.notebook.projectId);
        await this.#push(resolution, branch);
        this.#workingTreePreviews.delete(expectedLocal);
        return {
          outcome: "synced",
          message:
            "Applied the reviewed GitHub project snapshot; both histories remain preserved in a resolution commit.",
          projectReloaded: true,
        };
      }),
    );
  }

  mergePreview(localCommit: string, remoteCommit: string): Promise<RepositoryMergePreview> {
    return this.#serialize(async () => {
      assertCommit(localCommit);
      assertCommit(remoteCommit);
      await this.#assertConfigured();
      await this.#assertCleanGitOperation();
      await this.#assertDedicatedLocalRoot();
      const branch = await this.#configuredBranch();
      const localHead = await this.#requiredGit(
        ["rev-parse", "--verify", "HEAD"],
        "Git could not inspect the local snapshot",
      );
      assertCommit(localHead);
      const localPreview = this.#workingTreePreviews.get(localCommit);
      if (localPreview === undefined) {
        if (localHead !== localCommit) {
          throw new Error("The local snapshot changed while the conflict review was open.");
        }
      } else {
        await this.#assertWorkingTreePreviewCurrent(localPreview, localHead);
      }
      await this.#fetch(branch);
      const remoteHead = await this.#fetchedHead(branch);
      if (remoteHead !== remoteCommit) {
        throw new Error("The GitHub snapshot changed while the conflict review was open.");
      }
      return this.#createMergeCandidate(
        localPreview === undefined ? localHead : localCommit,
        remoteHead,
      );
    });
  }

  mergeCandidatePage(candidateId: string, sectionId: string, pageId: string): Promise<StoredPage> {
    return this.#serialize(async () => {
      assertId(sectionId, "section ID");
      assertId(pageId, "page ID");
      const candidate = this.#mergeCandidates.get(candidateId);
      if (candidate === undefined || candidate.hierarchy === undefined) {
        throw new Error(
          "The combined snapshot preview is unavailable. Start synchronization again.",
        );
      }
      const section = candidate.hierarchy.sections.find((entry) => entry.manifest.id === sectionId);
      if (!section?.manifest.pageIds.includes(pageId)) {
        throw new Error("That page does not exist in the combined snapshot preview");
      }
      return this.#loadPage(candidate.tree, sectionId, pageId);
    });
  }

  applyMergeCandidate(
    candidateId: string,
    expectedLocal: string,
    expectedRemote: string,
    pageOverrides: readonly RepositoryMergePageOverride[],
    resolvedConflictPaths: readonly string[],
  ): Promise<RepositorySynchronizationResult> {
    return this.#serialize(() =>
      this.#mutate(async () => {
        assertCommit(expectedLocal);
        assertCommit(expectedRemote);
        await this.#assertConfigured();
        await this.#assertCleanGitOperation();
        await this.#assertDedicatedLocalRoot();
        const candidate = this.#mergeCandidates.get(candidateId);
        if (candidate === undefined || candidate.hierarchy === undefined) {
          throw new Error(
            "The combined snapshot preview is unavailable. Start synchronization again.",
          );
        }
        if (
          candidate.localCommit !== expectedLocal ||
          candidate.remoteCommit !== expectedRemote ||
          candidate.conflicts.some((conflict) => !conflict.editable)
        ) {
          throw new Error("This combined snapshot contains conflicts that cannot be edited here.");
        }
        const requiredConflictPaths = candidate.conflicts.map((conflict) => conflict.path);
        const resolvedPaths = new Set(resolvedConflictPaths);
        if (
          resolvedPaths.size !== resolvedConflictPaths.length ||
          requiredConflictPaths.length !== resolvedPaths.size ||
          requiredConflictPaths.some((path) => !resolvedPaths.has(path))
        ) {
          throw new Error("Resolve every combined snapshot conflict before publishing it.");
        }
        const overrideKeys = new Set(
          pageOverrides.map((override) => `${override.sectionId}:${override.pageId}`),
        );
        if (overrideKeys.size !== pageOverrides.length) {
          throw new Error("Each combined snapshot page may be submitted only once.");
        }
        for (const path of requiredConflictPaths) {
          const identity = conflictPageIdentity(path);
          if (
            identity === undefined ||
            !overrideKeys.has(`${identity.sectionId}:${identity.pageId}`)
          ) {
            throw new Error("Submit the edited page for every resolved snapshot conflict.");
          }
        }
        const branch = await this.#configuredBranch();
        const materializedLocal = await this.#materializeReviewedLocal(expectedLocal);
        const localHead = materializedLocal.head;
        const remote = await this.#discoverRemote();
        if (remote === undefined || remote.branch !== branch) {
          throw new Error(
            "The GitHub branch changed while the combined snapshot was being edited.",
          );
        }
        await this.#fetch(branch);
        const remoteHead = await this.#fetchedHead(branch);
        if (
          (!materializedLocal.preview && localHead !== expectedLocal) ||
          remoteHead !== expectedRemote
        ) {
          throw new Error(
            "The local or GitHub snapshot changed while the combined snapshot was being edited.",
          );
        }

        const files = new Map(
          [...candidate.files].map(([path, contents]) => [path, Buffer.from(contents)] as const),
        );
        for (const override of pageOverrides) this.#applyMergePageOverride(files, override);
        const tree = await this.#writeTree(files);
        const selected = await this.#loadHierarchy(tree);
        const resolution = await this.#resolutionCommitTree(
          tree,
          [localHead, remoteHead],
          "Combine local and GitHub snapshots",
        );
        await this.#applyCommit(resolution, selected.notebook.projectId);
        await this.#push(resolution, branch);
        this.#mergeCandidates.delete(candidateId);
        this.#workingTreePreviews.delete(expectedLocal);
        return {
          outcome: "synced",
          message: "Combined the reviewed snapshots and published the result to GitHub.",
          projectReloaded: true,
        };
      }),
    );
  }

  resolveConflict(
    choice: "local" | "remote",
    expectedLocal: string,
    expectedRemote: string,
  ): Promise<RepositorySynchronizationResult> {
    return this.#serialize(() =>
      this.#mutate(async () => {
        assertCommit(expectedLocal);
        assertCommit(expectedRemote);
        await this.#assertConfigured();
        await this.#assertCleanGitOperation();
        const branch = await this.#configuredBranch();
        const materializedLocal = await this.#materializeReviewedLocal(expectedLocal);
        const localHead = materializedLocal.head;
        const remote = await this.#discoverRemote();
        if (remote === undefined || remote.branch !== branch) {
          throw new Error(
            "The GitHub branch changed while the conflict dialog was open. Sync again.",
          );
        }
        await this.#fetch(branch);
        const remoteHead = await this.#fetchedHead(branch);
        if (
          (!materializedLocal.preview && localHead !== expectedLocal) ||
          remoteHead !== expectedRemote
        ) {
          return this.#synchronizeHeads(localHead, remoteHead, branch);
        }

        if ((await this.#tree(localHead)) === (await this.#tree(remoteHead))) {
          await this.#adoptRemoteHead(remoteHead);
          this.#workingTreePreviews.delete(expectedLocal);
          return {
            outcome: "up-to-date",
            message: "Local and GitHub snapshots contain identical project content.",
          };
        }

        if (choice === "local") {
          await this.#forcePush(localHead, branch, remoteHead);
          this.#workingTreePreviews.delete(expectedLocal);
          return {
            outcome: "synced",
            message: "Published the local snapshot to GitHub with a lease-protected replacement.",
          };
        }

        const selectedCommit = remoteHead;
        const selected = await this.#loadHierarchy(selectedCommit);
        const resolution = await this.#resolutionCommit(
          selectedCommit,
          [localHead, remoteHead],
          `Resolve synchronization using ${choice} snapshot`,
        );
        await this.#applyCommit(resolution, selected.notebook.projectId);
        await this.#push(resolution, branch);
        this.#workingTreePreviews.delete(expectedLocal);
        return {
          outcome: "synced",
          message: `The ${choice} snapshot is now global truth; both histories remain preserved.`,
          projectReloaded: selectedCommit !== localHead,
        };
      }),
    );
  }

  history(limit = 100): Promise<readonly RepositoryCommitSummary[]> {
    return this.#serialize(async () => {
      await this.#assertConfigured();
      const boundedLimit = Math.max(1, Math.min(200, Math.floor(limit)));
      const output = await this.#git([
        "log",
        `--max-count=${boundedLimit}`,
        "--topo-order",
        "--format=%H%x1f%cI%x1f%an%x1f%s%x1e",
        "HEAD",
      ]);
      const records = output.stdout
        .split("\u001e")
        .map((record) => record.trim())
        .filter((record) => record.length > 0);
      return Promise.all(
        records.map(async (record) => {
          const [commit, timestamp, author, message] = record.split("\u001f");
          if (
            commit === undefined ||
            timestamp === undefined ||
            author === undefined ||
            message === undefined
          ) {
            throw new Error("Git returned malformed history metadata");
          }
          return this.#commitSummary(commit, { timestamp, author, message });
        }),
      );
    });
  }

  historicalSnapshot(commit: string, compareTo?: string): Promise<HistoricalSnapshot> {
    return this.#serialize(async () => {
      assertCommit(commit);
      if (compareTo !== undefined) assertCommit(compareTo);
      const preview = this.#workingTreePreviews.get(commit);
      if (preview !== undefined) {
        return {
          commit,
          hierarchy: preview.hierarchy,
          changes:
            compareTo === undefined
              ? await this.#workingTreeLineChanges(commit)
              : await this.#commitLineChanges(compareTo, commit),
        };
      }
      await this.#assertPreviewReachable(commit);
      if (compareTo !== undefined) await this.#assertPreviewReachable(compareTo);
      return {
        commit,
        hierarchy: await this.#loadHierarchy(commit),
        changes:
          compareTo === undefined
            ? await this.#workingTreeLineChanges(commit)
            : await this.#commitLineChanges(compareTo, commit),
      };
    });
  }

  historicalPage(commit: string, sectionId: string, pageId: string): Promise<StoredPage> {
    return this.#serialize(async () => {
      assertCommit(commit);
      assertId(sectionId, "section ID");
      assertId(pageId, "page ID");
      const preview = this.#workingTreePreviews.get(commit);
      if (preview === undefined) await this.#assertPreviewReachable(commit);
      const hierarchy = preview?.hierarchy ?? (await this.#loadHierarchy(commit));
      const section = hierarchy.sections.find((entry) => entry.manifest.id === sectionId);
      if (!section?.manifest.pageIds.includes(pageId)) {
        throw new Error("That page does not exist in the selected historical snapshot");
      }
      return this.#loadPage(commit, sectionId, pageId);
    });
  }

  restore(
    commit: string,
    expectedHead: string,
    confirmation: string | undefined,
  ): Promise<RepositorySynchronizationResult> {
    return this.#serialize(() =>
      this.#mutate(async () => {
        assertCommit(commit);
        assertCommit(expectedHead);
        await this.#assertConfigured();
        await this.#assertCleanGitOperation();
        const branch = await this.#configuredBranch();
        const localHead = await this.#commitCanonicalSnapshot();
        const remote = await this.#discoverRemote();
        if (remote === undefined || remote.branch !== branch) {
          throw new Error("The configured GitHub branch is unavailable. No snapshot was restored.");
        }
        await this.#fetch(branch);
        const remoteHead = await this.#fetchedHead(branch);
        if (remoteHead !== expectedHead || !(await this.#isAncestor(expectedHead, localHead))) {
          throw new Error(
            "The project or GitHub branch changed after history was opened. No remote snapshot was changed; synchronize, reopen Previous snapshots, and try again.",
          );
        }
        await this.#assertReachable(commit);
        const phrase = `RESTORE ${commit.slice(0, 7)}`;
        const deletedPaths = await this.#deletedPaths(localHead, commit);
        if (confirmation !== phrase) {
          return {
            outcome: "confirmation-required",
            message: `Type ${phrase} to restore this snapshot as a new commit.`,
            confirmation: { phrase, deletedPaths },
          };
        }

        const selected = await this.#loadHierarchy(commit);
        const restored = await this.#resolutionCommit(
          commit,
          [localHead],
          `Restore snapshot ${commit.slice(0, 7)}`,
        );
        await this.#applyCommit(restored, selected.notebook.projectId);
        await this.#push(restored, branch);
        return {
          outcome: "synced",
          message: `Restored ${commit.slice(0, 7)} as a new snapshot without deleting Git history.`,
          projectReloaded: true,
        };
      }),
    );
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#pending.then(operation, operation);
    this.#pending = result.catch(() => undefined);
    return result;
  }

  async #mutate<T>(operation: () => Promise<T>): Promise<T> {
    this.#mutationActive = true;
    let releaseCanonical: (() => void) | undefined;
    let releaseProfile: (() => void) | undefined;
    try {
      releaseCanonical = await this.#options.beginExclusiveCanonicalOperation?.();
      releaseProfile = await this.#options.beginExclusiveProfileOperation?.();
      await this.#options.flushCanonical();
      await this.#options.flushProfileSettings?.();
      await this.#options.cleanupOrphanImageAssets();
      return await operation();
    } finally {
      releaseProfile?.();
      releaseCanonical?.();
      this.#mutationActive = false;
    }
  }

  async #synchronizeHeads(
    localHead: string,
    remoteHead: string,
    branch: string,
    confirmation?: string,
  ): Promise<RepositorySynchronizationResult> {
    if (localHead === remoteHead) {
      return { outcome: "up-to-date", message: "Local and GitHub snapshots are up to date." };
    }
    const sameTree = (await this.#tree(localHead)) === (await this.#tree(remoteHead));
    if (sameTree) {
      await this.#adoptRemoteHead(remoteHead);
      return {
        outcome: "up-to-date",
        message: "Local and GitHub snapshots contain identical project content.",
      };
    }
    if (await this.#isAncestor(remoteHead, localHead)) {
      const deletedPaths = await this.#deletedPaths(remoteHead, localHead);
      if (deletedPaths.length > 0 && confirmation !== "PUBLISH DELETIONS") {
        return {
          outcome: "confirmation-required",
          message: "The local snapshot deletes content that currently exists on GitHub.",
          confirmation: { phrase: "PUBLISH DELETIONS", deletedPaths },
        };
      }
      await this.#push(localHead, branch);
      return { outcome: "synced", message: "Published the local snapshot to GitHub." };
    }
    if (await this.#isAncestor(localHead, remoteHead)) {
      return {
        outcome: "review-required",
        message: "GitHub has a newer project snapshot ready for visual review.",
        review: await this.#snapshotReview(localHead, remoteHead),
      };
    }
    const review = await this.#snapshotReview(localHead, remoteHead, "conflict");
    return {
      outcome: "conflict",
      message:
        "Local and GitHub both changed. Review the snapshots and choose how to combine them.",
      conflict: {
        local: review.local,
        remote: review.remote,
        publishLocal: review.publishLocal,
        applyRemote: review.applyRemote,
      },
    };
  }

  async #snapshotReview(
    localHead: string,
    remoteHead: string,
    kind: RepositorySnapshotReview["kind"] = "remote-update",
  ): Promise<RepositorySnapshotReview> {
    const [local, remote] = await Promise.all([
      this.#commitSummary(localHead),
      this.#commitSummary(remoteHead),
    ]);
    const publishLocal = await this.#commitLineChanges(remoteHead, localHead);
    return {
      kind,
      local,
      remote,
      publishLocal,
      applyRemote: invertLineChanges(publishLocal),
    };
  }

  async #workingTreeReview(
    localHead: string | undefined,
    remoteHead: string,
    kind: RepositorySnapshotReview["kind"],
    dirty = true,
  ): Promise<RepositorySnapshotReview> {
    const local =
      dirty || localHead === undefined
        ? await this.#workingTreeSummary(localHead)
        : await this.#commitSummary(localHead);
    const remote = await this.#commitSummary(remoteHead);
    const publishLocal = await this.#commitLineChanges(remoteHead, local.commit);
    return {
      kind,
      local,
      remote,
      publishLocal,
      applyRemote: invertLineChanges(publishLocal),
    };
  }

  async #createMergeCandidate(
    localHead: string,
    remoteHead: string,
  ): Promise<RepositoryMergePreview> {
    const commonBase = await this.#optionalGit(["merge-base", localHead, remoteHead]);
    const baseCommit = commonBase ?? remoteHead;
    await this.#loadHierarchy(remoteHead);
    if (commonBase !== undefined) await this.#loadHierarchy(commonBase);
    const [localFiles, remoteFiles] = await Promise.all([
      this.#canonicalFiles(localHead),
      this.#canonicalFiles(remoteHead),
    ]);
    const merged =
      commonBase === undefined
        ? mergeCanonicalFilesWithGitHubBase(localFiles, remoteFiles)
        : mergeCanonicalFiles(await this.#canonicalFiles(commonBase), localFiles, remoteFiles);
    const tree = await this.#writeTree(merged.files);
    let hierarchy: NotebookHierarchy | undefined;
    const conflicts = [...merged.conflicts];
    try {
      hierarchy = await this.#loadHierarchy(tree);
    } catch (error) {
      conflicts.push({
        kind: "canonical-field",
        path: "project",
        message: `The combined snapshot failed full-project validation: ${errorMessage(error)}`,
        editable: false,
      });
    }
    const candidateId = randomUUID();
    const candidate: MergeCandidate = {
      id: candidateId,
      localCommit: localHead,
      remoteCommit: remoteHead,
      tree,
      files: merged.files,
      conflicts,
      ...(hierarchy === undefined ? {} : { hierarchy }),
    };
    this.#mergeCandidates.set(candidateId, candidate);
    while (this.#mergeCandidates.size > 8) {
      const oldest = this.#mergeCandidates.keys().next().value;
      if (oldest === undefined) break;
      this.#mergeCandidates.delete(oldest);
    }
    const local = await this.#commitSummary(localHead);
    const remote = await this.#commitSummary(remoteHead);
    return {
      candidateId,
      baseCommit,
      local,
      remote,
      conflicts,
      mergeable: hierarchy !== undefined && conflicts.every((conflict) => conflict.editable),
      ...(hierarchy === undefined ? {} : { hierarchy }),
    };
  }

  async #canonicalFiles(commit: string): Promise<ReadonlyMap<string, Buffer>> {
    const entries = await this.#treeEntries(commit);
    const files = new Map<string, Buffer>();
    for (const entry of entries) {
      if (entry.type !== "blob" || entry.mode !== "100644") {
        throw new Error(`Git snapshot contains an unsupported link or object: ${entry.path}`);
      }
      if (!isAllowedProjectPath(entry.path)) {
        throw new Error(`Git snapshot contains an unexpected project path: ${entry.path}`);
      }
      files.set(
        entry.path,
        await runGitBuffer(this.#options.projectRoot, ["show", `${commit}:${entry.path}`]),
      );
    }
    return files;
  }

  #applyMergePageOverride(files: Map<string, Buffer>, override: RepositoryMergePageOverride): void {
    assertId(override.sectionId, "section ID");
    assertId(override.pageId, "page ID");
    if (!isRecord(override.page)) throw new Error("Combined page override must be an object");
    const rawPage = override.page as unknown as Record<string, unknown>;
    const manifest = validated(
      `sections/${override.sectionId}/pages/${override.pageId}/page.json`,
      validatePageManifest(rawPage.manifest),
    );
    if (manifest.id !== override.pageId) {
      throw new Error(`Combined page override has the wrong page identity: ${override.pageId}`);
    }
    const canvas = validated(
      `sections/${override.sectionId}/pages/${override.pageId}/canvas.jsonl`,
      validateCanvasRecords(rawPage.canvas),
    );
    const markdown = rawPage.markdown;
    if (!isRecord(markdown)) throw new Error("Combined page Markdown sources must be an object");
    const markdownIds = canvas
      .filter((record) => record.kind === "markdown")
      .map((record) => record.id)
      .sort();
    const suppliedIds = Object.keys(markdown).sort();
    if (
      markdownIds.length !== suppliedIds.length ||
      markdownIds.some((id, index) => suppliedIds[index] !== id)
    ) {
      throw new Error("Combined page Markdown sources must match its canvas records");
    }
    for (const id of markdownIds) {
      if (typeof markdown[id] !== "string") {
        throw new Error(`Combined Markdown source ${id} must be a string`);
      }
    }

    const pagePrefix = `sections/${override.sectionId}/pages/${override.pageId}`;
    files.set(`${pagePrefix}/page.json`, Buffer.from(serializeCanonicalJson(manifest), "utf8"));
    files.set(`${pagePrefix}/canvas.jsonl`, Buffer.from(serializeCanvasJsonLines(canvas), "utf8"));
    for (const path of files.keys()) {
      if (path.startsWith(`${pagePrefix}/markdown/`)) files.delete(path);
    }
    for (const id of markdownIds) {
      files.set(
        `${pagePrefix}/markdown/${id}.md`,
        Buffer.from(canonicalMarkdown(markdown[id] as string), "utf8"),
      );
    }
  }

  async #writeTree(files: ReadonlyMap<string, Buffer>): Promise<string> {
    const indexPath = join(
      this.#options.projectRoot,
      ".squillpad-runtime",
      `merge-index-${randomUUID()}`,
    );
    try {
      await this.#gitWithEnvironment(["read-tree", "--empty"], { GIT_INDEX_FILE: indexPath });
      for (const [path, contents] of [...files].sort(([left], [right]) =>
        left.localeCompare(right),
      )) {
        const blob = await this.#requiredGitInput(
          ["hash-object", "-w", "--stdin"],
          contents,
          "Git could not store a combined project file",
        );
        assertCommit(blob);
        await this.#requiredGitWithEnvironment(
          ["update-index", "--add", "--cacheinfo", "100644", blob, path],
          "Git could not stage a combined project file",
          { GIT_INDEX_FILE: indexPath },
        );
      }
      const tree = await this.#requiredGitWithEnvironment(
        ["write-tree"],
        "Git could not write the combined project tree",
        { GIT_INDEX_FILE: indexPath },
      );
      return tree;
    } finally {
      await rm(indexPath, { force: true });
      await rm(`${indexPath}.lock`, { force: true });
    }
  }

  async #check(): Promise<RepositorySynchronizationCheck> {
    await this.#assertConfigured();
    await this.#assertCleanGitOperation();
    await this.#assertDedicatedLocalRoot();
    const branch = await this.#configuredBranch();
    const remote = await this.#discoverRemote();
    if (remote === undefined) {
      throw new Error(
        "The configured GitHub branch no longer exists. No local files were changed; restore the branch on GitHub or reconnect the repository.",
      );
    }
    if (remote.branch !== branch) {
      throw new Error(
        `GitHub now reports ${remote.branch} as its default branch, but this project is linked to ${branch}. Reconnect deliberately before changing branches.`,
      );
    }
    await this.#fetch(branch);
    const remoteHead = await this.#fetchedHead(branch);
    await this.#loadHierarchy(remoteHead);
    const localHead = await this.#optionalGit(["rev-parse", "--verify", "HEAD"]);
    const sameTree =
      localHead !== undefined && (await this.#tree(localHead)) === (await this.#tree(remoteHead));
    const workingTree = await this.#git([
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--",
      ".",
    ]);
    const dirty = workingTree.stdout.trim().length > 0;
    const remoteUpdateAvailable =
      localHead === undefined ||
      (!sameTree && localHead !== remoteHead && !(await this.#isAncestor(remoteHead, localHead)));
    const review = remoteUpdateAvailable
      ? await this.#workingTreeReview(
          localHead,
          remoteHead,
          localHead !== undefined && (await this.#isAncestor(localHead, remoteHead)) && !dirty
            ? "remote-update"
            : "conflict",
          dirty,
        )
      : undefined;
    const reviewFields = review === undefined ? {} : { review };
    if (localHead === undefined || dirty) {
      return {
        outcome: "sync-needed",
        message:
          review?.kind === "conflict"
            ? "Local and GitHub both changed; review the synchronization conflict."
            : remoteUpdateAvailable
              ? "GitHub has a newer project snapshot ready for review."
              : "This host has local project changes ready for synchronization review.",
        remoteUpdateAvailable,
        ...reviewFields,
      };
    }
    if (sameTree) {
      return {
        outcome: "up-to-date",
        message: "Local and GitHub snapshots are up to date.",
        remoteUpdateAvailable: false,
      };
    }
    if (remoteUpdateAvailable) {
      return {
        outcome: "sync-needed",
        message: "GitHub has a newer project snapshot ready for review.",
        remoteUpdateAvailable: true,
        ...reviewFields,
      };
    }
    if (await this.#isAncestor(remoteHead, localHead)) {
      return {
        outcome: "sync-needed",
        message: "This host has a newer project snapshot ready for review.",
        remoteUpdateAvailable: false,
      };
    }
    return {
      outcome: "sync-needed",
      message: "Local and GitHub both changed; review the synchronization conflict.",
      remoteUpdateAvailable: false,
    };
  }

  async #ensureRepository(): Promise<void> {
    if (await this.#hasGitRepository()) return;
    await this.#git(["init", "--initial-branch=main"]);
  }

  async #hasGitRepository(): Promise<boolean> {
    try {
      const status = await lstat(join(this.#options.projectRoot, ".git"));
      return status.isDirectory();
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) return false;
      throw error;
    }
  }

  async #assertConfigured(): Promise<void> {
    const status = await this.status();
    if (!status.configured) {
      throw new Error("Connect a dedicated GitHub repository before synchronizing.");
    }
  }

  async #assertCleanGitOperation(): Promise<void> {
    const conflicts = await this.#git(["diff", "--name-only", "--diff-filter=U"]);
    if (conflicts.stdout.trim().length > 0) {
      throw new Error(
        `The repository already has unresolved Git conflicts: ${conflicts.stdout.trim()}. Resolve them outside SquillPad before syncing.`,
      );
    }
    for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG"]) {
      const path = await this.#optionalGit(["rev-parse", "--git-path", marker]);
      if (path === undefined) continue;
      try {
        await lstat(join(this.#options.projectRoot, path));
        throw new Error(
          `Git reports an unfinished ${marker.replaceAll("_", " ").toLowerCase()} operation. Finish or abort it outside SquillPad before syncing.`,
        );
      } catch (error) {
        if (!isFileSystemError(error, "ENOENT")) throw error;
      }
    }
  }

  async #commitCanonicalSnapshot(note?: string): Promise<string> {
    await this.#assertDedicatedLocalRoot();
    await this.#git(["add", "--all", "--", "."]);
    const head = await this.#optionalGit(["rev-parse", "--verify", "HEAD"]);
    const staged = await this.#git(["diff", "--cached", "--quiet"], [0, 1]);
    if (head === undefined || staged.code === 1) {
      await this.#assertCommitIdentity();
      await this.#git(["commit", "--message", snapshotMessage(note)]);
    }
    const commit = await this.#requiredGit(["rev-parse", "HEAD"], "Git did not create a snapshot");
    assertCommit(commit);
    await this.#loadHierarchy(commit);
    return commit;
  }

  async #workingTreeLineChanges(base: string): Promise<RepositoryLineChanges> {
    const tracked = await this.#git(["diff", "--numstat", base, "--", "."]);
    const changes = parseNumstat(tracked.stdout);
    const untracked = await this.#git([
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      ".",
    ]);
    const additions = await Promise.all(
      splitNull(untracked.stdout).map(async (path) => {
        const result = await this.#git(
          ["diff", "--no-index", "--numstat", "/dev/null", path],
          [0, 1],
        );
        return parseNumstat(result.stdout).insertions;
      }),
    );
    return {
      insertions: changes.insertions + additions.reduce((total, value) => total + value, 0),
      deletions: changes.deletions,
    };
  }

  async #commitLineChanges(from: string, to: string): Promise<RepositoryLineChanges> {
    const result = await this.#git(["diff", "--numstat", from, to, "--", "."]);
    return parseNumstat(result.stdout);
  }

  async #assertDedicatedLocalRoot(): Promise<void> {
    const unexpected = await unexpectedLocalPaths(this.#options.projectRoot);
    if (unexpected.length > 0) {
      throw new Error(
        `This feature requires a dedicated project repository. Move unrelated root entries elsewhere first: ${unexpected.join(", ")}.`,
      );
    }
  }

  async #assertCommitIdentity(): Promise<void> {
    const name = await this.#optionalGit(["config", "--get", "user.name"]);
    const email = await this.#optionalGit(["config", "--get", "user.email"]);
    if (name === undefined || email === undefined) {
      throw new Error(
        "Git cannot identify snapshot authors. Configure user.name and user.email in Git on this host, then try again.",
      );
    }
  }

  async #discoverRemote(): Promise<
    { readonly branch: string; readonly commit: string } | undefined
  > {
    const result = await this.#git(["ls-remote", "--symref", REMOTE_NAME, "HEAD"]);
    const lines = result.stdout.split("\n").filter((line) => line.length > 0);
    const symbolic = lines.find((line) => line.startsWith("ref: refs/heads/"));
    const head = lines.find((line) => /^[0-9a-f]{40}\tHEAD$/.test(line));
    if (symbolic === undefined && head === undefined) return undefined;
    if (symbolic === undefined || head === undefined) {
      throw new Error(
        "The GitHub repository has commits but no valid default branch. Set its default branch on GitHub and try again.",
      );
    }
    const branch = symbolic.slice("ref: refs/heads/".length).split("\t")[0]?.trim();
    const commit = head.split("\t")[0];
    if (branch === undefined || branch.length === 0 || commit === undefined) {
      throw new Error("GitHub returned malformed default-branch information");
    }
    assertCommit(commit);
    return { branch, commit };
  }

  async #fetch(branch: string): Promise<void> {
    await this.#git([
      "fetch",
      "--prune",
      REMOTE_NAME,
      `+refs/heads/${branch}:refs/remotes/${REMOTE_NAME}/${branch}`,
    ]);
  }

  #fetchedHead(branch: string): Promise<string> {
    return this.#requiredGit(
      ["rev-parse", `refs/remotes/${REMOTE_NAME}/${branch}`],
      "The fetched GitHub branch has no commit",
    );
  }

  async #push(commit: string, branch: string): Promise<void> {
    try {
      await this.#git(["push", "--porcelain", REMOTE_NAME, `${commit}:refs/heads/${branch}`]);
    } catch (error) {
      throw new Error(
        `GitHub rejected the push, usually because another host updated the branch. No remote history was overwritten. Sync again to review the new state. ${errorMessage(error)}`,
      );
    }
  }

  async #forcePush(commit: string, branch: string, expectedRemote: string): Promise<void> {
    assertCommit(commit);
    assertCommit(expectedRemote);
    try {
      await this.#git([
        "push",
        "--porcelain",
        `--force-with-lease=refs/heads/${branch}:${expectedRemote}`,
        REMOTE_NAME,
        `${commit}:refs/heads/${branch}`,
      ]);
    } catch (error) {
      throw new Error(
        `GitHub rejected the lease-protected replacement, usually because another host updated the branch. No remote history was overwritten. Sync again to review the new state. ${errorMessage(error)}`,
      );
    }
  }

  async #configuredBranch(): Promise<string> {
    return this.#requiredGit(
      ["config", "--get", SYNC_BRANCH_KEY],
      "The linked GitHub branch is missing; reconnect the repository",
    );
  }

  async #currentBranch(): Promise<string> {
    return this.#requiredGit(
      ["symbolic-ref", "--short", "HEAD"],
      "The local repository is detached. Check out a local branch before syncing",
    );
  }

  async #resolutionCommit(
    treeSource: string,
    parents: readonly string[],
    message: string,
  ): Promise<string> {
    const tree = await this.#tree(treeSource);
    return this.#resolutionCommitTree(tree, parents, message);
  }

  async #resolutionCommitTree(
    tree: string,
    parents: readonly string[],
    message: string,
  ): Promise<string> {
    await this.#assertCommitIdentity();
    const commit = await this.#requiredGit(
      ["commit-tree", tree, ...parents.flatMap((parent) => ["-p", parent]), "-m", message],
      "Git could not create the resolution snapshot",
    );
    assertCommit(commit);
    return commit;
  }

  async #applyCommit(commit: string, projectId: string): Promise<void> {
    await this.#git(["reset", "--hard", commit]);
    await this.#options.reloadCanonical(projectId);
  }

  async #adoptRemoteHead(commit: string): Promise<void> {
    await this.#git(["reset", "--mixed", commit]);
  }

  #tree(commit: string): Promise<string> {
    return this.#requiredGit(["rev-parse", `${commit}^{tree}`], "Git snapshot tree is missing");
  }

  async #isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    const result = await this.#git(["merge-base", "--is-ancestor", ancestor, descendant], [0, 1]);
    return result.code === 0;
  }

  async #assertReachable(commit: string): Promise<void> {
    const head = await this.#requiredGit(["rev-parse", "HEAD"], "Local Git history is missing");
    if (!(await this.#isAncestor(commit, head))) {
      throw new Error("The selected commit is not part of this project's synchronized history");
    }
  }

  async #assertPreviewReachable(commit: string): Promise<void> {
    const head = await this.#requiredGit(["rev-parse", "HEAD"], "Local Git history is missing");
    if (await this.#isAncestor(commit, head)) return;
    await this.#assertConfigured();
    const branch = await this.#configuredBranch();
    await this.#fetch(branch);
    const remoteHead = await this.#fetchedHead(branch);
    if (await this.#isAncestor(commit, remoteHead)) return;
    throw new Error("The selected commit is not part of this project's synchronized history");
  }

  async #deletedPaths(from: string, to: string): Promise<readonly string[]> {
    const result = await this.#git(["diff", "--diff-filter=D", "--name-only", "-z", from, to]);
    return splitNull(result.stdout);
  }

  async #commitSummary(
    commit: string,
    known?: { readonly timestamp: string; readonly author: string; readonly message: string },
  ): Promise<RepositoryCommitSummary> {
    assertCommit(commit);
    let metadata = known;
    if (metadata === undefined) {
      const output = await this.#requiredGit(
        ["show", "--no-patch", "--format=%cI%x1f%an%x1f%s", commit],
        "Git snapshot metadata is missing",
      );
      const [timestamp, author, message] = output.split("\u001f");
      if (timestamp === undefined || author === undefined || message === undefined) {
        throw new Error("Git returned malformed snapshot metadata");
      }
      metadata = { timestamp, author, message };
    }
    const parent = await this.#optionalGit(["rev-parse", `${commit}^`]);
    const paths = splitNull(
      parent === undefined
        ? (
            await this.#git([
              "diff-tree",
              "--root",
              "--no-commit-id",
              "--name-only",
              "-r",
              "-z",
              commit,
            ])
          ).stdout
        : (await this.#git(["diff", "--name-only", "-z", parent, commit])).stdout,
    );
    return {
      commit,
      ...metadata,
      changedPaths: paths,
      affectedPages: await this.#affectedPages(commit, paths),
    };
  }

  async #affectedPages(commit: string, paths: readonly string[]): Promise<readonly AffectedPage[]> {
    const identities = new Map<string, { readonly sectionId: string; readonly pageId: string }>();
    for (const path of paths) {
      const match = /^sections\/([^/]+)\/pages\/([^/]+)\//.exec(path);
      if (match?.[1] === undefined || match[2] === undefined) continue;
      identities.set(`${match[1]}:${match[2]}`, { sectionId: match[1], pageId: match[2] });
    }
    return Promise.all(
      [...identities.values()].map(async ({ sectionId, pageId }) => {
        let title = "Deleted page";
        try {
          title = (await this.#readPageManifest(commit, sectionId, pageId)).title;
        } catch {
          const parent = await this.#optionalGit(["rev-parse", `${commit}^`]);
          if (parent !== undefined) {
            try {
              title = (await this.#readPageManifest(parent, sectionId, pageId)).title;
            } catch {
              // The path still identifies the affected page when its old title is unavailable.
            }
          }
        }
        return { sectionId, pageId, title };
      }),
    );
  }

  async #workingTreeSummary(baseHead: string | undefined): Promise<RepositoryCommitSummary> {
    const preview = await this.#captureWorkingTreePreview(baseHead);
    return this.#commitSummary(preview.commit, {
      timestamp: preview.timestamp,
      author: "Local working tree",
      message: "Current local working tree",
    });
  }

  async #captureWorkingTreePreview(baseHead: string | undefined): Promise<{
    readonly commit: string;
    readonly timestamp: string;
  }> {
    if (baseHead !== undefined) assertCommit(baseHead);
    const files = await this.#workingTreeFiles();
    const tree = await this.#writeTree(files);
    const commitArgs = ["commit-tree", tree];
    if (baseHead !== undefined) commitArgs.push("-p", baseHead);
    commitArgs.push("-m", "SquillPad working tree preview");
    const commit = await this.#requiredGitWithEnvironment(
      commitArgs,
      "Git could not create a local working-tree preview",
      {
        GIT_AUTHOR_NAME: "SquillPad Preview",
        GIT_AUTHOR_EMAIL: "squillpad-preview@localhost",
        GIT_COMMITTER_NAME: "SquillPad Preview",
        GIT_COMMITTER_EMAIL: "squillpad-preview@localhost",
      },
    );
    assertCommit(commit);
    const hierarchy = await this.#loadHierarchy(commit);
    const timestamp = new Date().toISOString();
    this.#workingTreePreviews.set(commit, { tree, baseHead, hierarchy });
    while (this.#workingTreePreviews.size > 16) {
      const oldest = this.#workingTreePreviews.keys().next().value;
      if (oldest === undefined) break;
      this.#workingTreePreviews.delete(oldest);
    }
    return { commit, timestamp };
  }

  async #workingTreeFiles(): Promise<ReadonlyMap<string, Buffer>> {
    const output = await this.#git([
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      ".",
    ]);
    const files = new Map<string, Buffer>();
    for (const path of splitNull(output.stdout)) {
      if (!isAllowedProjectPath(path)) {
        throw new Error(`The local working tree contains an unexpected project path: ${path}`);
      }
      try {
        files.set(path, await readFile(join(this.#options.projectRoot, path)));
      } catch (error) {
        if (!isFileSystemError(error, "ENOENT")) throw error;
      }
    }
    return files;
  }

  async #workingTreeTree(): Promise<string> {
    return this.#writeTree(await this.#workingTreeFiles());
  }

  async #assertWorkingTreePreviewCurrent(
    preview: WorkingTreePreview,
    currentHead: string | undefined,
  ): Promise<void> {
    if (preview.baseHead !== currentHead) {
      throw new Error("The local snapshot changed while the conflict review was open.");
    }
    if ((await this.#workingTreeTree()) !== preview.tree) {
      throw new Error("The local working tree changed while the conflict review was open.");
    }
  }

  async #materializeReviewedLocal(expectedLocal: string): Promise<{
    readonly head: string;
    readonly preview: boolean;
  }> {
    assertCommit(expectedLocal);
    const currentHead = await this.#optionalGit(["rev-parse", "--verify", "HEAD"]);
    const localPreview = this.#workingTreePreviews.get(expectedLocal);
    if (localPreview !== undefined) {
      await this.#assertWorkingTreePreviewCurrent(localPreview, currentHead);
      const head = await this.#commitCanonicalSnapshot();
      if ((await this.#tree(head)) !== localPreview.tree) {
        throw new Error("The local working tree changed while the conflict review was open.");
      }
      return { head, preview: true };
    }
    return { head: await this.#commitCanonicalSnapshot(), preview: false };
  }

  async #loadHierarchy(commit: string): Promise<NotebookHierarchy> {
    assertCommit(commit);
    const entries = await this.#treeEntries(commit);
    const paths = new Set(entries.map((entry) => entry.path));
    for (const entry of entries) {
      if (entry.type !== "blob" || entry.mode !== "100644") {
        throw new Error(`GitHub snapshot contains an unsupported link or object: ${entry.path}`);
      }
      if (!isAllowedProjectPath(entry.path)) {
        throw new Error(
          `GitHub repository is not a dedicated SquillPad project; unexpected path: ${entry.path}`,
        );
      }
    }
    const notebook = await this.#readValidated(
      commit,
      "notebook.json",
      "notebook",
      validateNotebookManifest,
    );
    const profilePaths = [...paths].filter(isProfileSettingsPath);
    await Promise.all(
      profilePaths.map(async (path) => {
        const record = await this.#readValidated(
          commit,
          path,
          "profile settings",
          validateProfileSettingsRecord,
        );
        const expectedPath = `profiles/${record.username}.json`;
        if (path !== expectedPath) {
          throw new Error(`Profile settings identity mismatch in ${path}`);
        }
      }),
    );
    const expected = new Set(["notebook.json", ...profilePaths]);
    const pageIds = new Set<string>();
    const sections = await Promise.all(
      notebook.sectionIds.map(async (sectionId) => {
        const sectionPath = `sections/${sectionId}/section.json`;
        const manifest = await this.#readValidated(
          commit,
          sectionPath,
          "section",
          validateSectionManifest,
        );
        if (manifest.id !== sectionId)
          throw new Error(`Section identity mismatch in ${sectionPath}`);
        expected.add(sectionPath);
        const pages = await Promise.all(
          manifest.pageIds.map(async (pageId) => {
            if (pageIds.has(pageId)) throw new Error(`Page ${pageId} is referenced more than once`);
            pageIds.add(pageId);
            const page = await this.#loadPage(commit, sectionId, pageId);
            expected.add(`sections/${sectionId}/pages/${pageId}/page.json`);
            expected.add(`sections/${sectionId}/pages/${pageId}/canvas.jsonl`);
            for (const objectId of Object.keys(page.markdown)) {
              expected.add(`sections/${sectionId}/pages/${pageId}/markdown/${objectId}.md`);
            }
            return page.manifest;
          }),
        );
        return { manifest, pages };
      }),
    );
    const unreferenced = [...paths].filter(
      (path) => path.startsWith("sections/") && !path.includes("/assets/") && !expected.has(path),
    );
    if (unreferenced.length > 0) {
      throw new Error(
        `GitHub snapshot contains unreferenced project files: ${unreferenced.join(", ")}`,
      );
    }
    return { notebook, sections };
  }

  async #loadPage(commit: string, sectionId: string, pageId: string): Promise<StoredPage> {
    const manifest = await this.#readPageManifest(commit, sectionId, pageId);
    if (manifest.id !== pageId) throw new Error(`Page identity mismatch for ${pageId}`);
    const canvasPath = `sections/${sectionId}/pages/${pageId}/canvas.jsonl`;
    const source = await this.#show(commit, canvasPath);
    const parsed = parseJsonLines(source, canvasPath);
    const canvas = validated(canvasPath, validateCanvasRecords(parsed));
    const markdownEntries = await Promise.all(
      canvas
        .filter((record) => record.kind === "markdown")
        .map(
          async (record) =>
            [record.id, await this.#show(commit, recordPath(sectionId, pageId, record))] as const,
        ),
    );
    return { manifest, canvas, markdown: Object.fromEntries(markdownEntries) };
  }

  #readPageManifest(commit: string, sectionId: string, pageId: string): Promise<PageManifest> {
    const path = `sections/${sectionId}/pages/${pageId}/page.json`;
    return this.#readValidated(commit, path, "page", validatePageManifest);
  }

  async #readValidated<T>(
    commit: string,
    path: string,
    label: string,
    validator: (value: unknown) => ValidationResult<T>,
  ): Promise<T> {
    const source = await this.#show(commit, path);
    let value: unknown;
    try {
      value = JSON.parse(source) as unknown;
    } catch (error) {
      throw new Error(`${label} file ${path} contains malformed JSON: ${errorMessage(error)}`);
    }
    return validated(path, validator(value));
  }

  async #show(commit: string, path: string): Promise<string> {
    try {
      const bytes = await runGitBuffer(this.#options.projectRoot, ["show", `${commit}:${path}`]);
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new Error(
        `Git snapshot is missing or has invalid UTF-8 in ${path}: ${errorMessage(error)}`,
      );
    }
  }

  async #treeEntries(commit: string): Promise<readonly TreeEntry[]> {
    const output = (await this.#git(["ls-tree", "-r", "-z", commit])).stdout;
    return splitNull(output).map((line) => {
      const match = /^(\d+) ([^ ]+) [0-9a-f]+\t(.+)$/.exec(line);
      if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
        throw new Error("Git returned a malformed project tree");
      }
      return { mode: match[1], type: match[2], path: match[3] };
    });
  }

  async #optionalGit(args: readonly string[]): Promise<string | undefined> {
    const result = await this.#git(args, [0, 1, 2, 128]);
    if (result.code !== 0) return undefined;
    const value = result.stdout.trim();
    return value.length === 0 ? undefined : value;
  }

  async #requiredGit(args: readonly string[], failure: string): Promise<string> {
    try {
      const result = await this.#git(args);
      return result.stdout.trim();
    } catch (error) {
      throw new Error(`${failure}: ${errorMessage(error)}`);
    }
  }

  #git(args: readonly string[], allowedCodes: readonly number[] = [0]): Promise<GitResult> {
    return runGit(this.#options.projectRoot, args, allowedCodes);
  }

  #gitWithEnvironment(
    args: readonly string[],
    environment: Readonly<Record<string, string>>,
    allowedCodes: readonly number[] = [0],
  ): Promise<GitResult> {
    return runGit(this.#options.projectRoot, args, allowedCodes, environment);
  }

  async #requiredGitWithEnvironment(
    args: readonly string[],
    failure: string,
    environment: Readonly<Record<string, string>>,
  ): Promise<string> {
    try {
      const result = await this.#gitWithEnvironment(args, environment);
      return result.stdout.trim();
    } catch (error) {
      throw new Error(`${failure}: ${errorMessage(error)}`);
    }
  }

  async #requiredGitInput(
    args: readonly string[],
    input: Buffer,
    failure: string,
  ): Promise<string> {
    try {
      const result = await runGitInput(this.#options.projectRoot, args, input, [0]);
      return result.stdout.trim();
    } catch (error) {
      throw new Error(`${failure}: ${errorMessage(error)}`);
    }
  }
}

function runGit(
  projectRoot: string,
  args: readonly string[],
  allowedCodes: readonly number[],
  environment: Readonly<Record<string, string>> = {},
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      safeGitArguments(projectRoot, args),
      {
        cwd: projectRoot,
        encoding: "utf8",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...environment },
        maxBuffer: GIT_OUTPUT_LIMIT,
        timeout: 120_000,
      },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : -1;
        if (allowedCodes.includes(code)) {
          resolve({ stdout, stderr, code });
          return;
        }
        const detail = stderr.trim() || stdout.trim() || error?.message || "unknown Git error";
        reject(new Error(`Git ${args[0] ?? "command"} failed: ${detail}`));
      },
    );
  });
}

function runGitInput(
  projectRoot: string,
  args: readonly string[],
  input: Buffer,
  allowedCodes: readonly number[],
  environment: Readonly<Record<string, string>> = {},
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      safeGitArguments(projectRoot, args),
      {
        cwd: projectRoot,
        encoding: "utf8",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...environment },
        maxBuffer: GIT_OUTPUT_LIMIT,
        timeout: 120_000,
      },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : -1;
        if (allowedCodes.includes(code)) {
          resolve({ stdout, stderr, code });
          return;
        }
        const detail = stderr.trim() || stdout.trim() || error?.message || "unknown Git error";
        reject(new Error(`Git ${args[0] ?? "command"} failed: ${detail}`));
      },
    );
    child.stdin?.end(input);
  });
}

function runGitBuffer(projectRoot: string, args: readonly string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      safeGitArguments(projectRoot, args),
      {
        cwd: projectRoot,
        encoding: "buffer",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        maxBuffer: GIT_OUTPUT_LIMIT,
        timeout: 120_000,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve(stdout);
          return;
        }
        const detail = stderr.toString("utf8").trim() || error.message;
        reject(new Error(`Git ${args[0] ?? "command"} failed: ${detail}`));
      },
    );
  });
}

function safeGitArguments(projectRoot: string, args: readonly string[]): string[] {
  const disabledHooks = join(projectRoot, ".squillpad-runtime", "disabled-git-hooks");
  return ["-c", `core.hooksPath=${disabledHooks}`, ...args];
}

function validateGitHubUrl(value: string): string {
  const url = value.trim();
  if (/^git@github\.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(url)) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Paste an HTTPS or SSH GitHub repository URL, not a web page or local path.");
  }
  const secureProtocol = parsed.protocol === "https:" || parsed.protocol === "ssh:";
  const expectedUser =
    parsed.protocol !== "ssh:" || parsed.username === "" || parsed.username === "git";
  const repositoryPath = /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/.test(parsed.pathname);
  if (
    !secureProtocol ||
    parsed.hostname.toLowerCase() !== "github.com" ||
    !expectedUser ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    !repositoryPath
  ) {
    throw new Error("Use a dedicated github.com HTTPS or SSH repository URL without credentials.");
  }
  return url.replace(/\/$/, "");
}

function snapshotMessage(note: string | undefined): string {
  const suffix = note?.trim().replace(/\s+/g, " ");
  if ((suffix?.length ?? 0) > 200)
    throw new Error("Snapshot notes must be 200 characters or fewer");
  const base = `SquillPad snapshot ${new Date().toISOString()}`;
  return suffix === undefined || suffix.length === 0 ? base : `${base}\n\n${suffix}`;
}

function isAllowedProjectPath(path: string): boolean {
  if (path === ".gitignore" || path === "notebook.json") return true;
  if (isProfileSettingsPath(path)) return true;
  if (/^assets\/(?:[0-9a-f-]{36}|[0-9a-f]{64})\.[A-Za-z0-9]+$/.test(path)) return true;
  if (/^sections\/[0-9a-f-]{36}\/section\.json$/.test(path)) return true;
  return /^sections\/[0-9a-f-]{36}\/pages\/[0-9a-f-]{36}\/(?:page\.json|canvas\.jsonl|markdown\/[0-9a-f-]{36}\.md|assets\/(?:[0-9a-f-]{36}|[0-9a-f]{64})\.[A-Za-z0-9]+)$/.test(
    path,
  );
}

async function unexpectedLocalPaths(projectRoot: string): Promise<readonly string[]> {
  const unexpected: string[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (prefix.length === 0 && (entry.name === ".git" || entry.name === ".squillpad-runtime")) {
        continue;
      }
      if (entry.isSymbolicLink()) {
        unexpected.push(`${path} (symbolic link)`);
      } else if (entry.isDirectory()) {
        if (!isAllowedProjectDirectory(path)) unexpected.push(`${path}/`);
        else await visit(join(directory, entry.name), path);
      } else if (!entry.isFile() || !isAllowedProjectPath(path)) {
        unexpected.push(path);
      }
    }
  };
  await visit(projectRoot, "");
  return unexpected;
}

function isAllowedProjectDirectory(path: string): boolean {
  return (
    path === "assets" ||
    path === "profiles" ||
    path === "sections" ||
    /^sections\/[0-9a-f-]{36}$/.test(path) ||
    /^sections\/[0-9a-f-]{36}\/pages$/.test(path) ||
    /^sections\/[0-9a-f-]{36}\/pages\/[0-9a-f-]{36}$/.test(path) ||
    /^sections\/[0-9a-f-]{36}\/pages\/[0-9a-f-]{36}\/(?:markdown|assets)$/.test(path)
  );
}

function isProfileSettingsPath(path: string): boolean {
  return /^profiles\/[a-z0-9][a-z0-9._-]{2,31}\.json$/.test(path);
}

function recordPath(sectionId: string, pageId: string, record: CanvasRecord): string {
  return `sections/${sectionId}/pages/${pageId}/markdown/${record.id}.md`;
}

function parseJsonLines(source: string, path: string): readonly unknown[] {
  if (source === "") return [];
  const lines = source.endsWith("\n") ? source.slice(0, -1).split("\n") : source.split("\n");
  return lines.map((line, index) => {
    if (line.length === 0) throw new Error(`Blank JSONL record in ${path} at line ${index + 1}`);
    try {
      return JSON.parse(line) as unknown;
    } catch (error) {
      throw new Error(`Malformed JSONL in ${path} at line ${index + 1}: ${errorMessage(error)}`);
    }
  });
}

function parseNumstat(output: string): RepositoryLineChanges {
  return output.split("\n").reduce<RepositoryLineChanges>(
    (total, line) => {
      const [insertions, deletions] = line.split("\t", 2);
      if (insertions === undefined || deletions === undefined) return total;
      const inserted = Number(insertions);
      const deleted = Number(deletions);
      return {
        insertions: total.insertions + (Number.isSafeInteger(inserted) ? inserted : 0),
        deletions: total.deletions + (Number.isSafeInteger(deleted) ? deleted : 0),
      };
    },
    { insertions: 0, deletions: 0 },
  );
}

function invertLineChanges(changes: RepositoryLineChanges): RepositoryLineChanges {
  return { insertions: changes.deletions, deletions: changes.insertions };
}

function validated<T>(path: string, result: ValidationResult<T>): T {
  if (result.success) return result.data;
  const detail = result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
  throw new Error(`Invalid canonical file ${path}: ${detail}`);
}

function splitNull(value: string): readonly string[] {
  return value.split("\0").filter((entry) => entry.length > 0);
}

function assertCommit(value: string): void {
  if (!COMMIT_PATTERN.test(value)) throw new Error("Invalid Git commit identifier");
}

function assertId(value: string, label: string): void {
  if (!ID_PATTERN.test(value)) throw new Error(`Invalid ${label}`);
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalMarkdown(value: string): string {
  const withoutBom = value.startsWith("\uFEFF") ? value.slice(1) : value;
  return withoutBom.replace(/\r\n?/g, "\n");
}

function conflictPageIdentity(
  path: string,
): { readonly sectionId: string; readonly pageId: string } | undefined {
  const match = /^sections\/([^/]+)\/pages\/([^/]+)\/(?:canvas\.jsonl|markdown\/)/.exec(path);
  return match?.[1] === undefined || match[2] === undefined
    ? undefined
    : { sectionId: match[1], pageId: match[2] };
}
