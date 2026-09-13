import type { CanvasElement, NotebookHierarchy, PageManifest } from "@squillpad/core-model";

export interface RepositoryAffectedPage {
  readonly sectionId: string;
  readonly pageId: string;
  readonly title: string;
}

export interface RepositoryCommitSummary {
  readonly commit: string;
  readonly timestamp: string;
  readonly author: string;
  readonly message: string;
  readonly changedPaths: readonly string[];
  readonly affectedPages: readonly RepositoryAffectedPage[];
}

export interface RepositoryLineChanges {
  readonly insertions: number;
  readonly deletions: number;
}

export interface RepositorySnapshotReview {
  readonly kind: "remote-update" | "conflict";
  readonly local: RepositoryCommitSummary;
  readonly remote: RepositoryCommitSummary;
  readonly publishLocal?: RepositoryLineChanges;
  readonly applyRemote?: RepositoryLineChanges;
}

export interface RepositoryConflict {
  readonly local: RepositoryCommitSummary;
  readonly remote: RepositoryCommitSummary;
  readonly publishLocal?: RepositoryLineChanges;
  readonly applyRemote?: RepositoryLineChanges;
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

export interface RepositoryCheck {
  readonly outcome: "up-to-date" | "sync-needed";
  readonly message: string;
  readonly remoteUpdateAvailable: boolean;
  readonly review?: RepositorySnapshotReview;
}

export interface RepositoryPreviewPage {
  readonly manifest: PageManifest;
  readonly canvas: readonly CanvasElement[];
  readonly markdown: Readonly<Record<string, string>>;
}

export interface RepositoryMergeConflict {
  readonly kind: "canonical-file" | "canonical-field" | "canvas-record";
  readonly path: string;
  readonly message: string;
  readonly editable: boolean;
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
  readonly page: RepositoryPreviewPage;
}
